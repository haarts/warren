import type { Pt } from '../geom.ts'
import type { AssetRef } from './assets.ts'

export const CATEGORIES = ['water', 'reuse', 'drain', 'heat', 'air', 'power', 'data', 'struct'] as const
export type Category = (typeof CATEGORIES)[number]

export const CATEGORY_LABELS: Record<Category, string> = {
  water: 'Fresh water',
  reuse: 'Rainwater reuse (non-potable)',
  drain: 'Drainage',
  heat: 'Heating / heat pump',
  air: 'Ventilation',
  power: 'Power',
  data: 'Data / low voltage',
  struct: 'Structure / coordination',
}

/**
 * Where something sits in the building fabric. A top-down plan cannot show height, so we tag
 * it instead. Two distinct facts share this axis: what a run is buried *in*, and what a piece
 * of equipment is mounted *on*. Hence the `in` / `on` pairs - a distribution board hangs on a
 * wall, a DHW cylinder stands on the floor, and surface-run conduit is on a wall rather than
 * chased into it.
 */
export const LEVELS = ['crawl', 'floor', 'on-floor', 'wall', 'on-wall', 'ceiling', 'above', 'roof'] as const
export type Level = (typeof LEVELS)[number]

export const LEVEL_LABELS: Record<Level, string> = {
  crawl: 'Crawl space',
  floor: 'In floor / screed',
  'on-floor': 'On floor (standing)',
  wall: 'In wall',
  'on-wall': 'On wall (surface)',
  ceiling: 'In ceiling',
  above: 'Above ceiling / void',
  roof: 'Roof / outside',
}

export const LEVEL_SHORT: Record<Level, string> = {
  crawl: 'CRW',
  floor: 'FLR',
  'on-floor': 'ON FLR',
  wall: 'WAL',
  'on-wall': 'ON WAL',
  ceiling: 'CLG',
  above: 'VOID',
  roof: 'ROOF',
}

export type Flow = 'none' | 'forward' | 'reverse'

/**
 * Deliberately short. These are the things that actually get marked on a Dutch installation
 * drawing; anything rarer is best served by the nearest symbol plus a note, rather than by a
 * catalogue nobody can find their way around.
 */
export const MARKER_SYMBOLS = [
  'socket', 'socket-2', 'socket-3', 'socket-4', 'switch', 'light', 'detector', 'data-outlet', 'air-valve',
  'riser-up', 'riser-down', 'penetration', 'drain', 'cleanout', 'valve', 'outlet', 'sensor', 'note',
] as const
export type MarkerSymbol = (typeof MARKER_SYMBOLS)[number]

export const MARKER_LABELS: Record<MarkerSymbol, string> = {
  socket: 'Wandcontactdoos',
  'socket-2': 'Dubbele wandcontactdoos',
  'socket-3': 'Drievoudige wandcontactdoos',
  'socket-4': 'Viervoudige wandcontactdoos',
  switch: 'Schakelaar (switch)',
  light: 'Lichtpunt (light point)',
  detector: 'Rookmelder (detector)',
  'data-outlet': 'Data-aansluitpunt (data outlet)',
  'air-valve': 'Ventiel / rooster (air valve)',
  'riser-up': 'Standleiding omhoog (riser up)',
  'riser-down': 'Standleiding omlaag (riser down)',
  penetration: 'Sparing (penetration)',
  drain: 'Afvoerput (gully)',
  cleanout: 'Ontstoppingsstuk (cleanout)',
  valve: 'Afsluiter (valve)',
  outlet: 'Tappunt (draw-off)',
  sensor: 'Sensor',
  note: 'Dot / reference pin',
}

export interface System {
  id: string
  category: Category
  name: string
  color: string
  /** Dash pattern in world units (points). Empty = solid. */
  dash: number[]
  /** Stroke width in world units (points). */
  width: number
  /** What a new run of this system gets. Always sizes[0] when a list is present. */
  defaultSize?: string
  /** Suggested sizes offered in the size field. Suggestions only - the field stays free text. */
  sizes?: string[]
  /**
   * Marker symbols worth offering for this system. A gully under a lighting group is noise,
   * so the list is scoped; a symbol already in use is always still offered.
   */
  symbols?: MarkerSymbol[]
  /**
   * Direction is physically meaningful for this system, so a new run guesses it from the order
   * it was drawn in. True for anything that falls, is pumped, or is blown; false for a socket
   * circuit, where an arrow would be noise.
   */
  assumeFlow?: boolean
  /** Appended to the auto-label, e.g. "NON-POTABLE". */
  tag?: string
  visible: boolean
  locked: boolean
}

export interface RunItem {
  kind: 'run'
  id: string
  systemId: string
  level: Level
  points: Pt[]
  size?: string
  label?: string
  note?: string
  flow: Flow
  /**
   * The direction was guessed from the order the run was drawn in, and nobody has confirmed
   * it. Drawn faintly and reported by `warren check`, because a confidently wrong fall
   * direction on a sheet an installer builds from is worse than no arrow at all.
   */
  flowAssumed?: boolean
  /** Drainage fall, free text e.g. "1:60". */
  slope?: string
  colorOverride?: string
  /** Extra metres added to the takeoff for this run (drops, slack, verticals). */
  extraM?: number
  locked?: boolean
}

export interface BoxItem {
  kind: 'box'
  id: string
  systemId: string
  level: Level
  x: number
  y: number
  w: number
  h: number
  label?: string
  note?: string
  colorOverride?: string
  locked?: boolean
}

/** Stamped on anything a rule produced, and dropped the moment a person edits it. */
export interface GeneratedBy {
  rule: string
  /** The room or door it was placed from. */
  from: string
}

export interface MarkerItem {
  kind: 'marker'
  id: string
  systemId: string
  level: Level
  x: number
  y: number
  symbol: MarkerSymbol
  label?: string
  note?: string
  colorOverride?: string
  locked?: boolean
  generated?: GeneratedBy
}

/**
 * A sticky note anchored to a spot on the plan. It belongs to a system like everything else,
 * so a note about the HRV hides when you hide ventilation. Height is not stored: it follows
 * the wrapped text, so the only thing you ever set is the width.
 */
export interface NoteItem {
  kind: 'note'
  id: string
  systemId: string
  level: Level
  x: number
  y: number
  /** Width in world units (PDF points). Height is derived from the text. */
  w: number
  text: string
  colorOverride?: string
  locked?: boolean
}

/**
 * What a room is for. This is what turns a shape into something rules can act on: a bedroom
 * wants sockets and a smoke detector, a toilet wants neither.
 */
export const ROOM_USES = [
  'living', 'kitchen', 'dining', 'bedroom', 'bathroom', 'toilet', 'hall', 'stairs',
  'utility', 'storage', 'technical', 'workshop', 'garage', 'outdoor', 'other',
] as const
export type RoomUse = (typeof ROOM_USES)[number]

export const ROOM_USE_LABELS: Record<RoomUse, string> = {
  living: 'Living room', kitchen: 'Kitchen', dining: 'Dining room', bedroom: 'Bedroom',
  bathroom: 'Bathroom', toilet: 'Toilet', hall: 'Hall / landing', stairs: 'Stairs',
  utility: 'Utility', storage: 'Storage', technical: 'Technical', workshop: 'Workshop',
  garage: 'Garage', outdoor: 'Outdoor', other: 'Other',
}

/**
 * A room outline. Architecture rather than a service, so it ignores the level filter - rooms
 * are the context you read everything else against.
 */
export interface RoomItem {
  kind: 'room'
  id: string
  systemId: string
  level: Level
  name: string
  use: RoomUse
  /** The architect's reference, e.g. "0.04". */
  ref?: string
  /** A closed polygon; the last point joins back to the first. */
  points: Pt[]
  note?: string
  colorOverride?: string
  locked?: boolean
}

/**
 * A doorway. The hinge jamb is points[0] and the strike jamb points[1], which is the whole
 * point of recording it: a light switch belongs by the strike, not behind the door.
 */
export interface DoorItem {
  kind: 'door'
  id: string
  systemId: string
  level: Level
  points: Pt[]
  /** Which side of the opening the door swings to: +1 or -1 along the wall normal. */
  swing: 1 | -1
  ref?: string
  label?: string
  note?: string
  colorOverride?: string
  locked?: boolean
}

export type Item = RunItem | BoxItem | MarkerItem | NoteItem | RoomItem | DoorItem

/** Architecture, not services: exempt from the level filter and never material. */
export const ITEM_KINDS: Item['kind'][] = ['run', 'box', 'marker', 'note', 'room', 'door']

export const ARCHITECTURE_KINDS: Item['kind'][] = ['room', 'door']

/** Items defined by a list of points: runs, room outlines and door openings. */
export function pointsOf(item: Item): Pt[] | null {
  return item.kind === 'run' || item.kind === 'room' || item.kind === 'door' ? item.points : null
}

/** Items defined by a single position. */
export function isPositioned(item: Item): item is BoxItem | MarkerItem | NoteItem {
  return item.kind === 'box' || item.kind === 'marker' || item.kind === 'note'
}

/** Every coordinate an item is made of, whichever shape it is. */
export function coordsOf(item: Item): Pt[] {
  return pointsOf(item) ?? [{ x: (item as BoxItem).x, y: (item as BoxItem).y }]
}

export interface SheetPdf {
  assetId: string
  page: number
  rotation: 0 | 90 | 180 | 270
  /** Page size in points at the stored rotation; lets us lay out before the PDF finishes decoding. */
  widthPt: number
  heightPt: number
}

export interface Sheet {
  id: string
  name: string
  pdf: SheetPdf | null
  /** Real-world millimetres per PDF point. null until calibrated. */
  mmPerPoint: number | null
  items: Item[]
}

export interface Settings {
  gridMm: number
  showGrid: boolean
  snapToGrid: boolean
  snapToItems: boolean
  /** Ortho latched on, as AutoCAD's F8. Shift is then a temporary override either way. */
  orthoLock: boolean
  backgroundOpacity: number
  showLabels: boolean
  showFlow: boolean
  showNotes: boolean
  showLevels: boolean
  /** Percentage added to every takeoff total for drops, slack and verticals. */
  takeoffSlackPct: number
  levelFilter: Level | 'all'
}

export interface Project {
  version: 1
  name: string
  /** Placement rules. Data rather than code, so they are yours to change. */
  rules?: import('../generate.ts').GenerateRule[]
  systems: System[]
  sheets: Sheet[]
  /**
   * sha-256 hex -> a reference to the source PDF. The bytes are held outside the project file
   * unless it was written as a bundle; see model/assets.ts.
   */
  assets: Record<string, AssetRef>
  settings: Settings
  activeSheetId: string
}

export const DEFAULT_SETTINGS: Settings = {
  gridMm: 100,
  showGrid: false,
  snapToGrid: false,
  snapToItems: true,
  orthoLock: false,
  backgroundOpacity: 0.55,
  showLabels: true,
  showFlow: true,
  showNotes: true,
  showLevels: true,
  takeoffSlackPct: 10,
  levelFilter: 'all',
}
