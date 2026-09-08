import type { Pt } from '../geom.ts'

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

/** Where in the building fabric a run sits. A top-down plan cannot show this, so we tag it. */
export const LEVELS = ['crawl', 'floor', 'wall', 'ceiling', 'above', 'roof'] as const
export type Level = (typeof LEVELS)[number]

export const LEVEL_LABELS: Record<Level, string> = {
  crawl: 'Crawl space',
  floor: 'In floor / screed',
  wall: 'In wall',
  ceiling: 'In ceiling',
  above: 'Above ceiling / void',
  roof: 'Roof / outside',
}

export const LEVEL_SHORT: Record<Level, string> = {
  crawl: 'CRW', floor: 'FLR', wall: 'WAL', ceiling: 'CLG', above: 'VOID', roof: 'ROOF',
}

export type Flow = 'none' | 'forward' | 'reverse'

export const MARKER_SYMBOLS = [
  'riser-up', 'riser-down', 'penetration', 'drain', 'cleanout', 'valve', 'outlet', 'sensor', 'note',
] as const
export type MarkerSymbol = (typeof MARKER_SYMBOLS)[number]

export const MARKER_LABELS: Record<MarkerSymbol, string> = {
  'riser-up': 'Riser up',
  'riser-down': 'Riser down',
  penetration: 'Penetration (sparing)',
  drain: 'Drain / gully',
  cleanout: 'Cleanout',
  valve: 'Valve / stopcock',
  outlet: 'Outlet / terminal',
  sensor: 'Sensor',
  note: 'Note pin',
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
  defaultSize?: string
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
}

export type Item = RunItem | BoxItem | MarkerItem

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
  backgroundOpacity: number
  showLabels: boolean
  showFlow: boolean
  showLevels: boolean
  /** Percentage added to every takeoff total for drops, slack and verticals. */
  takeoffSlackPct: number
  levelFilter: Level | 'all'
}

export interface Project {
  version: 1
  name: string
  systems: System[]
  sheets: Sheet[]
  /** sha-256 hex -> base64 PDF bytes. Keeps the source PDF inside the project file. */
  assets: Record<string, string>
  settings: Settings
  activeSheetId: string
}

export const DEFAULT_SETTINGS: Settings = {
  gridMm: 100,
  showGrid: false,
  snapToGrid: false,
  snapToItems: true,
  backgroundOpacity: 0.55,
  showLabels: true,
  showFlow: true,
  showLevels: true,
  takeoffSlackPct: 10,
  levelFilter: 'all',
}
