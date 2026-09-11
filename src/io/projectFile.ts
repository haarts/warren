import { assetData, type AssetRef } from '../model/assets.ts'
import { emptyProject } from '../model/doc.ts'
import { NOTE_DEFAULT_WIDTH, NOTE_MIN_WIDTH } from '../render/notes.ts'
import { defaultSystems } from '../model/systems.ts'
import {
  CATEGORIES, DEFAULT_SETTINGS, LEVELS, MARKER_SYMBOLS,
  ROOM_USES,
  type DoorItem, type Item, type Level, type MarkerItem, type MarkerSymbol, type Project, type RoomItem,
  type RoomUse, type RunItem, type Sheet, type System,
} from '../model/types.ts'

export const FILE_EXTENSION = '.warren.json'

export interface SerializeOptions {
  /**
   * Write the PDF bytes into the file. Off by default: a bundled project is 99.8% base64,
   * which no diff, grep or reader can see past. Turn it on to produce one self-contained file
   * for mailing or archiving.
   */
  bundle?: boolean
}

/** Drop assets no sheet references, so the file does not grow forever. */
function gcAssets(project: Project, bundle: boolean): Record<string, AssetRef> {
  const used = new Set(project.sheets.map((s) => s.pdf?.assetId).filter(Boolean) as string[])
  const out: Record<string, AssetRef> = {}
  for (const [id, ref] of Object.entries(project.assets)) {
    if (!used.has(id)) continue
    const clean: AssetRef = { name: ref.name, bytes: ref.bytes }
    if (bundle) {
      const data = ref.data ?? assetData(id)
      if (data) clean.data = data
    }
    out[id] = clean
  }
  return out
}

export function serialize(project: Project, opts: SerializeOptions = {}): string {
  const clean: Project = { ...project, assets: gcAssets(project, opts.bundle ?? false) }
  return JSON.stringify(clean, null, 2)
}

// --- validation ---------------------------------------------------------------------
// Hand-rolled and forgiving on purpose: a file you wrote 18 months ago should still open
// even if the app has moved on. Unknown fields survive; broken ones fall back to defaults.

/** The seeded catalogue by id, built once per session, for filling in fields a file predates. */
let seedCache: Map<string, System> | null = null
function seedSystem(id: string): System | undefined {
  if (!seedCache) seedCache = new Map(defaultSystems().map((s) => [s.id, s]))
  return seedCache.get(id)
}

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
    if (raw.flowAssumed === true && run.flow !== 'none') run.flowAssumed = true
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
    const item: MarkerItem = { ...common, kind: 'marker', x: num(raw.x), y: num(raw.y), symbol }
    if (isObj(raw.generated) && typeof raw.generated.rule === 'string' && typeof raw.generated.from === 'string') {
      item.generated = { rule: raw.generated.rule, from: raw.generated.from }
    }
    return item
  }
  if (raw.kind === 'room') {
    const pts = Array.isArray(raw.points)
      ? raw.points.filter(isObj).map((p) => ({ x: num(p.x), y: num(p.y) }))
      : []
    if (pts.length < 3) return null
    const room: RoomItem = {
      ...base,
      ...shared,
      kind: 'room',
      name: str(raw.name, 'Room'),
      use: ROOM_USES.includes(raw.use as RoomUse) ? (raw.use as RoomUse) : 'other',
      points: pts,
    }
    if (typeof raw.ref === 'string') room.ref = raw.ref
    if (typeof raw.note === 'string') room.note = raw.note
    return room
  }
  if (raw.kind === 'door') {
    const pts = Array.isArray(raw.points)
      ? raw.points.filter(isObj).map((p) => ({ x: num(p.x), y: num(p.y) }))
      : []
    if (pts.length < 2) return null
    const door: DoorItem = {
      ...common,
      kind: 'door',
      points: [pts[0], pts[1]],
      swing: raw.swing === -1 ? -1 : 1,
    }
    if (typeof raw.ref === 'string') door.ref = raw.ref
    return door
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
  if (Array.isArray(raw.sizes)) {
    // An empty list is kept, not discarded: it means "I cleared these deliberately", and that
    // choice has to survive a reload or it is not a choice.
    system.sizes = raw.sizes.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
  } else {
    // No `sizes` key at all: the file predates the field. Adopt the seed list for this system.
    // Purely additive - nothing drawn changes, and a default the user picked stays the default.
    const seed = seedSystem(id)?.sizes
    if (seed) {
      system.sizes = system.defaultSize && !seed.includes(system.defaultSize)
        ? [system.defaultSize, ...seed]
        : [...seed]
      if (!system.defaultSize) system.defaultSize = system.sizes[0]
    }
  }
  // Same story as sizes: absent means the file predates the field, so take the seed's answer.
  // An explicit false is a decision, and is left alone.
  if (typeof raw.assumeFlow === 'boolean') system.assumeFlow = raw.assumeFlow
  else if (seedSystem(id)?.assumeFlow) system.assumeFlow = true
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
  if (!isObj(raw)) throw new Error('Not a Warren project file')
  const base = emptyProject()

  const systems = Array.isArray(raw.systems)
    ? (raw.systems.map(asSystem).filter(Boolean) as System[])
    : defaultSystems()

  const sheets = Array.isArray(raw.sheets) && raw.sheets.length > 0
    ? raw.sheets.map(asSheet)
    : base.sheets

  const assets: Record<string, AssetRef> = {}
  if (isObj(raw.assets)) {
    for (const [k, v] of Object.entries(raw.assets)) {
      // Files written before assets were references stored the base64 string directly.
      if (typeof v === 'string') {
        assets[k] = { name: 'plan.pdf', bytes: Math.round(v.length * 0.75), data: v }
      } else if (isObj(v)) {
        const ref: AssetRef = { name: str(v.name, 'plan.pdf'), bytes: num(v.bytes, 0) }
        if (typeof v.data === 'string') {
          ref.data = v.data
          if (!ref.bytes) ref.bytes = Math.round(v.data.length * 0.75)
        }
        assets[k] = ref
      }
    }
  }

  const settingsRaw = isObj(raw.settings) ? raw.settings : {}
  const settings = { ...DEFAULT_SETTINGS }
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof typeof DEFAULT_SETTINGS)[]) {
    const v = settingsRaw[key]
    if (typeof v === typeof DEFAULT_SETTINGS[key]) (settings as Record<string, unknown>)[key] = v
  }
  if (settings.levelFilter !== 'all' && !LEVELS.includes(settings.levelFilter)) settings.levelFilter = 'all'

  const activeSheetId = sheets.some((s) => s.id === raw.activeSheetId) ? String(raw.activeSheetId) : sheets[0].id

  const rules = Array.isArray(raw.rules)
    ? (raw.rules.filter(isObj) as unknown as Project['rules'])
    : undefined

  return {
    version: 1,
    name: str(raw.name, 'Untitled'),
    ...(rules?.length ? { rules } : {}),
    systems: systems.length > 0 ? systems : defaultSystems(),
    sheets,
    assets,
    settings,
    activeSheetId,
  }
}

// --- disk ---------------------------------------------------------------------------

const FILE_TYPES: FilePickerAcceptType[] = [
  { description: 'Warren project', accept: { 'application/json': ['.json'] } },
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
  // `.ductwork.json` is this app's former extension; old files still name themselves.
  const base = fileName
    .replace(/\.(warren|ductwork)\.json$/i, '')
    .replace(/\.json$/i, '')
    .trim()
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
  const safe = projectName.trim().replace(/[^\w\-. ]+/g, '_').replace(/\s+/g, '-') || 'warren'
  return `${safe}${FILE_EXTENSION}`
}
