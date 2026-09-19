import { Editor, type ToolId } from './interact/editor.ts'
import { applyCalibration, applyDirection } from './interact/compass.ts'
import { cancelDraft, cancelMeasurement, finishDraft, removeLastDraftPoint } from './interact/pointer.ts'
import { selectionSummary, zoomBy, zoomToFit } from './interact/view.ts'
import { attachUnloadGuard, autosave, offerRestore, openProject, save, saveAs } from './app/fileOps.ts'
import { attachPage as attachPageOp, refit } from './app/pdfOps.ts'
import { addSheet as addSheetOp, duplicateSelectionToSheet as duplicateSelectionToSheetOp, renameSheet } from './app/sheetOps.ts'
import { isServed, Session } from './io/session.ts'
import { Store } from './model/doc.ts'
import { clear, el } from './ui/dom.ts'
import { alertDialog, askNumber, askText } from './ui/modal.ts'
import { buildPanel } from './ui/panel.ts'
import { buildToolbar } from './ui/toolbar.ts'
import type { SaveTarget } from './io/projectFile.ts'

const AUTOSAVE_MS = 30_000

export class App {
  store = new Store()
  editor: Editor
  saveTarget: SaveTarget | null = null
  /** Present only when served by `warren serve`. */
  session: Session | null = null
  /** Assets already written out this session, so a repeated save does not re-download them. */
  exportedAssets = new Set<string>()

  private toolbarHost = document.getElementById('toolbar') as HTMLElement
  private panelHost = document.getElementById('panel') as HTMLElement
  private statusText = document.getElementById('status-text') as HTMLElement
  private selectionText = document.getElementById('selection-text') as HTMLElement
  private sheetTabs = document.getElementById('sheet-tabs') as HTMLElement
  private modesHost = document.getElementById('modes') as HTMLElement
  private refreshQueued = false

  constructor(canvas: HTMLCanvasElement) {
    this.editor = new Editor(canvas, this.store)
    this.editor.onChange = () => this.refresh()
    this.editor.onStatus = (text) => {
      this.statusText.textContent = text
      this.selectionText.textContent = selectionSummary(this.editor)
    }
    this.editor.onCalibrateRequest = () => void this.promptCalibration()
    this.editor.onDirectionRequest = (bearingDeg) => void this.promptDirection(bearingDeg)
    this.store.subscribe(() => this.refresh())
  }

  async init(): Promise<void> {
    this.attachKeys()
    if (isServed()) await this.joinSession()
    else {
      attachUnloadGuard(this)
      window.setInterval(() => void autosave(this), AUTOSAVE_MS)
      await offerRestore(this)
    }
    this.refresh()
    zoomToFit(this.editor)
  }

  /**
   * Served by `warren serve`: the project lives in one place and both this window and the
   * command line work on it. There is no opening or saving to do, and no unsaved work to lose.
   */
  private async joinSession(): Promise<void> {
    const session = new Session({
      onChanged: (project) => {
        // Keep the view and the selection across a change from elsewhere, so a relabel does
        // not throw away where you were looking.
        const camera = { x: this.editor.cam.x, y: this.editor.cam.y, zoom: this.editor.cam.zoom }
        const selected = [...this.store.selection]
        const sheetId = this.store.project.activeSheetId
        this.store.loadProject(project, this.session?.name ?? null)
        if (project.sheets.some((s) => s.id === sheetId)) this.store.project.activeSheetId = sheetId
        for (const id of selected) if (this.store.item(id)) this.store.selection.add(id)
        Object.assign(this.editor.cam, camera)
        this.store.dirty = false
        this.editor.invalidateBackground()
        this.editor.requestRender()
        this.refresh()
      },
      onSelect: (ids, zoom, say) => {
        this.store.selection.clear()
        for (const id of ids) {
          const found = this.store.item(id)
          if (found) this.store.selection.add(id)
          else {
            // It may be on another sheet; follow it there rather than shrug.
            const sheet = this.store.project.sheets.find((sh) => sh.items.some((i) => i.id === id))
            if (sheet) {
              this.store.setActiveSheet(sheet.id)
              this.editor.invalidateBackground()
              this.store.selection.add(id)
            }
          }
        }
        this.store.activeVertex = null
        this.store.touch(false)
        if (zoom && this.store.selection.size) this.editor.zoomToSelection()
        this.editor.flash(say ?? `Pointing at ${this.store.selection.size} item(s)`)
        this.refresh()
      },
      onStatus: (text) => this.editor.flash(text),
    })
    this.session = session
    try {
      const { project, name } = await session.load()
      this.store.loadProject(project, name)
      this.store.dirty = false
      session.listen()
      // Continuous, because the server owns the file: saving is not a thing to remember.
      this.store.subscribe(() => {
        if (this.store.dirty) session.save(this.store.project)
      })
      this.editor.invalidateBackground()
      this.editor.flash(`Shared with warren serve — ${name}`)
    } catch (err) {
      alertDialog('Could not join the session', String(err instanceof Error ? err.message : err))
    }
  }

  // --- UI ------------------------------------------------------------------------------

  refresh(): void {
    if (this.refreshQueued) return
    this.refreshQueued = true
    queueMicrotask(() => {
      this.refreshQueued = false
      buildToolbar(this, this.toolbarHost)
      buildPanel(this, this.panelHost)
      this.renderSheetTabs()
      this.renderModes()
      this.selectionText.textContent = selectionSummary(this.editor)
      document.title = `${this.store.dirty ? '• ' : ''}${this.store.project.name} — Warren`
    })
  }

  /** The latched drawing modes, shown and clickable the way a CAD status bar shows them. */
  private renderModes(): void {
    clear(this.modesHost)
    // A filter set on the Layers tab hides things everywhere, so it has to be visible from
    // everywhere. Otherwise it looks like the drawing lost half its contents.
    const focusId = this.store.project.settings.roomFocus
    const room = focusId ? this.store.items().find((i) => i.kind === 'room' && i.id === focusId) : undefined
    if (room && room.kind === 'room') {
      this.modesHost.appendChild(chip(`focus: ${room.name} ✕`,
        'Everything outside this room is greyed. Click to show all rooms again.', () => {
          this.store.project.settings.roomFocus = null
          this.store.touch()
          this.editor.requestRender()
        }))
    }

    const filter = this.store.project.settings.labelFilter.trim()
    if (filter !== '') {
      this.modesHost.appendChild(chip(`filter: ${filter} ✕`,
        'Only items whose label contains this are shown. Click to clear.', () => {
          this.store.project.settings.labelFilter = ''
          this.store.touch()
          this.editor.requestRender()
        }))
    }
    for (const mode of this.editor.modes()) {
      this.modesHost.appendChild(el('button', {
        class: mode.on ? 'on' : '', title: mode.title, onclick: () => this.editor.toggleMode(mode.id),
      }, mode.label))
    }
  }

  private renderSheetTabs(): void {
    clear(this.sheetTabs)
    for (const sheet of this.store.project.sheets) {
      this.sheetTabs.appendChild(el('button', {
        class: sheet.id === this.store.project.activeSheetId ? 'active' : '',
        onclick: () => {
          this.store.setActiveSheet(sheet.id)
          refit(this)
        },
        ondblclick: () => void renameSheet(this, sheet),
      }, sheet.name))
    }
    this.sheetTabs.appendChild(el('button', {
      title: 'Add a sheet (another floor)', onclick: () => this.addSheet(),
    }, '+'))
  }

  // --- frozen surface: the browser smoke test and `warren serve` reach these by exact name ---

  addSheet(): void { addSheetOp(this) }
  duplicateSelectionToSheet(sheetId: string): void { duplicateSelectionToSheetOp(this, sheetId) }
  attachPage(assetId: string, page: number, target: 'current' | 'new', sourceName: string): Promise<void> {
    return attachPageOp(this, assetId, page, target, sourceName)
  }

  // --- calibration -------------------------------------------------------------------------

  private async promptCalibration(): Promise<void> {
    const mm = await askNumber({
      title: 'Calibrate this sheet',
      label: 'Real distance',
      unit: 'mm',
      min: 0.001,
      hint: 'Type the true distance between the two points you clicked. Use a dimension printed on the ' +
        'plan rather than the stated scale — PDFs are often scaled to fit paper.',
    })
    if (mm === null) {
      cancelMeasurement(this.editor)
      return
    }
    applyCalibration(this.editor, mm)
  }

  // --- direction -----------------------------------------------------------------------------

  private async promptDirection(bearingDeg: number): Promise<void> {
    const names = await askText({
      title: 'Name this direction',
      label: 'What do you call it?',
      placeholder: 'street, north, noord, straatzijde',
      hint: 'Comma-separated — as many names as people actually use for it. Reusing a name ' +
        'later redefines that direction instead of adding a duplicate. This is entirely ' +
        'optional; nothing needs one to work.',
    })
    if (names === null) {
      cancelMeasurement(this.editor)
      return
    }
    applyDirection(this.editor, bearingDeg, names)
  }

  // --- keyboard ------------------------------------------------------------------------------

  private attachKeys(): void {
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (typing) return

      if (e.ctrlKey || e.metaKey) {
        const action = MOD_KEY_ACTIONS[e.key.toLowerCase()]
        if (action) { e.preventDefault(); action(this, e) }
        return
      }
      if (e.key === ' ') {
        if (!e.repeat) this.editor.setSpaceHeld(true)
        e.preventDefault()
        return
      }
      if (e.key === 'Shift') { this.editor.setShiftHeld(true); return }

      // Single letters answer to either case, so 'v' and 'V' need only one row below.
      KEY_ACTIONS[e.key.length === 1 ? e.key.toLowerCase() : e.key]?.(this, e)
    })

    window.addEventListener('keyup', (e) => {
      if (e.key === ' ') this.editor.setSpaceHeld(false)
      if (e.key === 'Shift') this.editor.setShiftHeld(false)
    })

    window.addEventListener('blur', () => {
      this.editor.setSpaceHeld(false)
      this.editor.setShiftHeld(false)
    })
  }
}

/** A dismissible status-bar pill, for a filter or focus that is quietly changing what is shown. */
const chip = (text: string, title: string, onclick: () => void): HTMLElement =>
  el('button', { class: 'on filter-chip', title, onclick }, text)

type KeyAction = (app: App, e: KeyboardEvent) => void

const tool = (id: ToolId): KeyAction => (app) => app.editor.setTool(id)
const mode = (id: 'ortho' | 'snap' | 'grid'): KeyAction => (app, e) => { e.preventDefault(); app.editor.toggleMode(id) }
const nudge = (dx: number, dy: number): KeyAction => (app, e) => {
  e.preventDefault()
  const step = e.shiftKey ? 10 : 1
  app.editor.nudgeByPixels(dx * step, dy * step)
}

/** What happens while nothing is being typed into, one row per key. The CAD function keys and
 *  the single-letter tool shortcuts are what an architect reaches for without thinking. */
const KEY_ACTIONS: Record<string, KeyAction> = {
  F8: mode('ortho'), F3: mode('snap'), F7: mode('grid'),
  v: tool('select'), l: tool('run'), r: tool('box'), m: tool('marker'),
  n: tool('note'), d: tool('measure'), k: tool('calibrate'), b: tool('direction'),
  f: (app) => zoomToFit(app.editor),
  '+': (app) => zoomBy(app.editor, 1.25), '=': (app) => zoomBy(app.editor, 1.25),
  '-': (app) => zoomBy(app.editor, 0.8), '_': (app) => zoomBy(app.editor, 0.8),
  Escape: (app) => {
    if (app.editor.isDrafting) { cancelDraft(app.editor); return }
    cancelMeasurement(app.editor)
    app.store.selection.clear()
    app.store.activeVertex = null
    app.store.touch(false)
  },
  Enter: (app, e) => { if (app.editor.isDrafting) { e.preventDefault(); finishDraft(app.editor) } },
  Backspace: (app, e) => {
    e.preventDefault()
    if (app.editor.isDrafting) removeLastDraftPoint(app.editor)
    else app.editor.deleteSelectionOrVertex()
  },
  Delete: (app, e) => { e.preventDefault(); app.editor.deleteSelectionOrVertex() },
  ArrowUp: nudge(0, -1), ArrowDown: nudge(0, 1), ArrowLeft: nudge(-1, 0), ArrowRight: nudge(1, 0),
}

/** Same idea, for the Ctrl/Cmd-modified shortcuts. */
const MOD_KEY_ACTIONS: Record<string, KeyAction> = {
  z: (app, e) => { if (e.shiftKey) app.store.redo(); else app.store.undo() },
  y: (app) => app.store.redo(),
  s: (app, e) => void (e.shiftKey ? saveAs(app) : save(app)),
  o: (app) => void openProject(app),
  a: (app) => {
    app.store.selection.clear()
    for (const item of app.store.items()) if (app.store.isEditable(item)) app.store.selection.add(item.id)
    app.store.touch(false)
  },
}
