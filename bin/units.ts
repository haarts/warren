/**
 * Metres in, metres out. The file stores PDF points and a per-sheet scale; every command
 * converts at this boundary rather than carrying points any further than it has to. An
 * uncalibrated sheet (`mmPerPoint === null`) yields `null` rather than a guess.
 *
 * Also sheet lookup (by number or name substring, shared by every command that takes `--sheet`
 * or an op's `sheet` field) and item reporting (the shape `items`, `trace` and `generate --where`
 * all print) — both downstream of the same conversion.
 */
import { polygonArea, polygonCentroid, polylineLength, type Pt } from '../src/geom.ts'
import type { Item, Level, Project, Sheet } from '../src/model/types.ts'
import type { Store } from '../src/model/doc.ts'
import { fail } from './args.ts'

export const metres = (sheet: Sheet, points: number): number | null =>
  sheet.mmPerPoint === null ? null : (points * sheet.mmPerPoint) / 1000

export const pointsFromMetres = (sheet: Sheet, m: number): number | null =>
  sheet.mmPerPoint === null ? null : (m * 1000) / sheet.mmPerPoint

export const round = (n: number, places = 2): number => Number(n.toFixed(places))

export function pointAtM(sheet: Sheet, p: Pt): [number, number] | null {
  const x = metres(sheet, p.x)
  const y = metres(sheet, p.y)
  return x === null || y === null ? null : [round(x), round(y)]
}

/** The non-failing core, so a long-lived process can report a bad selector rather than exit. */
export function findSheets(project: Project, selector: string | true | undefined): Sheet[] {
  if (selector === undefined || selector === true) return project.sheets
  const index = Number(selector)
  if (Number.isInteger(index) && index >= 1 && index <= project.sheets.length) return [project.sheets[index - 1]]
  return project.sheets.filter((s) => s.name.toLowerCase().includes(String(selector).toLowerCase()))
}

export function sheetOf(project: Project, selector: string | true | undefined): Sheet[] {
  const found = findSheets(project, selector)
  if (found.length === 0) {
    fail(`no sheet matching "${String(selector)}". Sheets: ${project.sheets.map((s) => s.name).join(', ')}`)
  }
  return found
}

export const globToRegExp = (pattern: string): RegExp =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i')

export interface ItemReport {
  id: string
  kind: Item['kind']
  sheet: string
  system: string
  systemId: string
  level: Level
  label?: string
  size?: string
  flow?: string
  lengthM?: number | null
  atM?: [number, number] | null
  text?: string
  use?: string
  areaM2?: number
  /** Which symbol a marker draws with — otherwise invisible to anything but the raw file. */
  symbol?: string
}

export function reportItem(store: Store, sheet: Sheet, item: Item): ItemReport {
  const system = store.system(item.systemId)
  const report: ItemReport = {
    id: item.id,
    kind: item.kind,
    sheet: sheet.name,
    system: system.name,
    systemId: item.systemId,
    level: item.level,
  }
  if (item.kind !== 'note' && item.kind !== 'room' && item.label) report.label = item.label
  if (item.kind === 'room') {
    report.label = [item.ref, item.name].filter(Boolean).join(' ')
    report.use = item.use
    const mm = sheet.mmPerPoint
    if (mm) report.areaM2 = round(Math.abs(polygonArea(item.points)) * (mm / 1000) ** 2, 1)
    report.atM = pointAtM(sheet, polygonCentroid(item.points))
    return report
  }
  if (item.kind === 'door') {
    report.atM = pointAtM(sheet, item.points[0])
    report.label = [item.ref, item.label].filter(Boolean).join(' ')
    return report
  }
  if (item.kind === 'run') {
    if (item.size) report.size = item.size
    if (item.flow !== 'none') report.flow = item.flow
    const len = metres(sheet, polylineLength(item.points))
    report.lengthM = len === null ? null : round(len)
    const first = item.points[0]
    report.atM = pointAtM(sheet, first)
  } else if (item.kind === 'box' || item.kind === 'marker' || item.kind === 'note') {
    report.atM = pointAtM(sheet, { x: item.x, y: item.y })
    if (item.kind === 'marker') report.symbol = item.symbol
    if (item.kind === 'note') report.text = item.text
  }
  return report
}
