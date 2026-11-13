import { dist, orthoConstrain, roundTo, thickOutline, type Pt } from '../geom.ts'
import type { Store } from '../model/doc.ts'
import { isPositioned, pointsOf } from '../model/types.ts'
import { boxCorners } from '../render/bounds.ts'
import { nearestPointOnItem } from './hittest.ts'

export interface SnapResult {
  point: Pt
  label: string | null
}

export interface SnapOptions {
  /**
   * The item we are currently dragging, so a point never snaps to itself - a run vertex only
   * excludes its own index (the rest of the run is still a valid target), while a positioned
   * item (marker/note) excludes its whole point, since moving it *is* moving that one point.
   */
  excludeRunId?: string
  excludeIndex?: number
  /** When drawing, the previous point - enables ortho lock with Shift. */
  anchor?: Pt | null
  ortho?: boolean
  /** False skips item-snapping for this call regardless of F3 - used while dragging a shape
   * or group, where it would snap the cursor, not the shape. Unset (or true) means F3 rules. */
  itemSnap?: boolean
  /** Offer the run-spacing guides beside existing runs - for drawing a run or moving its corner. */
  spacing?: boolean
}

/**
 * Snapping order matters. A vertex snap always wins over ortho, because attaching a branch to
 * an existing run is the thing you actually care about getting exact; a slightly off-axis
 * segment is cosmetic, a disconnected branch is a mistake.
 */
export function resolvePoint(store: Store, raw: Pt, tolWorld: number, opts: SnapOptions = {}): SnapResult {
  const settings = store.project.settings
  const snapItems = (opts.itemSnap ?? true) && settings.snapToItems

  const gap = snapItems && opts.spacing ? spacingGap(store, tolWorld) : null

  if (snapItems) {
    const vertex = snapToVertices(store, raw, tolWorld, opts, gap)
    if (vertex) return vertex
  }

  let p = raw
  if (opts.ortho && opts.anchor) {
    p = orthoConstrain(opts.anchor, raw, 45)
  }

  if (gap !== null) {
    const beside = snapBeside(store, p, tolWorld, gap, opts)
    if (beside) return beside
  }

  if (snapItems) {
    const edge = snapToEdges(store, p, tolWorld * 0.7, opts)
    if (edge) return edge
  }

  if (settings.snapToGrid && store.sheet.mmPerPoint) {
    const step = settings.gridMm / store.sheet.mmPerPoint
    const g = { x: roundTo(p.x, step), y: roundTo(p.y, step) }
    if (dist(g, p) <= tolWorld) return { point: g, label: 'grid' }
  }

  return { point: p, label: null }
}

interface Candidate { point: Pt; d: number; label: string }

/**
 * The run spacing in points - or null when it is off, the sheet has no scale, or the gap is too
 * small on screen to aim at. Zoomed out, a 50 mm gap is a pixel or two, and a guide there would
 * only stop you landing on the run you meant to join.
 */
export function spacingGap(store: Store, tolWorld: number): number | null {
  const mm = store.project.settings.runSpacingMm
  const mmPerPoint = store.sheet.mmPerPoint
  if (!mm || !mmPerPoint) return null
  const gap = mm / mmPerPoint
  return gap >= tolWorld * (4 / 11) ? gap : null
}

const unit = (a: Pt, b: Pt): Pt | null => {
  const d = dist(a, b)
  return d > 1e-9 ? { x: (b.x - a.x) / d, y: (b.y - a.y) / d } : null
}
/** Left-hand normal of a direction, on screen (y down). */
const normal = (u: Pt): Pt => ({ x: u.y, y: -u.x })

/**
 * Where a run drawn `gap` beside this one would put its corners and ends: mitred at a corner,
 * square at an end - both sides. Offered as snap points next to the run's own vertices, so a
 * parallel run turns its corner beside the other's rather than on top of it.
 */
function besidePoints(points: Pt[], gap: number): { point: Pt; label: string }[] {
  const out: { point: Pt; label: string }[] = []
  for (let i = 0; i < points.length; i++) {
    const inDir = i > 0 ? unit(points[i - 1], points[i]) : null
    const outDir = i < points.length - 1 ? unit(points[i], points[i + 1]) : null
    const p = points[i]
    if (inDir && outDir) {
      const n1 = normal(inDir)
      const n2 = normal(outDir)
      const k = 1 + n1.x * n2.x + n1.y * n2.y
      if (k < 0.2) continue // a hairpin: the mitre runs off to infinity
      for (const side of [1, -1]) {
        out.push({ point: { x: p.x + (side * gap * (n1.x + n2.x)) / k, y: p.y + (side * gap * (n1.y + n2.y)) / k }, label: 'beside corner' })
      }
    } else {
      const u = inDir ?? outDir
      if (!u) continue
      const n = normal(u)
      for (const side of [1, -1]) out.push({ point: { x: p.x + side * gap * n.x, y: p.y + side * gap * n.y }, label: 'beside end' })
    }
  }
  return out
}

/**
 * A point on the line `gap` beside an existing run segment, when the cursor is near that line
 * - between half the gap and a snap tolerance past it. Closer than half the gap is still "on the
 * run", which the edge snap after this handles. While drawing, only segments roughly parallel
 * to the one being drawn count: a run crossing another is not running beside it.
 */
function snapBeside(store: Store, p: Pt, tol: number, gap: number, opts: SnapOptions): SnapResult | null {
  const along = opts.anchor && dist(opts.anchor, p) > gap ? unit(opts.anchor, p) : null
  let best: { point: Pt; miss: number } | null = null
  for (const item of store.items()) {
    if (item.kind !== 'run' || !store.isVisible(item) || item.id === opts.excludeRunId) continue
    for (let i = 0; i < item.points.length - 1; i++) {
      const a = item.points[i]
      const u = unit(a, item.points[i + 1])
      if (!u) continue
      if (along && Math.abs(along.x * u.y - along.y * u.x) > Math.sin((12 * Math.PI) / 180)) continue
      const len = dist(a, item.points[i + 1])
      const t = (p.x - a.x) * u.x + (p.y - a.y) * u.y
      if (t < -gap || t > len + gap) continue
      const n = normal(u)
      const d = (p.x - a.x) * n.x + (p.y - a.y) * n.y
      const r = Math.abs(d)
      if (r < gap / 2 || r > gap + tol) continue
      const miss = Math.abs(r - gap)
      if (best && miss >= best.miss) continue
      const side = Math.sign(d)
      best = { point: { x: p.x + (side * gap - d) * n.x, y: p.y + (side * gap - d) * n.y }, miss }
    }
  }
  return best ? { point: best.point, label: `beside run · ${store.project.settings.runSpacingMm} mm` } : null
}

function snapToVertices(store: Store, raw: Pt, tol: number, opts: SnapOptions, gap: number | null = null): SnapResult | null {
  let best: Candidate | null = null
  const consider = (point: Pt, label: string): void => {
    const d = dist(point, raw)
    if (d <= tol && (best === null || d < best.d)) best = { point: { ...point }, d, label }
  }
  for (const item of store.items()) {
    if (!store.isVisible(item)) continue
    const points = pointsOf(item)
    if (item.kind === 'wall' && item.id !== opts.excludeRunId) {
      // The corners of its faces, where things meet a wall - and its centreline points, so
      // one wall can be joined to the next while editing either.
      for (const c of thickOutline(item.points, item.thickness / 2)) consider(c, 'wall corner')
    }
    if (gap !== null && item.kind === 'run' && item.id !== opts.excludeRunId) {
      for (const b of besidePoints(item.points, gap)) consider(b.point, b.label)
    }
    if (points) {
      for (let i = 0; i < points.length; i++) {
        if (item.id === opts.excludeRunId && i === opts.excludeIndex) continue
        const isEnd = item.kind === 'run' && (i === 0 || i === points.length - 1)
        consider(points[i], isEnd ? 'end' : 'corner')
      }
    } else if (item.kind === 'box') {
      for (const c of boxCorners(item)) consider(c, 'corner')
      consider({ x: item.x + item.w / 2, y: item.y + item.h / 2 }, 'centre')
    } else if (isPositioned(item)) {
      if (item.id === opts.excludeRunId) continue
      consider({ x: item.x, y: item.y }, 'marker')
    }
  }
  const found = best as Candidate | null
  return found ? { point: found.point, label: found.label } : null
}

function snapToEdges(store: Store, p: Pt, tol: number, opts: SnapOptions): SnapResult | null {
  let best: { point: Pt; d: number; label: string } | null = null
  for (const item of store.items()) {
    if (!store.isVisible(item)) continue
    if (item.id === opts.excludeRunId) continue
    const r = nearestPointOnItem(item, p)
    if (r && r.dist <= tol && (best === null || r.dist < best.d)) {
      best = { point: r.point, d: r.dist, label: item.kind === 'wall' ? 'on wall face' : 'on run' }
    }
  }
  const found = best as { point: Pt; d: number; label: string } | null
  return found ? { point: found.point, label: found.label } : null
}
