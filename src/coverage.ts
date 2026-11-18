/**
 * What a presence sensor can see: a cone from where it hangs, the way it faces, as wide as its
 * lens and as far as its radar reaches - cut short by the first wall in the way.
 *
 * A wall is solid here even though a radar sees a little way through plasterboard. The drawing is
 * for deciding where sensors go, and "this corner is behind a wall" is the answer that question
 * needs; a sensor counted on to see through one is a sensor in the wrong place.
 */
import { pointInPolygon, thickOutline, type Pt } from './geom.ts'
import type { Item, MarkerItem, Sheet } from './model/types.ts'

/** What a presence marker is drawn with until it is told otherwise. */
export const PRESENCE_DEFAULTS = { fovDeg: 120, rangeM: 6 } as const

export interface View {
  /** Which way it faces: degrees clockwise from up the page. */
  aimDeg: number
  /** How wide it sees, in degrees. 360 for one on the ceiling, which looks down at the room. */
  fovDeg: number
  /** How far it sees, in world units (PDF points). */
  range: number
}

export const hasView = (item: Item): item is MarkerItem => item.kind === 'marker' && item.symbol === 'presence'

/**
 * The view a presence marker has on this sheet, or null when it has none - or when it has no range
 * of its own on a sheet without a scale, since "six metres" means nothing there.
 */
export function viewOf(marker: MarkerItem, mmPerPoint: number | null): View | null {
  if (!hasView(marker)) return null
  const range = marker.range ?? (mmPerPoint ? (PRESENCE_DEFAULTS.rangeM * 1000) / mmPerPoint : null)
  if (!range || !(range > 0)) return null
  // On the ceiling it looks down: a cone pointing at the floor covers a disc round the spot it
  // hangs from, whatever way it is turned.
  const fovDeg = marker.level === 'ceiling' ? 360 : Math.min(360, Math.max(1, marker.fovDeg ?? PRESENCE_DEFAULTS.fovDeg))
  return { aimDeg: marker.aimDeg ?? 0, fovDeg, range }
}

/** A unit step in a direction given as degrees clockwise from up the page (y runs down). */
export const aimVector = (deg: number): Pt => {
  const r = (deg * Math.PI) / 180
  return { x: Math.sin(r), y: -Math.cos(r) }
}

/** The direction from one point to another, as degrees clockwise from up the page, 0-360. */
export function bearingDeg(from: Pt, to: Pt): number {
  const d = (Math.atan2(to.x - from.x, -(to.y - from.y)) * 180) / Math.PI
  return ((d % 360) + 360) % 360
}

interface Edge { a: Pt; b: Pt; n: Pt }

/** A two-point line made longer by `by` at each end. */
function lengthen(points: Pt[], by: number): Pt[] {
  const [a, b] = [points[0], points[points.length - 1]]
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
  const ux = (b.x - a.x) / len
  const uy = (b.y - a.y) / len
  return [{ x: a.x - ux * by, y: a.y - uy * by }, { x: b.x + ux * by, y: b.y + uy * by }]
}

/**
 * A shut door as a solid: a leaf's thickness, and a little longer than the opening, since a door
 * traced jamb to jamb seldom meets the ends of its walls exactly and a view should not squeeze out
 * through the crack. In millimetres; in points on a sheet without a scale.
 */
const DOOR_HALF_MM = 20
const DOOR_OVERLAP_MM = 60

/**
 * Every wall on the sheet as the faces of its outline, each with its outward normal. A ray only
 * stops where it goes *into* a wall: a sensor hangs on a wall, so the ray leaving the wall it is
 * fixed to must not count as hitting one.
 */
export function obstaclesOf(sheet: Pick<Sheet, 'items'> & { mmPerPoint?: number | null }): Edge[] {
  const edges: Edge[] = []
  const mm = (v: number): number => (sheet.mmPerPoint ? v / sheet.mmPerPoint : v / 10)
  for (const item of sheet.items) {
    // A door counts as shut: a sensor is placed for the room it is in, and the drawing should
    // say what that room gets, not what spills into the hall when somebody leaves it open.
    if (item.kind !== 'wall' && item.kind !== 'door') continue
    if (item.points.length < 2) continue
    const outline = item.kind === 'wall' ? thickOutline(item.points, item.thickness / 2) : thickOutline(lengthen(item.points, mm(DOOR_OVERLAP_MM)), mm(DOOR_HALF_MM))
    let area = 0
    for (let i = 0; i < outline.length; i++) {
      const p = outline[i]
      const q = outline[(i + 1) % outline.length]
      area += p.x * q.y - q.x * p.y
    }
    const turn = area >= 0 ? 1 : -1
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i]
      const b = outline[(i + 1) % outline.length]
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      if (len < 1e-9) continue
      edges.push({ a, b, n: { x: (turn * (b.y - a.y)) / len, y: (-turn * (b.x - a.x)) / len } })
    }
  }
  return edges
}

/** How far a ray goes before it enters a wall, capped at the range. */
function reach(o: Pt, d: Pt, range: number, edges: Edge[]): number {
  let best = range
  for (const e of edges) {
    // Only faces the ray meets from outside.
    if (d.x * e.n.x + d.y * e.n.y >= 0) continue
    const sx = e.b.x - e.a.x
    const sy = e.b.y - e.a.y
    const den = d.x * sy - d.y * sx
    if (Math.abs(den) < 1e-12) continue
    const ox = e.a.x - o.x
    const oy = e.a.y - o.y
    const t = (ox * sy - oy * sx) / den
    const u = (ox * d.y - oy * d.x) / den
    if (t > 1e-6 && t < best && u >= -1e-9 && u <= 1 + 1e-9) best = t
  }
  return best
}

const STEP_DEG = 1

/**
 * The area a sensor sees, as one closed outline starting and ending at the sensor (a full circle
 * for one that sees all round). Rays go out a degree apart and also just either side of every wall
 * corner in range, so a shadow cast by a corner is sharp rather than stepped.
 */
export function coverage(origin: Pt, view: View, edges: Edge[]): Pt[] {
  const { range } = view
  const full = view.fovDeg >= 360
  const near = edges.filter((e) => {
    const minX = Math.min(e.a.x, e.b.x), maxX = Math.max(e.a.x, e.b.x)
    const minY = Math.min(e.a.y, e.b.y), maxY = Math.max(e.a.y, e.b.y)
    return maxX >= origin.x - range && minX <= origin.x + range && maxY >= origin.y - range && minY <= origin.y + range
  })
  const start = full ? 0 : view.aimDeg - view.fovDeg / 2
  const span = full ? 360 : view.fovDeg
  const offsets: number[] = []
  const steps = Math.ceil(span / STEP_DEG)
  for (let i = 0; i <= steps; i++) offsets.push(Math.min(span, i * STEP_DEG))
  for (const e of near) {
    for (const c of [e.a, e.b]) {
      if (Math.hypot(c.x - origin.x, c.y - origin.y) > range) continue
      const off = (((bearingDeg(origin, c) - start) % 360) + 360) % 360
      for (const eps of [-0.05, 0.05]) {
        const o = off + eps
        if (o > 0 && o < span) offsets.push(o)
      }
    }
  }
  offsets.sort((a, b) => a - b)
  const out: Pt[] = full ? [] : [{ ...origin }]
  for (const off of offsets) {
    const d = aimVector(start + off)
    const t = reach(origin, d, range, near)
    out.push({ x: origin.x + d.x * t, y: origin.y + d.y * t })
  }
  return out
}

/**
 * The way a sensor hung here would best face: into a room, and of the ways that do, the one that
 * sees the most floor. Away from the wall it is on rather than through it, into the bigger room
 * when it hangs on a wall between two, along the diagonal when it sits in a corner. A way counts
 * as into a room when a short step that way lands inside one; on a sheet without rooms, any way.
 */
export function suggestAim(origin: Pt, view: Omit<View, 'aimDeg'>, edges: Edge[], rooms: Pt[][] = []): number {
  const step = view.range / 20
  // How much of the room each way out of the sensor sees, a degree apart: as far as the first
  // wall, but no further than the edge of the room that way leads into - a wall between two
  // rooms is aimed at the one it serves, not at the one beyond a doorway. A way that leads into
  // no room counts for nothing, since the garden is not what it is for.
  const reachDeg: number[] = []
  for (let deg = 0; deg < 360; deg++) {
    const d = aimVector(deg)
    let t = reach(origin, d, view.range, edges)
    if (rooms.length) {
      const into = rooms.find((r) => pointInPolygon({ x: origin.x + d.x * step, y: origin.y + d.y * step }, r))
      t = into ? Math.min(t, leave(origin, d, step, into)) : 0
    }
    reachDeg.push(t * t)
  }
  const half = Math.floor(Math.min(360, view.fovDeg) / 2)
  let best = 0
  let bestArea = -1
  for (let aim = 0; aim < 360; aim += 5) {
    let area = 0
    for (let k = -half; k <= half; k++) area += reachDeg[(((aim + k) % 360) + 360) % 360]
    if (area > bestArea + 1e-9) { bestArea = area; best = aim }
  }
  return best
}

/** How far a ray from inside a room goes before it crosses the room's outline. */
function leave(o: Pt, d: Pt, from: number, room: Pt[]): number {
  let best = Infinity
  for (let i = 0; i < room.length; i++) {
    const a = room[i]
    const b = room[(i + 1) % room.length]
    const sx = b.x - a.x
    const sy = b.y - a.y
    const den = d.x * sy - d.y * sx
    if (Math.abs(den) < 1e-12) continue
    const t = ((a.x - o.x) * sy - (a.y - o.y) * sx) / den
    const u = ((a.x - o.x) * d.y - (a.y - o.y) * d.x) / den
    if (t > from && t < best && u >= 0 && u <= 1) best = t
  }
  return best
}

/** The floor plans of a sheet's indoor rooms - what "into the room" is measured against. */
export const roomsOf = (sheet: Pick<Sheet, 'items'>): Pt[][] =>
  sheet.items.flatMap((i) => (i.kind === 'room' && i.use !== 'outdoor' && i.points.length >= 3 ? [i.points] : []))

/** A presence sensor nobody aimed faces the way it sees the most floor. Anything else is left be. */
export function aimIfUnset(marker: MarkerItem, sheet: Pick<Sheet, 'items' | 'mmPerPoint'>): void {
  if (marker.symbol !== 'presence' || marker.aimDeg !== undefined) return
  const range = marker.range ?? (sheet.mmPerPoint ? (PRESENCE_DEFAULTS.rangeM * 1000) / sheet.mmPerPoint : null)
  if (!range) return
  marker.aimDeg = suggestAim(marker, { fovDeg: marker.fovDeg ?? PRESENCE_DEFAULTS.fovDeg, range }, obstaclesOf(sheet), roomsOf(sheet))
}
