/**
 * Moving things as a group: the plain shift every drag and nudge is made of, and the align and
 * distribute commands every slide and drawing app has. Measured on each item's bounds, so a
 * box, a run and a marker line up by what you can see of them.
 */
import { boundsOf, type Pt, type Rect } from '../geom.ts'
import { adopt } from '../generate.ts'
import { isPositioned, pointsOf, type BoxItem, type Item } from '../model/types.ts'
import { boxCorners, itemBounds } from '../render/bounds.ts'

/**
 * Move an item by a delta, whatever shape it is made of, measured from `from`'s coordinates -
 * which defaults to the item's own (a live nudge) but can be an earlier snapshot (a drag, so
 * the delta is measured from where the gesture started, not accumulated frame to frame).
 */
export function shiftItem(item: Item, dx: number, dy: number, from: Item = item): void {
  adopt(item)
  const points = pointsOf(from)
  if (points) (item as { points: Pt[] }).points = points.map((p) => ({ x: p.x + dx, y: p.y + dy }))
  else if (isPositioned(from) && isPositioned(item)) { item.x = from.x + dx; item.y = from.y + dy }
}

/** Sets a box's turn, kept in [0, 360) and dropped altogether when it is square again. */
export function setBoxRotation(box: BoxItem, deg: number): void {
  const d = ((deg % 360) + 360) % 360
  if (Math.abs(d) < 1e-6 || Math.abs(d - 360) < 1e-6) delete box.rotationDeg
  else box.rotationDeg = Number(d.toFixed(2))
}

export const ALIGN_EDGES = ['left', 'centre', 'right', 'top', 'middle', 'bottom'] as const
export type AlignEdge = (typeof ALIGN_EDGES)[number]

/**
 * The direction a selection of runs shares, in radians, when they all run the same way within
 * a few degrees - folded into (-45°, 45°] so "horizontal" stays the axis nearer the screen's
 * horizontal. Null when there are no runs or they point different ways. Square runs give 0,
 * which is the drawing's own frame; diagonal ones give their angle, so aligning and spacing
 * them happens along and across them rather than along a page edge they do not follow.
 */
export function runAxis(items: Item[]): number | null {
  const angles: number[] = []
  for (const item of items) {
    if (item.kind !== 'run' || item.points.length < 2) continue
    let best = 0
    let angle = 0
    for (let i = 0; i < item.points.length - 1; i++) {
      const a = item.points[i]
      const b = item.points[i + 1]
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      if (len > best) { best = len; angle = Math.atan2(b.y - a.y, b.x - a.x) }
    }
    angles.push(fold(angle))
  }
  if (angles.length === 0) return null
  const ref = angles[0]
  const tol = (3 * Math.PI) / 180
  // Compared as directions: -44° and 44° are 88° apart, but 44° and -46° (folded to 44°) agree.
  const near = (a: number): boolean => Math.abs(fold(a - ref)) <= tol
  return angles.every(near) ? ref : null
}

/** An angle as a direction, folded into (-45°, 45°]. */
function fold(rad: number): number {
  const q = Math.PI / 2
  let a = ((rad % q) + q) % q
  if (a > q / 2) a -= q
  return a
}

/** Every point an item's outline is made of - enough to bound it in a turned frame. */
function outlinePoints(item: Item): Pt[] {
  const points = pointsOf(item)
  if (points) return points
  if (item.kind === 'box') return boxCorners(item)
  const b = itemBounds(item)
  return [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }]
}

/** An item's bounds in a frame turned by `angle`, and a shift in that frame turned back to the page. */
function frame(angle: number): { bounds: (item: Item) => Rect; shift: (item: Item, dx: number, dy: number) => void } {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return {
    bounds: (item) => boundsOf(outlinePoints(item).map((p) => ({ x: p.x * cos + p.y * sin, y: -p.x * sin + p.y * cos }))),
    shift: (item, dx, dy) => shiftItem(item, dx * cos - dy * sin, dx * sin + dy * cos),
  }
}

/**
 * Lines every item up on one edge or centre line of the group's combined bounds. `angle` turns
 * the frame that is measured in - see `runAxis`; 0 is the page.
 */
export function alignItems(items: Item[], edge: AlignEdge, angle = 0): void {
  if (items.length < 2) return
  const f = frame(angle)
  const bounds = items.map(f.bounds)
  const left = Math.min(...bounds.map((b) => b.x))
  const right = Math.max(...bounds.map((b) => b.x + b.w))
  const top = Math.min(...bounds.map((b) => b.y))
  const bottom = Math.max(...bounds.map((b) => b.y + b.h))
  items.forEach((item, i) => {
    const b = bounds[i]
    switch (edge) {
      case 'left': return f.shift(item, left - b.x, 0)
      case 'right': return f.shift(item, right - (b.x + b.w), 0)
      case 'centre': return f.shift(item, (left + right) / 2 - (b.x + b.w / 2), 0)
      case 'top': return f.shift(item, 0, top - b.y)
      case 'bottom': return f.shift(item, 0, bottom - (b.y + b.h))
      case 'middle': return f.shift(item, 0, (top + bottom) / 2 - (b.y + b.h / 2))
    }
  })
}

/**
 * Equal gaps between neighbours along one axis, the outermost two staying where they are - the
 * way Google Slides and Illustrator do it. The gap is between edges, not centres, so a big box
 * and two small ones still look evenly spaced; for markers, which have no size, that is the same
 * thing as even centres. With `fixedGap`, the first stays put and every gap is exactly that.
 */
export function distributeItems(items: Item[], axis: 'horizontal' | 'vertical', angle = 0, fixedGap?: number): void {
  if (items.length < (fixedGap === undefined ? 3 : 2)) return
  const h = axis === 'horizontal'
  const f = frame(angle)
  const entries = items
    .map((item) => {
      const b = f.bounds(item)
      return { item, start: h ? b.x : b.y, size: h ? b.w : b.h }
    })
    .sort((a, b) => a.start - b.start)
  const first = entries[0]
  const span = Math.max(...entries.map((e) => e.start + e.size)) - first.start
  const gap = fixedGap ?? (span - entries.reduce((sum, e) => sum + e.size, 0)) / (entries.length - 1)
  let at = first.start
  for (const e of entries) {
    const d = at - e.start
    if (Math.abs(d) > 1e-9) f.shift(e.item, h ? d : 0, h ? 0 : d)
    at += e.size + gap
  }
}

/**
 * Which way is "across" a set of runs sharing `angle`'s frame: the axis they do not run along.
 * Runs nearer horizontal than vertical are spaced vertically, and the other way round.
 */
export function acrossAxis(items: Item[], angle: number): 'horizontal' | 'vertical' {
  const run = items.find((i) => i.kind === 'run' && i.points.length >= 2)
  if (!run || run.kind !== 'run') return 'vertical'
  const f = frame(angle)
  const b = f.bounds(run)
  return b.w >= b.h ? 'vertical' : 'horizontal'
}
