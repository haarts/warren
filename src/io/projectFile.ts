import type { Pt } from '../geom.ts'
import { assetData, type AssetRef } from '../model/assets.ts'
import { emptyProject } from '../model/doc.ts'
import { NOTE_DEFAULT_WIDTH, NOTE_MIN_WIDTH } from '../render/notes.ts'
import { defaultSystems } from '../model/systems.ts'
import {
  CATEGORIES, DEFAULT_SETTINGS, LEVELS, MARKER_SYMBOLS,
  ROOM_USES,
  type CompassRose, type Direction, type DoorItem, type Item, type MarkerItem, type MarkerSymbol, type Project,
  type RoomItem, type RunItem, type Sheet, type System,
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

/** `v` if it is one of `list`, else `fallback` - the shape every enum field on the file falls back through. */
function oneOf<T extends string>(list: readonly T[], v: unknown, fallback: T): T {
  return list.includes(v as T) ? (v as T) : fallback
}

/** A point array with at least `min` entries, or null - shared by runs, rooms and doors. */
function readPoints(raw: unknown, min: number): Pt[] | null {
  const pts = Array.isArray(raw) ? raw.filter(isObj).map((p) => ({ x: num(p.x), y: num(p.y) })) : []
  return pts.length >= min ? pts : null
}

// Optional fields below are only written when they carry a value: the project file is meant to
// be diffed in git, and a wall of `"locked": false` makes real changes hard to spot.
type Base = { id: string; systemId: string; level: Item['level'] }
type Shared = { colorOverride?: string; locked?: true }

function readBase(raw: Record<string, unknown>, index: number): Base {
  return {
    id: str(raw.id) || `it_recovered_${index}`,
    systemId: str(raw.systemId, 'water.cold'),
    level: oneOf(LEVELS, raw.level, 'wall'),
  }
}

function readShared(raw: Record<string, unknown>): Shared {
  const shared: Shared = {}
  if (typeof raw.colorOverride === 'string') shared.colorOverride = raw.colorOverride
  if (raw.locked === true) shared.locked = true
  return shared
}

function readLabelled(raw: Record<string, unknown>): { label?: string; note?: string } {
  const out: { label?: string; note?: string } = {}
  if (typeof raw.label === 'string') out.label = raw.label
  if (typeof raw.note === 'string') out.note = raw.note
  return out
}

/** One parser per item kind, sharing the field readers above. `null` means "unrecoverable". */
const ITEM_PARSERS: { [K in Item['kind']]: (raw: Record<string, unknown>, base: Base, shared: Shared) => Item | null } = {
  run: (raw, base, shared) => {
    const points = readPoints(raw.points, 1)
    if (!points) return null
    const run: RunItem = {
      ...base, ...shared, ...readLabelled(raw), kind: 'run', points,
      flow: raw.flow === 'forward' || raw.flow === 'reverse' ? raw.flow : 'none',
    }
    if (raw.flowAssumed === true && run.flow !== 'none') run.flowAssumed = true
    if (typeof raw.size === 'string') run.size = raw.size
    if (typeof raw.slope === 'string') run.slope = raw.slope
    if (typeof raw.extraM === 'number' && isFinite(raw.extraM)) run.extraM = raw.extraM
    return run
  },
  box: (raw, base, shared) => ({
    ...base, ...shared, ...readLabelled(raw),
    kind: 'box', x: num(raw.x), y: num(raw.y), w: num(raw.w, 20), h: num(raw.h, 20),
  }),
  marker: (raw, base, shared) => {
    const symbol = oneOf(MARKER_SYMBOLS, raw.symbol, 'note')
    const item: MarkerItem = { ...base, ...shared, ...readLabelled(raw), kind: 'marker', x: num(raw.x), y: num(raw.y), symbol }
    if (isObj(raw.generated) && typeof raw.generated.rule === 'string' && typeof raw.generated.from === 'string') {
      item.generated = { rule: raw.generated.rule, from: raw.generated.from }
    }
    return item
  },
  room: (raw, base, shared) => {
    const points = readPoints(raw.points, 3)
    if (!points) return null
    const room: RoomItem = {
      ...base, ...shared, kind: 'room', name: str(raw.name, 'Room'), use: oneOf(ROOM_USES, raw.use, 'other'), points,
    }
    if (typeof raw.ref === 'string') room.ref = raw.ref
    if (typeof raw.note === 'string') room.note = raw.note
    return room
  },
  door: (raw, base, shared) => {
    const points = readPoints(raw.points, 2)
    if (!points) return null
    const door: DoorItem = {
      ...base, ...shared, ...readLabelled(raw), kind: 'door', points: [points[0], points[1]], swing: raw.swing === -1 ? -1 : 1,
    }
    if (typeof raw.ref === 'string') door.ref = raw.ref
    return door
  },
  // Notes carry `text`, not `label`/`note` - a sticky whose content lived in a side field would
  // be a trap - so they skip readLabelled.
  note: (raw, base, shared) => ({
    ...base, ...shared, kind: 'note', x: num(raw.x), y: num(raw.y),
    w: Math.max(NOTE_MIN_WIDTH, num(raw.w, NOTE_DEFAULT_WIDTH)), text: str(raw.text),
  }),
}

function asItem(raw: unknown, index: number): Item | null {
  if (!isObj(raw)) return null
  const parser = ITEM_PARSERS[raw.kind as Item['kind']]
  return parser ? parser(raw, readBase(raw, index), readShared(raw)) : null
}

function asSystem(raw: unknown, index: number): System | null {
  if (!isObj(raw)) return null
  const id = str(raw.id)
  if (!id) return null
  const category = oneOf(CATEGORIES, raw.category, 'struct')
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
  if (Array.isArray(raw.symbols)) {
    system.symbols = raw.symbols.filter((v): v is MarkerSymbol => MARKER_SYMBOLS.includes(v as MarkerSymbol))
  } else {
    const seed = seedSystem(id)?.symbols
    if (seed) system.symbols = [...seed]
  }
  // Same story as sizes: absent means the file predates the field, so take the seed's answer.
  // An explicit false is a decision, and is left alone.
  if (typeof raw.assumeFlow === 'boolean') system.assumeFlow = raw.assumeFlow
  else if (seedSystem(id)?.assumeFlow) system.assumeFlow = true
  if (typeof raw.tag === 'string') system.tag = raw.tag
  return system
}

function asDirection(raw: unknown): Direction | null {
  if (!isObj(raw)) return null
  const id = str(raw.id)
  if (!id) return null
  const bearingDeg = num(raw.bearingDeg, NaN)
  if (!isFinite(bearingDeg)) return null
  const aliases = Array.isArray(raw.aliases)
    ? raw.aliases.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    : []
  return { id, bearingDeg: ((bearingDeg % 360) + 360) % 360, aliases }
}

function asCompass(raw: unknown): CompassRose | undefined {
  if (!isObj(raw)) return undefined
  const x = num(raw.x, NaN)
  const y = num(raw.y, NaN)
  if (!isFinite(x) || !isFinite(y)) return undefined
  const tips = Array.isArray(raw.tips) ? raw.tips : []
  return {
    x,
    y,
    rotationDeg: ((num(raw.rotationDeg, 0) % 360) + 360) % 360,
    // Always exactly four, whatever the file held - a rose with three tips is not a rose.
    tips: [0, 1, 2, 3].map((i) => str(tips[i])) as CompassRose['tips'],
  }
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
  settings.roomFocus = typeof settingsRaw.roomFocus === 'string' ? settingsRaw.roomFocus : null

  const activeSheetId = sheets.some((s) => s.id === raw.activeSheetId) ? String(raw.activeSheetId) : sheets[0].id

  // Orientation is one thing for the whole project. For a short while it lived on each sheet;
  // such a file hands over the first sheet's rose and every sheet's one-off directions rather
  // than losing them, and is written back the new way on the next save.
  const rawSheets = Array.isArray(raw.sheets) ? raw.sheets.filter(isObj) : []
  const compass = asCompass(raw.compass) ?? rawSheets.map((s) => asCompass(s.compass)).find(Boolean)
  const directions: Direction[] = []
  for (const source of [raw.directions, ...rawSheets.map((s) => s.directions)]) {
    if (!Array.isArray(source)) continue
    for (const d of source.map(asDirection)) {
      if (d && !directions.some((known) => known.id === d.id)) directions.push(d)
    }
  }

  const rules = Array.isArray(raw.rules)
    ? (raw.rules.filter(isObj) as unknown as Project['rules'])
    : undefined

  return {
    version: 1,
    name: str(raw.name, 'Untitled'),
    ...(rules?.length ? { rules } : {}),
    ...(compass ? { compass } : {}),
    ...(directions.length ? { directions } : {}),
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
