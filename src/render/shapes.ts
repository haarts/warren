/** The closed and near-closed shapes traced off the plan: equipment boxes, rooms, doors. */
import { dist } from '../geom.ts'
import type { BoxItem, DoorItem, RoomItem } from '../model/types.ts'
import { applyStroke, DIMMED, isDimmed, screenPoints, strokeStyleFor, type DrawCtx } from './draw.ts'

/** An equipment footprint: a filled, outlined rectangle. */
export function drawBox(dc: DrawCtx, box: BoxItem): void {
  const { ctx, cam } = dc
  const style = strokeStyleFor(dc, box)
  const x = cam.toScreenX(box.x)
  const y = cam.toScreenY(box.y)
  const w = box.w * cam.zoom
  const h = box.h * cam.zoom
  ctx.save()
  ctx.fillStyle = style.color
  ctx.globalAlpha = 0.14
  ctx.fillRect(x, y, w, h)
  ctx.globalAlpha = 1
  applyStroke(dc, style)
  ctx.strokeRect(x, y, w, h)
  ctx.restore()
}

/** A traced room outline: a faint fill, a dashed edge, no fixed colour of its own. */
export function drawRoom(dc: DrawCtx, room: RoomItem): void {
  if (room.points.length < 3) return
  const { ctx, cam, store } = dc
  const color = isDimmed(dc, room) ? DIMMED : room.colorOverride ?? store.system(room.systemId).color
  const pts = screenPoints(cam, room.points)
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.globalAlpha = 0.05
  ctx.fill()
  ctx.globalAlpha = 0.65
  ctx.strokeStyle = color
  ctx.lineWidth = Math.max(1, 1.1 * cam.zoom)
  ctx.setLineDash([Math.max(2, 5 * cam.zoom), Math.max(2, 4 * cam.zoom)])
  ctx.stroke()
  ctx.restore()
}

/** The architect's door symbol: the opening, the leaf from the hinge, and its swing. */
export function drawDoor(dc: DrawCtx, door: DoorItem): void {
  if (door.points.length < 2) return
  const { ctx, cam, store, ui } = dc
  const color = isDimmed(dc, door) ? DIMMED : door.colorOverride ?? store.system(door.systemId).color
  const hinge = door.points[0]
  const strike = door.points[1]
  const width = dist(hinge, strike) * cam.zoom
  if (width < 2) return
  const h = cam.toScreen(hinge)
  const st = cam.toScreen(strike)
  const angle = Math.atan2(st.y - h.y, st.x - h.x)

  ctx.save()
  ctx.setLineDash([])
  ctx.strokeStyle = color
  ctx.lineWidth = Math.max(1.2, store.system(door.systemId).width * cam.zoom)
  // The opening itself.
  ctx.beginPath()
  ctx.moveTo(h.x, h.y)
  ctx.lineTo(st.x, st.y)
  ctx.stroke()

  // The leaf, swung a quarter turn, and the arc it sweeps.
  const swept = angle + (door.swing * Math.PI) / 2
  ctx.beginPath()
  ctx.moveTo(h.x, h.y)
  ctx.lineTo(h.x + Math.cos(swept) * width, h.y + Math.sin(swept) * width)
  ctx.stroke()
  ctx.globalAlpha = 0.45
  ctx.lineWidth = Math.max(0.8, 0.8 * cam.zoom)
  ctx.beginPath()
  ctx.arc(h.x, h.y, width, Math.min(angle, swept), Math.max(angle, swept))
  ctx.stroke()
  ctx.globalAlpha = 1

  // A dot on the hinge, so which end is which is readable at a glance.
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(h.x, h.y, Math.max(1.5, 2 * ui), 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}
