/**
 * Floors that line up. Every sheet is a separate PDF page, and nothing says the architect put
 * each floor in the same place on its page, at the same angle, or that two pages were calibrated
 * alike. So a point is never carried from one floor to another by its coordinates: each sheet
 * records where the same two physical spots are on it, and the mapping between two floors is
 * the one shift, turn and scale that lays one pair on the other.
 *
 * Node-safe: the app, `warren check` and `warren align` all use it.
 */
import { dist, type Pt } from './geom.ts'
import type { Item, Sheet, SheetAlignment } from './model/types.ts'

/** How far apart two floors' calibrations may disagree, as a fraction, before it is worth asking. */
export const CALIBRATION_TOLERANCE = 0.01

/** A shift, turn and uniform scale from one sheet's points to another's. */
export interface FloorMapping {
  apply(p: Pt): Pt
  /** Points on the target per point on the source. */
  scale: number
  /** Clockwise turn on screen, in degrees. */
  turnDeg: number
}

/**
 * The mapping that carries `from`'s reference pair onto `to`'s, or null when either sheet has
 * not been aligned. Complex arithmetic in disguise: p' = to.a + k (p - from.a), k = (to.b -
 * to.a) / (from.b - from.a).
 */
export function floorMapping(from: Sheet, to: Sheet): FloorMapping | null {
  if (!from.align || !to.align) return null
  return mappingBetween(from.align, to.align)
}

export function mappingBetween(from: SheetAlignment, to: SheetAlignment): FloorMapping | null {
  const fx = from.b.x - from.a.x
  const fy = from.b.y - from.a.y
  const tx = to.b.x - to.a.x
  const ty = to.b.y - to.a.y
  const d = fx * fx + fy * fy
  if (d === 0 || tx * tx + ty * ty === 0) return null
  // k = t / f, as complex numbers.
  const kr = (tx * fx + ty * fy) / d
  const ki = (ty * fx - tx * fy) / d
  return {
    apply: (p) => {
      const px = p.x - from.a.x
      const py = p.y - from.a.y
      return { x: to.a.x + kr * px - ki * py, y: to.a.y + ki * px + kr * py }
    },
    scale: Math.hypot(kr, ki),
    turnDeg: (Math.atan2(ki, kr) * 180) / Math.PI,
  }
}

/**
 * The same physical distance - between the two reference points - as each sheet's calibration
 * measures it. They should agree; when they do not, one of the calibrations is wrong, and only a
 * person can say which. Null when either sheet is unaligned or uncalibrated.
 */
export function calibrationAgreement(a: Sheet, b: Sheet): { aMm: number; bMm: number; off: number } | null {
  if (!a.align || !b.align || !a.mmPerPoint || !b.mmPerPoint) return null
  const aMm = dist(a.align.a, a.align.b) * a.mmPerPoint
  const bMm = dist(b.align.a, b.align.b) * b.mmPerPoint
  return { aMm, bMm, off: Math.abs(aMm / bMm - 1) }
}

/**
 * What `sheet`'s scale would be if it agreed with `other`: the same reference distance, measured
 * in this sheet's own points. Null unless both are aligned and `other` is calibrated.
 */
export function scaleFromAlignment(sheet: Sheet, other: Sheet): number | null {
  if (!sheet.align || !other.align || !other.mmPerPoint) return null
  const here = dist(sheet.align.a, sheet.align.b)
  return here > 0 ? (dist(other.align.a, other.align.b) * other.mmPerPoint) / here : null
}

/** A copy of `item` carried through `m`: every point mapped, every size scaled, every angle turned. */
export function mapItem(item: Item, m: FloorMapping): Item {
  const copy = structuredClone(item)
  if ('points' in copy) copy.points = copy.points.map((p) => m.apply(p))
  if (copy.kind === 'box') {
    const c = m.apply({ x: copy.x + copy.w / 2, y: copy.y + copy.h / 2 })
    copy.w *= m.scale
    copy.h *= m.scale
    copy.x = c.x - copy.w / 2
    copy.y = c.y - copy.h / 2
    const turn = (((copy.rotationDeg ?? 0) + m.turnDeg) % 360 + 360) % 360
    if (Math.abs(turn) < 1e-6 || Math.abs(turn - 360) < 1e-6) delete copy.rotationDeg
    else copy.rotationDeg = Number(turn.toFixed(2))
  } else if (copy.kind === 'marker' || copy.kind === 'note') {
    Object.assign(copy, m.apply(copy))
    if (copy.kind === 'note') copy.w *= m.scale
  } else if (copy.kind === 'wall') {
    copy.thickness *= m.scale
  } else if (copy.kind === 'window') {
    copy.depth *= m.scale
  }
  return copy
}
