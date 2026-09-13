import { defaultSystems, FALLBACK_SYSTEM } from './systems.ts'
import { newId } from './ids.ts'
import { ARCHITECTURE_KINDS, DEFAULT_SETTINGS, searchTextOf, type Item, type Project, type Sheet, type System } from './types.ts'

/** Everything under undo control. Assets (PDF bytes) sit outside - they are big and never edited. */
interface Snapshot {
  name: string
  systems: System[]
  sheets: Sheet[]
  settings: Project['settings']
  activeSheetId: string
}

export function emptySheet(name = 'Sheet 1'): Sheet {
  return { id: newId('sh'), name, pdf: null, mmPerPoint: null, items: [] }
}

export function emptyProject(): Project {
  const sheet = emptySheet('Ground floor')
  return {
    version: 1,
    name: 'Untitled',
    systems: defaultSystems(),
    sheets: [sheet],
    assets: {},
    settings: { ...DEFAULT_SETTINGS },
    activeSheetId: sheet.id,
  }
}

export interface VertexRef { itemId: string; index: number }

type Listener = () => void

export class Store {
  project: Project = emptyProject()
  selection = new Set<string>()
  activeVertex: VertexRef | null = null
  dirty = false
  fileName: string | null = null

  private undoStack: Snapshot[] = []
  private redoStack: Snapshot[] = []
  private pending: Snapshot | null = null
  private listeners = new Set<Listener>()
  private systemCache = new Map<string, System>()
  private systemCacheKey: System[] | null = null

  // --- events -----------------------------------------------------------------------
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  emit(): void {
    for (const fn of this.listeners) fn()
  }

  // --- sheets -----------------------------------------------------------------------
  get sheet(): Sheet {
    const found = this.project.sheets.find((s) => s.id === this.project.activeSheetId)
    if (found) return found
    const first = this.project.sheets[0] ?? emptySheet()
    this.project.activeSheetId = first.id
    if (this.project.sheets.length === 0) this.project.sheets.push(first)
    return first
  }

  setActiveSheet(id: string): void {
    if (this.project.activeSheetId === id) return
    this.project.activeSheetId = id
    this.selection.clear()
    this.activeVertex = null
    this.emit()
  }

  // --- systems ----------------------------------------------------------------------
  system(id: string): System {
    if (this.systemCacheKey !== this.project.systems) {
      this.systemCache = new Map(this.project.systems.map((s) => [s.id, s]))
      this.systemCacheKey = this.project.systems
    }
    return this.systemCache.get(id) ?? FALLBACK_SYSTEM
  }

  invalidateSystems(): void {
    this.systemCacheKey = null
  }

  /**
   * Visible means: system visible, passes the level filter, and - for notes - the global note
   * toggle is on. Visibility gates hit-testing too, so anything you cannot see is also
   * something you cannot accidentally drag.
   */
  isVisible(item: Item): boolean {
    const sys = this.system(item.systemId)
    if (!sys.visible) return false
    if (item.kind === 'note' && !this.project.settings.showNotes) return false
    // Rooms and doors are the context you read everything else against, so filtering services
    // by level must not take the building away with them.
    if (ARCHITECTURE_KINDS.includes(item.kind)) return true
    const filter = this.project.settings.levelFilter
    if (filter !== 'all' && item.level !== filter) return false
    const text = this.project.settings.labelFilter.trim().toLowerCase()
    if (text !== '' && !searchTextOf(item).includes(text)) return false
    return true
  }

  isEditable(item: Item): boolean {
    if (item.locked) return false
    if (this.system(item.systemId).locked) return false
    return this.isVisible(item)
  }

  items(): Item[] {
    return this.sheet.items
  }

  item(id: string): Item | undefined {
    return this.sheet.items.find((i) => i.id === id)
  }

  selectedItems(): Item[] {
    return this.sheet.items.filter((i) => this.selection.has(i.id))
  }

  // --- undo -------------------------------------------------------------------------
  private snapshot(): Snapshot {
    return structuredClone({
      name: this.project.name,
      systems: this.project.systems,
      sheets: this.project.sheets,
      settings: this.project.settings,
      activeSheetId: this.project.activeSheetId,
    })
  }

  private restore(snap: Snapshot): void {
    this.project.name = snap.name
    this.project.systems = snap.systems
    this.project.sheets = snap.sheets
    this.project.settings = snap.settings
    this.project.activeSheetId = snap.activeSheetId
    this.invalidateSystems()
    for (const id of [...this.selection]) if (!this.item(id)) this.selection.delete(id)
    this.activeVertex = null
  }

  begin(): void {
    if (this.pending) return
    this.pending = this.snapshot()
  }

  /** Commit the open transaction. Emits regardless so live drags repaint. */
  commit(): void {
    if (!this.pending) return
    this.undoStack.push(this.pending)
    if (this.undoStack.length > 100) this.undoStack.shift()
    this.redoStack.length = 0
    this.pending = null
    this.dirty = true
    this.emit()
  }

  cancel(): void {
    if (!this.pending) return
    this.restore(this.pending)
    this.pending = null
    this.emit()
  }

  mutate(fn: () => void): void {
    this.begin()
    fn()
    this.commit()
  }

  /** Change that should not be undoable (view settings, visibility toggles). */
  touch(markDirty = true): void {
    if (markDirty) this.dirty = true
    this.emit()
  }

  canUndo(): boolean { return this.undoStack.length > 0 }
  canRedo(): boolean { return this.redoStack.length > 0 }

  undo(): void {
    const snap = this.undoStack.pop()
    if (!snap) return
    this.redoStack.push(this.snapshot())
    this.restore(snap)
    this.dirty = true
    this.emit()
  }

  redo(): void {
    const snap = this.redoStack.pop()
    if (!snap) return
    this.undoStack.push(this.snapshot())
    this.restore(snap)
    this.dirty = true
    this.emit()
  }

  resetHistory(): void {
    this.undoStack.length = 0
    this.redoStack.length = 0
    this.pending = null
  }

  loadProject(project: Project, fileName: string | null): void {
    this.project = project
    this.fileName = fileName
    this.selection.clear()
    this.activeVertex = null
    this.invalidateSystems()
    this.resetHistory()
    this.dirty = false
    this.emit()
  }

  // --- item helpers -----------------------------------------------------------------
  addItem(item: Item): void {
    this.mutate(() => {
      this.sheet.items.push(item)
      this.selection.clear()
      this.selection.add(item.id)
    })
  }

  deleteSelection(): void {
    const doomed = new Set([...this.selection].filter((id) => {
      const it = this.item(id)
      return it ? this.isEditable(it) : false
    }))
    if (doomed.size === 0) return
    this.mutate(() => {
      this.sheet.items = this.sheet.items.filter((i) => !doomed.has(i.id))
      this.selection.clear()
      this.activeVertex = null
    })
  }
}
