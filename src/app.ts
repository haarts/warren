import { Editor } from './interact/controller.ts'
import { clearAutosave, readAutosave, writeAutosave } from './io/autosave.ts'
import { base64ToBytes, bytesToBase64, sha256Hex } from './io/base64.ts'
import { cacheAsset, hydrateAssets } from './io/assetCache.ts'
import { isServed, Session } from './io/session.ts'
import { downloadBlob } from './io/exportImage.ts'
import { assetData, describeAsset } from './model/assets.ts'
import { forgetDocument, pageSizePt } from './io/pdf.ts'
import {
  parseProject, pickOpenFile, pickSaveTarget, projectNameFromFileName, promptForFile,
  serialize, suggestedFileName, writeTo, type SaveTarget,
} from './io/projectFile.ts'
import { emptyProject, emptySheet, Store } from './model/doc.ts'
import { newId } from './model/ids.ts'
import type { Project, Sheet } from './model/types.ts'
import { alertDialog, askNumber, askText, confirmDialog } from './ui/modal.ts'
import { openPdfImportDialog } from './ui/pdfImport.ts'
import { buildPanel } from './ui/panel.ts'
import { buildToolbar } from './ui/toolbar.ts'

const AUTOSAVE_MS = 30_000

export class App {
  store = new Store()
  editor: Editor
  saveTarget: SaveTarget | null = null
  /** Present only when served by `warren serve`. */
  session: Session | null = null

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
      this.selectionText.textContent = this.editor.selectionSummary()
    }
    this.editor.onCalibrateRequest = () => void this.promptCalibration()
    this.editor.onDirectionRequest = (bearingDeg) => void this.promptDirection(bearingDeg)
    this.store.subscribe(() => this.refresh())
  }

  async init(): Promise<void> {
    this.attachKeys()
    if (isServed()) await this.joinSession()
    else {
      this.attachUnloadGuard()
      window.setInterval(() => void this.autosave(), AUTOSAVE_MS)
      await this.offerRestore()
    }
    this.refresh()
    this.editor.zoomToFit()
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
      this.selectionText.textContent = this.editor.selectionSummary()
      document.title = `${this.store.dirty ? '• ' : ''}${this.store.project.name} — Warren`
    })
  }

  /** The latched drawing modes, shown and clickable the way a CAD status bar shows them. */
  private renderModes(): void {
    this.modesHost.replaceChildren()
    // A filter set on the Layers tab hides things everywhere, so it has to be visible from
    // everywhere. Otherwise it looks like the drawing lost half its contents.
    const focusId = this.store.project.settings.roomFocus
    if (focusId) {
      const room = this.store.items().find((i) => i.kind === 'room' && i.id === focusId)
      if (room && room.kind === 'room') {
        const chip = document.createElement('button')
        chip.className = 'on filter-chip'
        chip.textContent = `focus: ${room.name} ✕`
        chip.title = 'Everything outside this room is greyed. Click to show all rooms again.'
        chip.addEventListener('click', () => {
          this.store.project.settings.roomFocus = null
          this.store.touch()
          this.editor.requestRender()
        })
        this.modesHost.appendChild(chip)
      }
    }

    const filter = this.store.project.settings.labelFilter.trim()
    if (filter !== '') {
      const chip = document.createElement('button')
      chip.className = 'on filter-chip'
      chip.textContent = `filter: ${filter} ✕`
      chip.title = 'Only items whose label contains this are shown. Click to clear.'
      chip.addEventListener('click', () => {
        this.store.project.settings.labelFilter = ''
        this.store.touch()
        this.editor.requestRender()
      })
      this.modesHost.appendChild(chip)
    }
    for (const mode of this.editor.modes()) {
      const btn = document.createElement('button')
      btn.textContent = mode.label
      btn.className = mode.on ? 'on' : ''
      btn.title = mode.title
      btn.addEventListener('click', () => this.editor.toggleMode(mode.id))
      this.modesHost.appendChild(btn)
    }
  }

  private renderSheetTabs(): void {
    this.sheetTabs.replaceChildren()
    for (const sheet of this.store.project.sheets) {
      const btn = document.createElement('button')
      btn.textContent = sheet.name
      if (sheet.id === this.store.project.activeSheetId) btn.className = 'active'
      btn.addEventListener('click', () => {
        this.store.setActiveSheet(sheet.id)
        this.editor.invalidateBackground()
        this.editor.zoomToFit()
      })
      btn.addEventListener('dblclick', () => void this.renameSheet(sheet))
      this.sheetTabs.appendChild(btn)
    }
    const add = document.createElement('button')
    add.textContent = '+'
    add.title = 'Add a sheet (another floor)'
    add.addEventListener('click', () => this.addSheet())
    this.sheetTabs.appendChild(add)
  }

  // --- project lifecycle ---------------------------------------------------------------

  async newProject(): Promise<void> {
    if (this.store.dirty && !(await confirmDialog('Discard changes?', 'The current project has unsaved changes.', 'Discard'))) return
    this.store.loadProject(emptyProject(), null)
    this.saveTarget = null
    await clearAutosave()
    this.editor.invalidateBackground()
    this.editor.zoomToFit()
  }

  async openProject(): Promise<void> {
    if (this.store.dirty && !(await confirmDialog('Discard changes?', 'The current project has unsaved changes.', 'Discard'))) return
    try {
      const picked = await pickOpenFile()
      if (!picked) return
      const text = await picked.file.text()
      const project = parseProject(text)
      const missing = await hydrateAssets(project)
      this.store.loadProject(project, picked.file.name)
      // A bundled file carries its own bytes, so they are now cached and the next save is small.
      for (const id of Object.keys(project.assets)) {
        if (project.assets[id].data) this.exportedAssets.add(id)
      }
      if (missing.length) void this.locateMissingAssets(project, missing)
      this.saveTarget = picked.handle ? { handle: picked.handle, name: picked.file.name } : null
      await clearAutosave()
      this.editor.invalidateBackground()
      this.editor.zoomToFit()
    } catch (err) {
      alertDialog('Could not open that file', String(err instanceof Error ? err.message : err))
    }
  }

  async save(): Promise<void> {
    if (this.session) {
      await this.session.flush(this.store.project)
      this.store.dirty = false
      this.editor.flash('Saved')
      return
    }
    if (!this.saveTarget) return this.saveAs()
    await this.writeProject(this.saveTarget)
  }

  async saveAs(): Promise<void> {
    const target = await pickSaveTarget(suggestedFileName(this.store.project.name))
    if (!target) return
    this.saveTarget = target
    // "Save as" is how most people expect to name an untitled document, so adopt the file
    // name - but never overwrite a title the user has deliberately set.
    if (this.store.project.name === 'Untitled') {
      const derived = projectNameFromFileName(target.name)
      if (derived !== 'Untitled') this.store.mutate(() => { this.store.project.name = derived })
    }
    await this.writeProject(target)
  }

  renameProject(name: string): void {
    const clean = name.trim()
    if (!clean || clean === this.store.project.name) {
      this.refresh()
      return
    }
    this.store.mutate(() => { this.store.project.name = clean })
  }

  /**
   * Writes the project without the PDF inside it. The plan is 99.8% of a bundled file's bytes
   * and none of its meaning, so keeping it out is what makes the file diffable, greppable and
   * readable by anything that is not this app.
   */
  private async writeProject(target: SaveTarget): Promise<void> {
    try {
      await writeTo(target, serialize(this.store.project))
      await this.ensurePlanPdfOnDisk()
      this.store.dirty = false
      this.store.fileName = target.name
      await clearAutosave()
      this.editor.flash(target.handle
        ? `Saved ${target.name}`
        : `Downloaded ${target.name} — this browser cannot write over an existing file`)
      this.refresh()
    } catch (err) {
      alertDialog('Save failed', String(err instanceof Error ? err.message : err))
    }
  }

  /** Assets already written out this session, so a repeated save does not re-download them. */
  private exportedAssets = new Set<string>()

  /**
   * The project file now points at the PDF instead of containing it, so the PDF has to exist
   * beside it. Written once per asset per session rather than on every save.
   */
  private async ensurePlanPdfOnDisk(): Promise<void> {
    for (const id of Object.keys(this.store.project.assets)) {
      if (this.exportedAssets.has(id)) continue
      if (!this.store.project.sheets.some((s) => s.pdf?.assetId === id)) continue
      if (this.exportPlanPdf(id)) this.exportedAssets.add(id)
    }
  }

  /** Writes one plan PDF out. Returns false when its bytes are not available. */
  exportPlanPdf(assetId?: string): boolean {
    const id = assetId ?? this.store.sheet.pdf?.assetId
    if (!id) return false
    const data = assetData(id)
    if (!data) return false
    const ref = this.store.project.assets[id]
    const bytes = base64ToBytes(data)
    const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: 'application/pdf' })
    downloadBlob(ref?.name || `${id.slice(0, 12)}.pdf`, blob)
    this.exportedAssets.add(id)
    return true
  }

  /** One self-contained file, PDF included - for mailing or archiving, not for everyday saving. */
  async exportBundle(): Promise<void> {
    const name = suggestedFileName(this.store.project.name).replace(/\.json$/, '.bundle.json')
    const target = await pickSaveTarget(name)
    if (!target) return
    try {
      await writeTo(target, serialize(this.store.project, { bundle: true }))
      this.editor.flash(`Wrote ${target.name} with the plan PDF inside it`)
    } catch (err) {
      alertDialog('Export failed', String(err instanceof Error ? err.message : err))
    }
  }

  private async autosave(): Promise<void> {
    if (!this.store.dirty) return
    try {
      await writeAutosave(this.store.project, this.store.fileName)
    } catch (err) {
      console.warn('autosave failed', err)
    }
  }

  private async offerRestore(): Promise<void> {
    let found: Awaited<ReturnType<typeof readAutosave>> = null
    try {
      found = await readAutosave()
    } catch {
      return
    }
    if (!found) return
    const when = new Date(found.savedAt).toLocaleString()
    const restore = await confirmDialog(
      'Restore unsaved work?',
      `A recovery copy from ${when} was found${found.fileName ? ` (${found.fileName})` : ''}. ` +
      'This is the crash net, not your saved file — restore it, then save to disk straight away.',
      'Restore',
    )
    if (restore) {
      await hydrateAssets(found.project)
      this.store.loadProject(found.project, found.fileName)
      this.store.dirty = true
      this.editor.invalidateBackground()
    } else {
      await clearAutosave()
    }
  }

  private attachUnloadGuard(): void {
    window.addEventListener('beforeunload', (e) => {
      if (!this.store.dirty) return
      e.preventDefault()
      e.returnValue = ''
    })
  }

  // --- PDF -------------------------------------------------------------------------------

  async importPdf(target: 'current' | 'new'): Promise<void> {
    const file = await promptForFile('application/pdf,.pdf')
    if (!file) return
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const assetId = await sha256Hex(bytes)
      await cacheAsset(assetId, bytesToBase64(bytes))
      this.store.project.assets[assetId] = { name: file.name, bytes: bytes.length }
      await openPdfImportDialog(this, assetId, file.name, target)
    } catch (err) {
      alertDialog('Could not read that PDF', String(err instanceof Error ? err.message : err))
    }
  }

  async attachPage(assetId: string, page: number, target: 'current' | 'new', sourceName: string): Promise<void> {
    const base64 = assetData(assetId)
    if (!base64) return
    const size = await pageSizePt(assetId, base64, page, 0)
    this.store.mutate(() => {
      let sheet: Sheet
      if (target === 'new') {
        sheet = emptySheet(`${sourceName.replace(/\.pdf$/i, '')} p${page}`)
        this.store.project.sheets.push(sheet)
        this.store.project.activeSheetId = sheet.id
      } else {
        sheet = this.store.sheet
        if (sheet.name === 'Ground floor' && sheet.items.length === 0) sheet.name = `${sourceName.replace(/\.pdf$/i, '')} p${page}`
      }
      sheet.pdf = { assetId, page, rotation: 0, widthPt: size.widthPt, heightPt: size.heightPt }
    })
    this.store.selection.clear()
    this.editor.invalidateBackground()
    this.editor.zoomToFit()
  }

  /**
   * The project points at a plan this browser has never seen. Ask for it by name and check the
   * hash, so there is no way to attach the wrong file by accident.
   */
  private async locateMissingAssets(project: Project, missing: string[]): Promise<void> {
    const names = missing.map((id) => describeAsset(project.assets, id)).join(', ')
    const ok = await confirmDialog(
      'The plan PDF is stored separately',
      `This project refers to ${names}, which this browser does not have a copy of. ` +
      'Locate it now? The drawing opens either way — only the plan underneath is missing.',
      'Locate…',
    )
    if (!ok) return
    const file = await promptForFile('application/pdf,.pdf')
    if (!file) return
    const bytes = new Uint8Array(await file.arrayBuffer())
    const id = await sha256Hex(bytes)
    if (!missing.includes(id)) {
      alertDialog('That is a different PDF', `"${file.name}" does not match the plan this project was drawn on.`)
      return
    }
    await cacheAsset(id, bytesToBase64(bytes))
    this.exportedAssets.add(id)
    this.editor.invalidateBackground()
    this.editor.zoomToFit()
    this.editor.flash(`Found ${file.name}`)
  }

  rotateSheet(delta: 90 | -90): void {
    const sheet = this.store.sheet
    if (!sheet.pdf) return
    const base64 = assetData(sheet.pdf.assetId)
    if (!base64) return
    const next = ((sheet.pdf.rotation + delta + 360) % 360) as 0 | 90 | 180 | 270
    void pageSizePt(sheet.pdf.assetId, base64, sheet.pdf.page, next).then((size) => {
      this.store.mutate(() => {
        const s = this.store.sheet
        if (!s.pdf) return
        s.pdf.rotation = next
        s.pdf.widthPt = size.widthPt
        s.pdf.heightPt = size.heightPt
      })
      this.editor.invalidateBackground()
      this.editor.zoomToFit()
    })
  }

  detachPdf(): void {
    const sheet = this.store.sheet
    if (!sheet.pdf) return
    const assetId = sheet.pdf.assetId
    this.store.mutate(() => { this.store.sheet.pdf = null })
    forgetDocument(assetId)
    this.editor.invalidateBackground()
  }

  // --- sheets -----------------------------------------------------------------------------

  addSheet(): void {
    this.store.mutate(() => {
      const sheet = emptySheet(`Sheet ${this.store.project.sheets.length + 1}`)
      this.store.project.sheets.push(sheet)
      this.store.project.activeSheetId = sheet.id
    })
    this.editor.invalidateBackground()
  }

  async renameSheet(sheet: Sheet): Promise<void> {
    const name = window.prompt('Sheet name', sheet.name)
    if (name === null) return
    this.store.mutate(() => {
      const live = this.store.project.sheets.find((s) => s.id === sheet.id)
      if (live) live.name = name.trim() || live.name
    })
  }

  async deleteSheet(sheet: Sheet): Promise<void> {
    if (this.store.project.sheets.length <= 1) {
      alertDialog('Cannot delete', 'A project needs at least one sheet.')
      return
    }
    const ok = await confirmDialog('Delete sheet?', `"${sheet.name}" and its ${sheet.items.length} items will be removed.`, 'Delete')
    if (!ok) return
    this.store.mutate(() => {
      this.store.project.sheets = this.store.project.sheets.filter((s) => s.id !== sheet.id)
      if (this.store.project.activeSheetId === sheet.id) {
        this.store.project.activeSheetId = this.store.project.sheets[0].id
      }
    })
    this.editor.invalidateBackground()
    this.editor.zoomToFit()
  }

  duplicateSelectionToSheet(sheetId: string): void {
    const items = this.store.selectedItems()
    if (items.length === 0) return
    const target = this.store.project.sheets.find((s) => s.id === sheetId)
    if (!target) return
    this.store.mutate(() => {
      for (const item of items) {
        const copy = structuredClone(item)
        copy.id = newId(item.kind)
        target.items.push(copy)
      }
    })
    this.editor.flash(`Copied ${items.length} item(s) to ${target.name} at the same position`)
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
      this.editor.cancelCalibration()
      return
    }
    this.editor.applyCalibration(mm)
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
      this.editor.cancelDirection()
      return
    }
    this.editor.applyDirection(bearingDeg, names)
  }

  // --- keyboard ------------------------------------------------------------------------------

  private attachKeys(): void {
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (typing) return

      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) this.store.redo()
        else this.store.undo()
        return
      }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); this.store.redo(); return }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void (e.shiftKey ? this.saveAs() : this.save()); return }
      if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); void this.openProject(); return }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        this.store.selection.clear()
        for (const item of this.store.items()) if (this.store.isEditable(item)) this.store.selection.add(item.id)
        this.store.touch(false)
        return
      }
      if (mod) return

      switch (e.key) {
        // The CAD function keys. An architect reaches for these without thinking.
        case 'F8': e.preventDefault(); this.editor.toggleMode('ortho'); return
        case 'F3': e.preventDefault(); this.editor.toggleMode('snap'); return
        case 'F7': e.preventDefault(); this.editor.toggleMode('grid'); return
        case ' ':
          if (!e.repeat) this.editor.setSpaceHeld(true)
          e.preventDefault()
          return
        case 'Shift':
          this.editor.setShiftHeld(true)
          return
        case 'v': case 'V': this.editor.setTool('select'); return
        case 'l': case 'L': this.editor.setTool('run'); return
        case 'r': case 'R': this.editor.setTool('box'); return
        case 'm': case 'M': this.editor.setTool('marker'); return
        case 'n': case 'N': this.editor.setTool('note'); return
        case 'd': case 'D': this.editor.setTool('measure'); return
        case 'k': case 'K': this.editor.setTool('calibrate'); return
        case 'b': case 'B': this.editor.setTool('direction'); return
        case 'Escape':
          if (this.editor.isDrafting) this.editor.cancelDraft()
          else {
            this.editor.cancelCalibration()
            this.editor.cancelDirection()
            this.store.selection.clear()
            this.store.activeVertex = null
            this.store.touch(false)
          }
          return
        case 'Enter':
          if (this.editor.isDrafting) { e.preventDefault(); this.editor.finishDraft() }
          return
        case 'Backspace':
          if (this.editor.isDrafting) { e.preventDefault(); this.editor.removeLastDraftPoint(); return }
          e.preventDefault()
          this.editor.deleteSelectionOrVertex()
          return
        case 'Delete':
          e.preventDefault()
          this.editor.deleteSelectionOrVertex()
          return
        case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight': {
          e.preventDefault()
          const step = e.shiftKey ? 10 : 1
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
          this.editor.nudgeByPixels(dx, dy)
          return
        }
        case 'f': case 'F': this.editor.zoomToFit(); return
        case '+': case '=': this.editor.zoomBy(1.25); return
        case '-': case '_': this.editor.zoomBy(0.8); return
        default:
          return
      }
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
