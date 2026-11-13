/** The closed and near-closed shapes traced off the plan: equipment boxes, rooms, doors, walls, windows. */
import { dist, thickOutline } from '../geom.ts'
import type { BoxItem, DoorItem, RoomItem, WallItem, WindowItem } from '../model/types.ts'
import { boxCentre, boxRotation } from './bounds.ts'
import { applyStroke, DIMMED, isDimmed, screenPoints, strokeStyleFor, type DrawCtx } from './draw.ts'

/** An equipment footprint: a filled, outlined rectangle. */
export function drawBox(dc: DrawCtx, box: BoxItem): void {
  const { ctx, cam } = dc
  const style = strokeStyleFor(dc, box)
  const w = box.w * cam.zoom
  const h = box.h * cam.zoom
  const c = cam.toScreen(boxCentre(box))
  ctx.save()
  // Drawn about its centre, so the turn and the unturned case are the same code.
  ctx.translate(c.x, c.y)
  ctx.rotate(boxRotation(box))
  const x = -w / 2
  const y = -h / 2
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

/**
 * A wall, drawn to its real thickness. Existing walls are solid, the way the architect inks a
 * wall that is already standing; new ones are hatched, so what is being built reads apart from
 * what is there at a glance.
 */
export function drawWall(dc: DrawCtx, wall: WallItem): void {
  if (wall.points.length < 2) return
  const { ctx, cam, ui } = dc
  const style = strokeStyleFor(dc, wall)
  const outline = screenPoints(cam, thickOutline(wall.points, wall.thickness / 2))
  // The path is not part of the saved state, so it is traced afresh after the hatching.
  const trace = (): void => {
    ctx.beginPath()
    ctx.moveTo(outline[0].x, outline[0].y)
    for (let i = 1; i < outline.length; i++) ctx.lineTo(outline[i].x, outline[i].y)
    ctx.closePath()
  }
  ctx.save()
  trace()
  ctx.fillStyle = style.color
  ctx.globalAlpha = wall.status === 'existing' ? 0.55 : 0.12
  ctx.fill()
  if (wall.status === 'new') {
    // Hatching at a fixed spacing on screen, clipped to the wall.
    ctx.save()
    ctx.clip()
    ctx.globalAlpha = 0.6
    ctx.strokeStyle = style.color
    ctx.lineWidth = Math.max(0.6, 0.8 * ui)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of outline) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y) }
    const step = Math.max(4, 6 * ui)
    ctx.beginPath()
    for (let x = minX - (maxY - minY); x < maxX; x += step) {
      ctx.moveTo(x, maxY)
      ctx.lineTo(x + (maxY - minY), minY)
    }
    ctx.stroke()
    ctx.restore()
  }
  trace()
  ctx.globalAlpha = 0.9
  ctx.strokeStyle = style.color
  ctx.lineWidth = Math.max(0.8, 1 * ui)
  ctx.setLineDash([])
  ctx.stroke()
  ctx.restore()
}

/**
 * The architect's window: the frame as a rectangle across the wall, knocked out of whatever wall
 * is drawn under it, with the glass as a double line down the middle.
 */
export function drawWindow(dc: DrawCtx, win: WindowItem): void {
  if (win.points.length < 2) return
  const { ctx, cam, ui } = dc
  const [a, b] = win.points
  const len = dist(a, b)
  if (len * cam.zoom < 2) return
  const style = strokeStyleFor(dc, win)
  // Unit along the opening and across it, in world units.
  const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len }
  const n = { x: -u.y, y: u.x }
  const at = (p: { x: number; y: number }, across: number) => cam.toScreen({ x: p.x + n.x * across, y: p.y + n.y * across })
  const half = win.depth / 2
  const frame = [at(a, -half), at(b, -half), at(b, half), at(a, half)]
  const line = (across: number): void => {
    const p = at(a, across)
    const q = at(b, across)
    ctx.moveTo(p.x, p.y)
    ctx.lineTo(q.x, q.y)
  }
  ctx.save()
  ctx.setLineDash([])
  ctx.beginPath()
  ctx.moveTo(frame[0].x, frame[0].y)
  for (let i = 1; i < frame.length; i++) ctx.lineTo(frame[i].x, frame[i].y)
  ctx.closePath()
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.fillStyle = style.color
  ctx.globalAlpha = 0.12
  ctx.fill()
  ctx.globalAlpha = 1
  ctx.strokeStyle = style.color
  ctx.lineWidth = Math.max(0.8, 1 * ui)
  ctx.stroke()
  // The glass: two lines a sixth of the depth either side of the middle.
  ctx.beginPath()
  line(-win.depth / 6)
  line(win.depth / 6)
  ctx.stroke()
  ctx.restore()
}
