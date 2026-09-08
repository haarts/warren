import { closestOnPolyline, closestOnSegment, dist, rectContains, rectsIntersect, segmentIntersectsRect, type Pt, type Rect } from '../geom.ts'
import type { Store, VertexRef } from '../model/doc.ts'
import type { BoxItem, Item } from '../model/types.ts'
import { boxCorners, itemBounds } from '../render/scene.ts'

/** Topmost editable item under `p`. Draw order is boxes → runs → markers, so we test in reverse. */
export function hitTest(store: Store, p: Pt, tol: number): Item | null {
  const items = store.items().filter((i) => store.isEditable(i))
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === 'marker' && hitsItem(items[i], p, tol)) return items[i]
  }
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === 'run' && hitsItem(items[i], p, tol)) return items[i]
  }
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === 'box' && hitsItem(items[i], p, tol)) return items[i]
  }
  return null
}

export function hitsItem(item: Item, p: Pt, tol: number): boolean {
  switch (item.kind) {
    case 'run': {
      if (item.points.length === 1) return dist(item.points[0], p) <= tol
      return closestOnPolyline(p, item.points).dist <= tol
    }
    case 'box': {
      // Edges are the grab target; the interior counts too so small boxes stay clickable.
      const r = { x: item.x, y: item.y, w: item.w, h: item.h }
      if (rectContains({ x: r.x - tol, y: r.y - tol, w: r.w + tol * 2, h: r.h + tol * 2 }, p)) {
        const inner = { x: r.x + tol, y: r.y + tol, w: Math.max(0, r.w - tol * 2), h: Math.max(0, r.h - tol * 2) }
        if (!rectContains(inner, p)) return true
        return r.w * r.h < tol * tol * 400
      }
      return false
    }
    case 'marker':
      return dist({ x: item.x, y: item.y }, p) <= tol * 1.4
  }
}

/** Vertex handles are only live for selected runs, so ordinary clicks never grab one. */
export function hitVertex(store: Store, p: Pt, tol: number): VertexRef | null {
  for (const item of store.selectedItems()) {
    if (item.kind !== 'run' || !store.isEditable(item)) continue
    for (let i = 0; i < item.points.length; i++) {
      if (dist(item.points[i], p) <= tol) return { runId: item.id, index: i }
    }
  }
  return null
}

export interface BoxCornerRef { boxId: string; corner: number }

export function hitBoxCorner(store: Store, p: Pt, tol: number): BoxCornerRef | null {
  for (const item of store.selectedItems()) {
    if (item.kind !== 'box' || !store.isEditable(item)) continue
    const corners = boxCorners(item as BoxItem)
    for (let i = 0; i < corners.length; i++) {
      if (dist(corners[i], p) <= tol) return { boxId: item.id, corner: i }
    }
  }
  return null
}

/** Which segment of a run is under `p` - used to insert a vertex at the right place. */
export function hitSegment(item: Item, p: Pt, tol: number): { index: number; point: Pt } | null {
  if (item.kind !== 'run' || item.points.length < 2) return null
  const r = closestOnPolyline(p, item.points)
  if (r.dist > tol) return null
  return { index: r.index, point: r.point }
}

export function itemsInRect(store: Store, rect: Rect): Item[] {
  return store.items().filter((item) => {
    if (!store.isEditable(item)) return false
    if (item.kind === 'run') {
      if (item.points.some((pt) => rectContains(rect, pt))) return true
      for (let i = 0; i < item.points.length - 1; i++) {
        if (segmentIntersectsRect(item.points[i], item.points[i + 1], rect)) return true
      }
      return false
    }
    if (item.kind === 'marker') return rectContains(rect, { x: item.x, y: item.y })
    return rectsIntersect(rect, itemBounds(item))
  })
}

export function nearestPointOnItem(item: Item, p: Pt): { point: Pt; dist: number } | null {
  if (item.kind === 'run' && item.points.length >= 2) {
    const r = closestOnPolyline(p, item.points)
    return { point: r.point, dist: r.dist }
  }
  if (item.kind === 'box') {
    const corners = boxCorners(item as BoxItem)
    let best: { point: Pt; dist: number } | null = null
    for (let i = 0; i < 4; i++) {
      const r = closestOnSegment(p, corners[i], corners[(i + 1) % 4])
      if (!best || r.dist < best.dist) best = { point: r.point, dist: r.dist }
    }
    return best
  }
  return null
}
