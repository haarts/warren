/**
 * Another floor, drawn faintly under this one through the alignment: its plan and what is drawn
 * on it. The point is the check - walls, stairs and shafts that land on each other say the two
 * floors are aligned - and then the use: a riser from below shows where to carry on up here.
 */
import type { FloorMapping } from '../align.ts'
import type { Sheet } from '../model/types.ts'
import { boxCorners } from './bounds.ts'
import type { DrawCtx } from './draw.ts'

export interface GhostLayer {
  sheet: Sheet
  /** From the ghost sheet's points to this one's. */
  mapping: FloorMapping
  background: CanvasImageSource | null
  backgroundSize: { w: number; h: number } | null
}

const GHOST_PLAN_ALPHA = 0.28
const GHOST_ITEM_ALPHA = 0.4

const tints = new WeakMap<CanvasImageSource, CanvasImageSource>()

/**
 * The other floor's plan, tinted so it never reads as part of this one. Done once per raster:
 * a canvas filter over a whole page on every frame is what a pan would otherwise pay for.
 * Browsers without canvas filters just get it faint and grey.
 */
function tinted(source: CanvasImageSource): CanvasImageSource {
  const cached = tints.get(source)
  if (cached) return cached
  const { width, height } = source as HTMLCanvasElement
  const out = document.createElement('canvas')
  out.width = width
  out.height = height
  const c = out.getContext('2d')
  if (!c) return source
  c.filter = 'sepia(1) hue-rotate(170deg) saturate(3)'
  c.drawImage(source, 0, 0)
  tints.set(source, out)
  return out
}

export function drawGhost(dc: DrawCtx, ghost: GhostLayer): void {
  const { ctx, cam, store, ui } = dc
  const m = ghost.mapping
  // Where the ghost's origin and unit axes land on this sheet: that is the whole affine map.
  const o = m.apply({ x: 0, y: 0 })
  const ex = m.apply({ x: 1, y: 0 })
  const ey = m.apply({ x: 0, y: 1 })
  ctx.save()
  ctx.transform(cam.zoom, 0, 0, cam.zoom, -cam.x * cam.zoom, -cam.y * cam.zoom)
  ctx.transform(ex.x - o.x, ex.y - o.y, ey.x - o.x, ey.y - o.y, o.x, o.y)
  // One screen pixel, in the ghost's own units.
  const px = 1 / (cam.zoom * m.scale)

  if (ghost.background && ghost.backgroundSize) {
    ctx.save()
    ctx.globalAlpha = GHOST_PLAN_ALPHA
    ctx.globalCompositeOperation = 'multiply'
    ctx.drawImage(tinted(ghost.background), 0, 0, ghost.backgroundSize.w, ghost.backgroundSize.h)
    ctx.restore()
  }

  ctx.globalAlpha = GHOST_ITEM_ALPHA
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const item of ghost.sheet.items) {
    const sys = store.system(item.systemId)
    if (!sys.visible) continue
    ctx.strokeStyle = sys.color
    ctx.fillStyle = sys.color
    if (item.kind === 'run' || item.kind === 'wall') {
      if (item.points.length < 2) continue
      ctx.lineWidth = (item.kind === 'run' ? 2 : 1) * px * ui
      ctx.setLineDash(item.kind === 'run' ? [] : [4 * px, 3 * px])
      ctx.beginPath()
      ctx.moveTo(item.points[0].x, item.points[0].y)
      for (const p of item.points.slice(1)) ctx.lineTo(p.x, p.y)
      ctx.stroke()
    } else if (item.kind === 'box') {
      const c = boxCorners(item)
      ctx.lineWidth = 1.2 * px * ui
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.moveTo(c[0].x, c[0].y)
      for (const p of c.slice(1)) ctx.lineTo(p.x, p.y)
      ctx.closePath()
      ctx.stroke()
    } else if (item.kind === 'marker') {
      const riser = item.symbol === 'riser-up' || item.symbol === 'riser-down'
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.arc(item.x, item.y, (riser ? 6 : 2.5) * px * ui, 0, Math.PI * 2)
      if (riser) {
        // A riser is what you came up here to find: a ring, not a speck.
        ctx.lineWidth = 2 * px * ui
        ctx.stroke()
      } else ctx.fill()
    }
  }
  ctx.restore()
}
