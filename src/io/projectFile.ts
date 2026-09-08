import { emptyProject } from '../model/doc.ts'
import { NOTE_DEFAULT_WIDTH, NOTE_MIN_WIDTH } from '../render/notes.ts'
import { defaultSystems } from '../model/systems.ts'
import {
  CATEGORIES, DEFAULT_SETTINGS, LEVELS, MARKER_SYMBOLS,
  type Item, type Level, type MarkerSymbol, type Project, type RunItem, type Sheet, type System,
} from '../model/types.ts'

export const FILE_EXTENSION = '.ductwork.json'

/** Drop assets no sheet references, so the file does not grow forever. */
function gcAssets(project: Project): Record<string, string> {
  const used = new Set(project.sheets.map((s) => s.pdf?.assetId).filter(Boolean) as string[])
  const out: Record<string, string> = {}
  for (const [id, data] of Object.entries(project.assets)) if (used.has(id)) out[id] = data
  return out
}

export function serialize(project: Project): string {
  const clean: Project = { ...project, assets: gcAssets(project) }
  return JSON.stringify(clean, null, 2)
}

// --- validation ---------------------------------------------------------------------
// Hand-rolled and forgiving on purpose: a file you wrote 18 months ago should still open
// even if the app has moved on. Unknown fields survive; broken ones fall back to defaults.

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && isFinite(v) ? v : fallback)
const bool = (v: unknown, fallback = false): boolean => (typeof v === 'boolean' ? v : fallback)

function asLevel(v: unknown): Level {
  return LEVELS.includes(v as Level) ? (v as Level) : 'wall'
}

function asItem(raw: unknown, index: number): Item | null {
  if (!isObj(raw)) return null
  // Optional fields are only written when they carry a value: the project file is meant to be
  // diffed in git, and a wall of `"locked": false` makes real changes hard to spot.
  const base = {
    id: str(raw.id) || `it_recovered_${index}`,
    systemId: str(raw.systemId, 'water.cold'),
    level: asLevel(raw.level),
  }
  const shared: { colorOverride?: string; locked?: true } = {}
  if (typeof raw.colorOverride === 'string') shared.colorOverride = raw.colorOverride
  if (raw.locked === true) shared.locked = true

  const labelled: { label?: string; note?: string } = {}
  if (typeof raw.label === 'string') labelled.label = raw.label
  if (typeof raw.note === 'string') labelled.note = raw.note

  const common = { ...base, ...shared, ...labelled }

  if (raw.kind === 'run') {
    const pts = Array.isArray(raw.points)
      ? raw.points.filter(isObj).map((p) => ({ x: num(p.x), y: num(p.y) }))
      : []
    if (pts.length === 0) return null
    const run: RunItem = {
      ...common,
      kind: 'run',
      points: pts,
      flow: raw.flow === 'forward' || raw.flow === 'reverse' ? raw.flow : 'none',
    }
    if (typeof raw.size === 'string') run.size = raw.size
    if (typeof raw.slope === 'string') run.slope = raw.slope
    if (typeof raw.extraM === 'number' && isFinite(raw.extraM)) run.extraM = raw.extraM
    return run
  }
  if (raw.kind === 'box') {
    return { ...common, kind: 'box', x: num(raw.x), y: num(raw.y), w: num(raw.w, 20), h: num(raw.h, 20) }
  }
  if (raw.kind === 'marker') {
    const symbol = MARKER_SYMBOLS.includes(raw.symbol as MarkerSymbol) ? (raw.symbol as MarkerSymbol) : 'note'
    return { ...common, kind: 'marker', x: num(raw.x), y: num(raw.y), symbol }
  }
  if (raw.kind === 'note') {
    // Notes carry `text`, not `label`/`note` - a sticky whose content lived in a side field
    // would be a trap.
    return {
      ...base,
      ...shared,
      kind: 'note',
      x: num(raw.x),
      y: num(raw.y),
      w: Math.max(NOTE_MIN_WIDTH, num(raw.w, NOTE_DEFAULT_WIDTH)),
      text: str(raw.text),
    }
  }
  return null
}

function asSystem(raw: unknown, index: number): System | null {
  if (!isObj(raw)) return null
  const id = str(raw.id)
  if (!id) return null
  const category = CATEGORIES.includes(raw.category as System['category']) ? (raw.category as System['category']) : 'struct'
  const system: System = {
    id,
    category,
    name: str(raw.name, `System ${index + 1}`),
    color: str(raw.color, '#475569'),
    dash: Array.isArray(raw.dash) ? raw.dash.filter((d): d is number => typeof d === 'number') : [],
    width: num(raw.width, 1.6),
    visible: bool(raw.visible, true),
    locked: bool(raw.locked, false),
  }
  if (typeof raw.defaultSize === 'string') system.defaultSize = raw.defaultSize
  if (typeof raw.tag === 'string') system.tag = raw.tag
  return system
}

function asSheet(raw: unknown, index: number): Sheet {
  const fallbackId = `sh_recovered_${index}`
  if (!isObj(raw)) return { id: fallbackId, name: `Sheet ${index + 1}`, pdf: null, mmPerPoint: null, items: [] }
  let pdf: Sheet['pdf'] = null
  if (isObj(raw.pdf) && typeof raw.pdf.assetId === 'string') {
    const rot = num(raw.pdf.rotation, 0)
    pdf = {
      assetId: raw.pdf.assetId,
      page: Math.max(1, Math.round(num(raw.pdf.page, 1))),
      rotation: ([0, 90, 180, 270].includes(rot) ? rot : 0) as 0 | 90 | 180 | 270,
      widthPt: num(raw.pdf.widthPt, 595),
      heightPt: num(raw.pdf.heightPt, 842),
    }
  }
  return {
    id: str(raw.id, fallbackId),
    name: str(raw.name, `Sheet ${index + 1}`),
    pdf,
    mmPerPoint: typeof raw.mmPerPoint === 'number' && raw.mmPerPoint > 0 ? raw.mmPerPoint : null,
    items: Array.isArray(raw.items) ? (raw.items.map(asItem).filter(Boolean) as Item[]) : [],
  }
}

export function parseProject(text: string): Project {
  const raw: unknown = JSON.parse(text)
  if (!isObj(raw)) throw new Error('Not a Ductwork project file')
  const base = emptyProject()

  const systems = Array.isArray(raw.systems)
    ? (raw.systems.map(asSystem).filter(Boolean) as System[])
    : defaultSystems()

  const sheets = Array.isArray(raw.sheets) && raw.sheets.length > 0
    ? raw.sheets.map(asSheet)
    : base.sheets

  const assets: Record<string, string> = {}
  if (isObj(raw.assets)) {
    for (const [k, v] of Object.entries(raw.assets)) if (typeof v === 'string') assets[k] = v
  }

  const settingsRaw = isObj(raw.settings) ? raw.settings : {}
  const settings = { ...DEFAULT_SETTINGS }
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof typeof DEFAULT_SETTINGS)[]) {
    const v = settingsRaw[key]
    if (typeof v === typeof DEFAULT_SETTINGS[key]) (settings as Record<string, unknown>)[key] = v
  }
  if (settings.levelFilter !== 'all' && !LEVELS.includes(settings.levelFilter)) settings.levelFilter = 'all'

  const activeSheetId = sheets.some((s) => s.id === raw.activeSheetId) ? String(raw.activeSheetId) : sheets[0].id

  return {
    version: 1,
    name: str(raw.name, 'Untitled'),
    systems: systems.length > 0 ? systems : defaultSystems(),
    sheets,
    assets,
    settings,
    activeSheetId,
  }
}

// --- disk ---------------------------------------------------------------------------

const FILE_TYPES: FilePickerAcceptType[] = [
  { description: 'Ductwork project', accept: { 'application/json': ['.json'] } },
]

export interface SaveTarget {
  handle: FileSystemFileHandleLike | null
  name: string
}

export function supportsFileSystemAccess(): boolean {
  return typeof window.showSaveFilePicker === 'function'
}

export async function pickSaveTarget(suggestedName: string): Promise<SaveTarget | null> {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName, types: FILE_TYPES })
      return { handle, name: handle.name }
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return null
      throw err
    }
  }
  return { handle: null, name: suggestedName }
}

export async function writeTo(target: SaveTarget, text: string): Promise<void> {
  if (target.handle) {
    const writable = await target.handle.createWritable()
    await writable.write(text)
    await writable.close()
    return
  }
  downloadText(target.name, text)
}

export function downloadText(name: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function pickOpenFile(): Promise<{ file: File; handle: FileSystemFileHandleLike | null } | null> {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({ multiple: false, types: FILE_TYPES })
      if (!handle) return null
      return { file: await handle.getFile(), handle }
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return null
      throw err
    }
  }
  const file = await promptForFile('.json,application/json')
  return file ? { file, handle: null } : null
}

export function promptForFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true })
    // Not every browser fires `cancel`; where it does not, the promise simply never settles,
    // which costs nothing because the user can just pick the menu item again.
    input.addEventListener('cancel', () => resolve(null), { once: true })
    input.click()
  })
}

/** The inverse of suggestedFileName: what a chosen file name says the project is called. */
export function projectNameFromFileName(fileName: string): string {
  const base = fileName.replace(/\.ductwork\.json$/i, '').replace(/\.json$/i, '').trim()
  return base || 'Untitled'
}

/**
 * Why "Save" may be downloading a copy instead of writing over your file. Silently degrading
 * is worse than being unavailable: you cannot fix what you have not been told about.
 */
export function saveCapabilityNote(): string | null {
  if (supportsFileSystemAccess()) return null
  if (!window.isSecureContext) {
    return 'This page is not a secure context, so the browser hides its save-in-place API. '
      + 'Open the app on http://localhost rather than a LAN address and Save will write over your file.'
  }
  return 'This browser cannot write over an existing file, so Save downloads a fresh copy each time. '
    + 'Chrome or Edge can save in place. Either way, name the project first — that becomes the file name.'
}

export function suggestedFileName(projectName: string): string {
  const safe = projectName.trim().replace(/[^\w\-. ]+/g, '_').replace(/\s+/g, '-') || 'ductwork'
  return `${safe}${FILE_EXTENSION}`
}
