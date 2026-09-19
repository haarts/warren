import type { Pt } from '../geom.ts'
import type { Store } from '../model/doc.ts'
import type { Item } from '../model/types.ts'
import type { Camera } from './camera.ts'

/**
 * Everything a painter needs to draw one frame. Every painter in this directory takes one of
 * these plus the item it is drawing, instead of repeating (ctx, store, cam, ui) on every
 * signature. `inFocus` replaces what used to be a module-level mutable set: the render pass is
 * one frame at a time, so it is computed once by `drawScene` and threaded through from here.
 */
export interface DrawCtx {
  ctx: CanvasRenderingContext2D
  store: Store
  cam: Camera
  /** Multiplies label/handle sizes. 1 on screen; the export scale when rasterising. */
  ui: number
  /** Items in the focused room, or null when nothing is focused (nothing dimmed). */
  inFocus: Set<string> | null
  /** Whether this is an on-screen, editable view - false for an export or print render. */
  interactive: boolean
}

/** What an out-of-focus item is drawn in: present, plainly context, not competing. */
export const DIMMED = '#c3c9d2'
export const ACCENT = '#0b63d6'
export const HANDLE_FILL = '#ffffff'

export const isDimmed = (dc: DrawCtx, item: Item): boolean =>
  dc.inFocus !== null && !dc.inFocus.has(item.id)

export interface StrokeStyle { color: string; dash: number[]; width: number }

export function strokeStyleFor(dc: DrawCtx, item: Item): StrokeStyle {
  const sys = dc.store.system(item.systemId)
  return {
    color: isDimmed(dc, item) ? DIMMED : item.colorOverride ?? sys.color,
    dash: sys.dash,
    width: sys.width,
  }
}

export function applyStroke(dc: DrawCtx, style: StrokeStyle): void {
  const { ctx, cam } = dc
  ctx.strokeStyle = style.color
  ctx.lineWidth = Math.max(1.1, style.width * cam.zoom)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.setLineDash(style.dash.map((d) => Math.max(1, d * cam.zoom)))
}

export function screenPoints(cam: Camera, points: Pt[]): Pt[] {
  return points.map((p) => cam.toScreen(p))
}
