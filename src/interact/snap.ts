import { dist, orthoConstrain, roundTo, type Pt } from '../geom.ts'
import type { Store } from '../model/doc.ts'
import { boxCorners } from '../render/scene.ts'
import { nearestPointOnItem } from './hittest.ts'

export interface SnapResult {
  point: Pt
  label: string | null
}

export interface SnapOptions {
  /** Vertex/segment we are currently dragging, so a point never snaps to itself. */
  excludeRunId?: string
  excludeIndex?: number
  /** When drawing, the previous point - enables ortho lock with Shift. */
  anchor?: Pt | null
  ortho?: boolean
}

/**
 * Snapping order matters. A vertex snap always wins over ortho, because attaching a branch to
 * an existing run is the thing you actually care about getting exact; a slightly off-axis
 * segment is cosmetic, a disconnected branch is a mistake.
 */
export function resolvePoint(store: Store, raw: Pt, tolWorld: number, opts: SnapOptions = {}): SnapResult {
  const settings = store.project.settings

  if (settings.snapToItems) {
    const vertex = snapToVertices(store, raw, tolWorld, opts)
    if (vertex) return vertex
  }

  let p = raw
  if (opts.ortho && opts.anchor) {
    p = orthoConstrain(opts.anchor, raw, 45)
  }

  if (settings.snapToItems) {
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

function snapToVertices(store: Store, raw: Pt, tol: number, opts: SnapOptions): SnapResult | null {
  let best: Candidate | null = null
  const consider = (point: Pt, label: string): void => {
    const d = dist(point, raw)
    if (d <= tol && (best === null || d < best.d)) best = { point: { ...point }, d, label }
  }
  for (const item of store.items()) {
    if (!store.isVisible(item)) continue
    if (item.kind === 'run') {
      for (let i = 0; i < item.points.length; i++) {
        if (item.id === opts.excludeRunId && i === opts.excludeIndex) continue
        const isEnd = i === 0 || i === item.points.length - 1
        consider(item.points[i], isEnd ? 'end' : 'corner')
      }
    } else if (item.kind === 'box') {
      for (const c of boxCorners(item)) consider(c, 'corner')
      consider({ x: item.x + item.w / 2, y: item.y + item.h / 2 }, 'centre')
    } else {
      consider({ x: item.x, y: item.y }, 'marker')
    }
  }
  const found = best as Candidate | null
  return found ? { point: found.point, label: found.label } : null
}

function snapToEdges(store: Store, p: Pt, tol: number, opts: SnapOptions): SnapResult | null {
  let best: { point: Pt; d: number } | null = null
  for (const item of store.items()) {
    if (!store.isVisible(item)) continue
    if (item.kind === 'run' && item.id === opts.excludeRunId) continue
    const r = nearestPointOnItem(item, p)
    if (r && r.dist <= tol && (best === null || r.dist < best.d)) best = { point: r.point, d: r.dist }
  }
  const found = best as { point: Pt; d: number } | null
  return found ? { point: found.point, label: 'on run' } : null
}
