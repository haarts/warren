import type { Pt, Rect } from '../geom.ts'

/** Maps world (PDF points) to screen (CSS pixels). screen = (world - offset) * zoom */
export class Camera {
  x = 0
  y = 0
  zoom = 1

  toScreenX(wx: number): number { return (wx - this.x) * this.zoom }
  toScreenY(wy: number): number { return (wy - this.y) * this.zoom }
  toScreen(p: Pt): Pt { return { x: (p.x - this.x) * this.zoom, y: (p.y - this.y) * this.zoom } }

  toWorld(sx: number, sy: number): Pt {
    return { x: sx / this.zoom + this.x, y: sy / this.zoom + this.y }
  }

  panByScreen(dx: number, dy: number): void {
    this.x -= dx / this.zoom
    this.y -= dy / this.zoom
  }

  /** Zoom keeping the world point under (sx, sy) fixed. */
  zoomAt(sx: number, sy: number, factor: number, min = 0.02, max = 60): void {
    const before = this.toWorld(sx, sy)
    this.zoom = Math.min(max, Math.max(min, this.zoom * factor))
    const after = this.toWorld(sx, sy)
    this.x += before.x - after.x
    this.y += before.y - after.y
  }

  fit(rect: Rect, viewW: number, viewH: number, padding = 24): void {
    if (rect.w <= 0 || rect.h <= 0 || viewW <= 0 || viewH <= 0) return
    const zoom = Math.min((viewW - padding * 2) / rect.w, (viewH - padding * 2) / rect.h)
    this.zoom = Math.max(0.02, zoom)
    this.x = rect.x + rect.w / 2 - viewW / 2 / this.zoom
    this.y = rect.y + rect.h / 2 - viewH / 2 / this.zoom
  }

  /** World rect currently visible, for cheap culling. */
  viewRect(viewW: number, viewH: number): Rect {
    const tl = this.toWorld(0, 0)
    const br = this.toWorld(viewW, viewH)
    return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y }
  }

  clone(): Camera {
    const c = new Camera()
    c.x = this.x
    c.y = this.y
    c.zoom = this.zoom
    return c
  }
}
