/**
 * Moving things as a group: the plain shift every drag and nudge is made of, and the align and
 * distribute commands every slide and drawing app has. Measured on each item's bounds, so a
 * box, a run and a marker line up by what you can see of them.
 */
import type { Pt } from '../geom.ts'
import { adopt } from '../generate.ts'
import { isPositioned, pointsOf, type BoxItem, type Item } from '../model/types.ts'
import { itemBounds } from '../render/bounds.ts'

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

/** Lines every item up on one edge or centre line of the group's combined bounds. */
export function alignItems(items: Item[], edge: AlignEdge): void {
  if (items.length < 2) return
  const bounds = items.map(itemBounds)
  const left = Math.min(...bounds.map((b) => b.x))
  const right = Math.max(...bounds.map((b) => b.x + b.w))
  const top = Math.min(...bounds.map((b) => b.y))
  const bottom = Math.max(...bounds.map((b) => b.y + b.h))
  items.forEach((item, i) => {
    const b = bounds[i]
    switch (edge) {
      case 'left': return shiftItem(item, left - b.x, 0)
      case 'right': return shiftItem(item, right - (b.x + b.w), 0)
      case 'centre': return shiftItem(item, (left + right) / 2 - (b.x + b.w / 2), 0)
      case 'top': return shiftItem(item, 0, top - b.y)
      case 'bottom': return shiftItem(item, 0, bottom - (b.y + b.h))
      case 'middle': return shiftItem(item, 0, (top + bottom) / 2 - (b.y + b.h / 2))
    }
  })
}

/**
 * Equal gaps between neighbours along one axis, the outermost two staying where they are - the
 * way Google Slides and Illustrator do it. The gap is between edges, not centres, so a big box
 * and two small ones still look evenly spaced; for markers, which have no size, that is the same
 * thing as even centres.
 */
export function distributeItems(items: Item[], axis: 'horizontal' | 'vertical'): void {
  if (items.length < 3) return
  const h = axis === 'horizontal'
  const entries = items
    .map((item) => {
      const b = itemBounds(item)
      return { item, start: h ? b.x : b.y, size: h ? b.w : b.h }
    })
    .sort((a, b) => a.start - b.start)
  const first = entries[0]
  const span = Math.max(...entries.map((e) => e.start + e.size)) - first.start
  const gap = (span - entries.reduce((sum, e) => sum + e.size, 0)) / (entries.length - 1)
  let at = first.start
  for (const e of entries) {
    const d = at - e.start
    if (Math.abs(d) > 1e-9) shiftItem(e.item, h ? d : 0, h ? 0 : d)
    at += e.size + gap
  }
}
