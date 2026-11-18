/** World-space bounds and corners for the item shapes that aren't already a list of points. */
import { boundsOf, rectContains, type Pt, type Rect } from '../geom.ts'
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
  if (item.kind === 'box') return boxRotation(item) ? boundsOf(boxCorners(item)) : { x: item.x, y: item.y, w: item.w, h: item.h }
  if (item.kind === 'note') return { x: item.x, y: item.y, w: item.w, h: noteHeight(item) }
  if (item.kind === 'marker') return { x: item.x, y: item.y, w: 0, h: 0 }
  return { x: 0, y: 0, w: 0, h: 0 }
}

/** A box's turn in radians, 0 when it has none. */
export function boxRotation(box: BoxItem): number {
  return ((box.rotationDeg ?? 0) * Math.PI) / 180
}

export function boxCentre(box: BoxItem): Pt {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 }
}

/** Turns `p` about `c` by `rad`, clockwise on screen (y points down). */
export function rotateAbout(p: Pt, c: Pt, rad: number): Pt {
  if (!rad) return { x: p.x, y: p.y }
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const dx = p.x - c.x
  const dy = p.y - c.y
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos }
}

/** The four corners as drawn - turned with the box - clockwise from the unturned top-left. */
export function boxCorners(box: BoxItem): Pt[] {
  const c = boxCentre(box)
  const rad = boxRotation(box)
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ].map((p) => rotateAbout(p, c, rad))
}

/** Where `p` falls in the box's own unturned frame, so a rectangle test still works. */
export function toBoxFrame(box: BoxItem, p: Pt): Pt {
  return rotateAbout(p, boxCentre(box), -boxRotation(box))
}

/** Whether `p` is on or inside the box, grown by `pad` on every side. */
export function boxContains(box: BoxItem, p: Pt, pad = 0): boolean {
  return rectContains({ x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 }, toBoxFrame(box, p))
}

/** Where the rotate handle sits: out past the middle of the top edge, whichever way that faces. */
export function boxRotateHandle(box: BoxItem, offset: number): Pt {
  const c = boxCentre(box)
  return rotateAbout({ x: c.x, y: box.y - offset }, c, boxRotation(box))
}

/** How far out past the top edge the rotate knob sits, in screen pixels. */
export const BOX_ROTATE_OFFSET_PX = 22
/** How far in front of a presence sensor its aim knob sits, in screen pixels. */
export const MARKER_AIM_OFFSET_PX = 30
