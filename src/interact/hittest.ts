import { closestOnPolyline, closestOnSegment, dist, polygonEdges, rectContains, rectsIntersect, segmentIntersectsRect, type Pt, type Rect } from '../geom.ts'
import type { Store, VertexRef } from '../model/doc.ts'
import { pointsOf, type BoxItem, type Item } from '../model/types.ts'
import { noteHeight } from '../render/notes.ts'
import { boxCorners, itemBounds } from '../render/bounds.ts'

/** Draw order is boxes → runs → markers, so we test back to front. */
function topmost(items: Item[], p: Pt, tol: number): Item | null {
  for (const kind of ['note', 'marker', 'run', 'door', 'box', 'room'] as const) {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].kind === kind && hitsItem(items[i], p, tol)) return items[i]
    }
  }
  return null
}

/** Topmost item under `p` that can actually be selected and edited. */
export function hitTest(store: Store, p: Pt, tol: number): Item | null {
  return topmost(store.items().filter((i) => store.isEditable(i)), p, tol)
}

/**
 * Topmost item under `p` that is visible but locked - either itself or through its system.
 * Only used to explain why a click did nothing; a click that silently does nothing reads as
 * a broken app.
 */
export function hitTestLocked(store: Store, p: Pt, tol: number): Item | null {
  return topmost(store.items().filter((i) => store.isVisible(i) && !store.isEditable(i)), p, tol)
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
    case 'note':
      return rectContains({ x: item.x, y: item.y, w: item.w, h: noteHeight(item) }, p)
    case 'door':
      return closestOnPolyline(p, item.points).dist <= tol * 1.4
    case 'room': {
      // The outline is the grab target; the middle is not, or a room would swallow every
      // click inside it and you could never select the pipes you drew across it.
      if (item.points.length < 3) return false
      for (const [a, b] of polygonEdges(item.points)) {
        if (closestOnSegment(p, a, b).dist <= tol) return true
      }
      return false
    }
  }
}

/** Vertex handles are only live for selected runs, so ordinary clicks never grab one. */
export function hitVertex(store: Store, p: Pt, tol: number): VertexRef | null {
  for (const item of store.selectedItems()) {
    if (!store.isEditable(item)) continue
    const points = pointsOf(item)
    if (!points) continue
    for (let i = 0; i < points.length; i++) {
      if (dist(points[i], p) <= tol) return { itemId: item.id, index: i }
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
  const points = pointsOf(item)
  if (!points || points.length < 2) return null
  // A room is closed, so the edge from the last corner back to the first is a real edge and
  // you should be able to add a corner on it like any other.
  const path = item.kind === 'room' ? [...points, points[0]] : points
  const r = closestOnPolyline(p, path)
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
    const points = pointsOf(item)
    if (points) return points.some((pt) => rectContains(rect, pt)) || rectsIntersect(rect, itemBounds(item))
    if (item.kind === 'marker') return rectContains(rect, { x: item.x, y: item.y })
    return rectsIntersect(rect, itemBounds(item))
  })
}

export interface NoteHandleRef { noteId: string }

/** The one resize handle a note has: bottom-right, and it only changes the width. */
export function hitNoteHandle(store: Store, p: Pt, tol: number): NoteHandleRef | null {
  for (const item of store.selectedItems()) {
    if (item.kind !== 'note' || !store.isEditable(item)) continue
    const corner = { x: item.x + item.w, y: item.y + noteHeight(item) }
    if (dist(corner, p) <= tol) return { noteId: item.id }
  }
  return null
}

export function nearestPointOnItem(item: Item, p: Pt): { point: Pt; dist: number } | null {
  if (item.kind === 'room' && item.points.length >= 3) {
    let best: { point: Pt; dist: number } | null = null
    for (const [a, b] of polygonEdges(item.points)) {
      const r = closestOnSegment(p, a, b)
      if (!best || r.dist < best.dist) best = { point: r.point, dist: r.dist }
    }
    return best
  }
  const line = pointsOf(item)
  if (line && line.length >= 2) {
    const r = closestOnPolyline(p, line)
    return { point: r.point, dist: r.dist }
  }
  if (item.kind === 'box' || item.kind === 'note') {
    const rect = item.kind === 'box'
      ? { x: item.x, y: item.y, w: item.w, h: item.h }
      : { x: item.x, y: item.y, w: item.w, h: noteHeight(item) }
    const corners: Pt[] = [
      { x: rect.x, y: rect.y },
      { x: rect.x + rect.w, y: rect.y },
      { x: rect.x + rect.w, y: rect.y + rect.h },
      { x: rect.x, y: rect.y + rect.h },
    ]
    let best: { point: Pt; dist: number } | null = null
    for (let i = 0; i < 4; i++) {
      const r = closestOnSegment(p, corners[i], corners[(i + 1) % 4])
      if (!best || r.dist < best.dist) best = { point: r.point, dist: r.dist }
    }
    return best
  }
  return null
}
