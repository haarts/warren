/** World-space bounds and corners for the item shapes that aren't already a list of points. */
import { boundsOf, type Pt, type Rect } from '../geom.ts'
import { pointsOf, type BoxItem, type Item } from '../model/types.ts'
import { noteHeight } from './notes.ts'

/** World-space bounding box of an item, for framing, culling and rubber-band selection. */
export function itemBounds(item: Item): Rect {
  const points = pointsOf(item)
  if (item.kind === 'wall' || item.kind === 'window') {
    const b = boundsOf(item.points)
    const t = item.kind === 'wall' ? item.thickness : item.depth
    return { x: b.x - t / 2, y: b.y - t / 2, w: b.w + t, h: b.h + t }
  }
  if (points) return boundsOf(points)
  if (item.kind === 'box') return { x: item.x, y: item.y, w: item.w, h: item.h }
  if (item.kind === 'note') return { x: item.x, y: item.y, w: item.w, h: noteHeight(item) }
  if (item.kind === 'marker') return { x: item.x, y: item.y, w: 0, h: 0 }
  return { x: 0, y: 0, w: 0, h: 0 }
}

export function boxCorners(box: BoxItem): Pt[] {
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ]
}
