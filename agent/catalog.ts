import { pointInPolygon, polygonArea, polylineLength, type Pt } from '../src/geom.ts'
import { roomsOf } from '../src/rooms.ts'
import {
  LEVEL_LABELS,
  MARKER_LABELS,
  type Item,
  type MarkerItem,
  type Project,
  type Sheet,
  type System,
} from '../src/model/types.ts'

/**
 * Everything in the drawing, each item turned into a line of English a model can judge.
 *
 * The ids are opaque, so an id alone tells a model nothing. The description carries the facts
 * that decide a match: what kind of thing it is, its system, where it sits in the building
 * fabric, and - read from the geometry rather than a label - which room it is in.
 */

export interface Candidate {
  id: string
  kind: Item['kind']
  sheet: string
  /** The whole of what a model is told about the item. */
  description: string
}

export function catalogue(project: Project): Candidate[] {
  const systems = new Map(project.systems.map((s) => [s.id, s]))
  const out: Candidate[] = []
  for (const sheet of project.sheets) {
    for (const item of sheet.items) {
      out.push({
        id: item.id,
        kind: item.kind,
        sheet: sheet.name,
        description: describe(sheet, item, systems.get(item.systemId)),
      })
    }
  }
  return out
}

const metres = (sheet: Sheet, points: number): number | null =>
  sheet.mmPerPoint === null ? null : (points * sheet.mmPerPoint) / 1000

function atMetres(sheet: Sheet, p: Pt): string | null {
  const x = metres(sheet, p.x)
  const y = metres(sheet, p.y)
  return x === null || y === null ? null : `${round(x)}, ${round(y)} m`
}

const round = (v: number): string => (Math.round(v * 100) / 100).toString()

/** Room names read from where a point is, not from a label. Crossings do not count. */
function roomsAt(sheet: Sheet, p: Pt): string[] {
  return sheet.items
    .filter((r): r is Extract<Item, { kind: 'room' }> => r.kind === 'room' && pointInPolygon(p, r.points))
    .map((r) => [r.ref, r.name].filter(Boolean).join(' ') || 'unnamed room')
}

/** The rooms an item's own anchors sit in; a run reaching two rooms says both. */
function roomsOfItem(sheet: Sheet, item: Item): string[] {
  const names = roomsOf(sheet, item).map((r) => [r.ref, r.name].filter(Boolean).join(' ') || 'unnamed room')
  return [...new Set(names)]
}

function suffix(parts: (string | null | undefined)[]): string {
  const kept = parts.filter((p): p is string => Boolean(p && p.trim()))
  return kept.length ? ` — ${kept.join('; ')}` : ''
}

function describe(sheet: Sheet, item: Item, system?: System): string {
  const systemName = system?.name ?? item.systemId
  const level = LEVEL_LABELS[item.level]
  const rooms = roomsOfItem(sheet, item)
  const inRooms = rooms.length ? rooms.join(' / ') : null
  const label = 'label' in item && item.label ? `"${item.label}"` : null

  switch (item.kind) {
    case 'room': {
      const name = [item.ref, item.name].filter(Boolean).join(' ')
      const area = item.points.length >= 3 ? polygonArea(item.points) : 0
      const m2 = sheet.mmPerPoint ? round(Math.abs(area) * (sheet.mmPerPoint / 1000) ** 2) : null
      return `Room (${item.use})${suffix([
        name ? `named ${name}` : null,
        m2 ? `${m2} m²` : null,
        `on sheet "${sheet.name}"`,
      ])}`
    }
    case 'door': {
      const name = [item.ref, item.label].filter(Boolean).join(' ')
      const ends = item.points.flatMap((p) => roomsAt(sheet, p))
      const between = [...new Set(ends)]
      return `Door${suffix([
        name ? `"${name}"` : null,
        `${level}`,
        between.length ? `in ${between.join(' / ')}` : null,
        atMetres(sheet, item.points[0]) ? `at ${atMetres(sheet, item.points[0])}` : null,
      ])}`
    }
    case 'window': {
      const len = metres(sheet, polylineLength(item.points))
      const name = [item.ref, item.label].filter(Boolean).join(' ')
      // The jambs sit in the wall, so look a little past the frame on either side.
      const [p, q] = item.points
      const l = Math.hypot(q.x - p.x, q.y - p.y) || 1
      const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }
      const reach = item.depth / 2 + 2
      const sides = [1, -1].map((s) => ({ x: mid.x - ((q.y - p.y) / l) * reach * s, y: mid.y + ((q.x - p.x) / l) * reach * s }))
      const rooms = [...new Set(sides.flatMap((side) => roomsAt(sheet, side)))]
      return `Window${suffix([
        name ? `"${name}"` : null,
        len !== null ? `${round(len)} m wide` : null,
        rooms.length ? `beside ${rooms.join(' / ')}` : null,
        atMetres(sheet, item.points[0]) ? `from ${atMetres(sheet, item.points[0])}` : null,
        `sheet "${sheet.name}"`,
      ])}`
    }
    case 'wall': {
      const len = metres(sheet, polylineLength(item.points))
      const thick = metres(sheet, item.thickness)
      return `Wall, ${item.status}${suffix([
        thick !== null ? `${Math.round(thick * 1000)} mm thick` : null,
        len !== null ? `${round(len)} m long` : null,
        inRooms ? `bounding ${inRooms}` : null,
        atMetres(sheet, item.points[0]) ? `from ${atMetres(sheet, item.points[0])}` : null,
        label,
        `sheet "${sheet.name}"`,
      ])}`
    }
    case 'run': {
      const start = item.points[0]
      const end = item.points[item.points.length - 1]
      const from = start ? roomsAt(sheet, start) : []
      const to = end ? roomsAt(sheet, end) : []
      const len = metres(sheet, polylineLength(item.points))
      const where = [from.join('/'), to.join('/')].filter(Boolean).join(' → ')
      return `Run (pipe or duct) of ${systemName}${suffix([
        item.size ? `size ${item.size}` : null,
        `${level}`,
        where ? `from ${where}` : inRooms ? `in ${inRooms}` : null,
        len !== null ? `${round(len)} m long` : null,
        label,
        `sheet "${sheet.name}"`,
      ])}`
    }
    case 'box':
      return `Equipment box of ${systemName}${suffix([
        `${level}`,
        inRooms ? `in ${inRooms}` : null,
        atMetres(sheet, { x: item.x, y: item.y }) ? `at ${atMetres(sheet, { x: item.x, y: item.y })}` : null,
        `sheet "${sheet.name}"`,
      ])}`
    case 'marker': {
      const symbol = markerSymbol(item)
      return `${symbol} marker of ${systemName}${suffix([
        `${level}`,
        inRooms ? `in ${inRooms}` : null,
        atMetres(sheet, { x: item.x, y: item.y }) ? `at ${atMetres(sheet, { x: item.x, y: item.y })}` : null,
        label,
        `sheet "${sheet.name}"`,
      ])}`
    }
    case 'note': {
      const text = item.text.length > 180 ? `${item.text.slice(0, 177)}…` : item.text
      return `Note${suffix([
        inRooms ? `in ${inRooms}` : null,
        atMetres(sheet, { x: item.x, y: item.y }) ? `at ${atMetres(sheet, { x: item.x, y: item.y })}` : null,
        `saying "${text}"`,
        `sheet "${sheet.name}"`,
      ])}`
    }
  }
}

function markerSymbol(item: MarkerItem): string {
  const label = MARKER_LABELS[item.symbol]
  return label ? `${label} (${item.symbol})` : item.symbol
}
