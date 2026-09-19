import { alongBearing, tipBearing } from '../directions.ts'
import type { CompassRose } from '../model/types.ts'
import { ACCENT, type DrawCtx } from './draw.ts'

/** Which part of the compass rose is meant: a tip (0-3) turns it, the hub moves it. */
export type CompassPart = { part: 'tip'; tip: number } | { part: 'hub' }

/**
 * Screen radius of the compass rose. Fixed like a marker, so it reads at any zoom. Exported
 * from `scene.ts` too, for `test/browser/smoke.mjs`, which imports it from that path.
 */
export const COMPASS_RADIUS_PX = 46

const ROSE_INK = '#334155'
const ROSE_TIP_ONE = '#b91c1c'

/**
 * Four long arms a quarter-turn apart, four short ones between them for the look of the thing,
 * and each long arm's names written just past its tip. Tip 1 is picked out in red, because it
 * is the one the rotation is measured by. The numbered discs are the drag handles, so they
 * only appear on screen, never in an export.
 */
export function drawCompass(dc: DrawCtx, rose: CompassRose, active: CompassPart | null): void {
  const { ctx, cam, ui, interactive } = dc
  const c = cam.toScreen(rose)
  const R = COMPASS_RADIUS_PX * ui
  const half = 6 * ui
  const arm = (bearing: number, length: number, color: string): void => {
    const tip = alongBearing(c, bearing, length)
    const left = alongBearing(c, bearing - 90, half * (length / R))
    const right = alongBearing(c, bearing + 90, half * (length / R))
    // Two halves, one filled and one pale: the classic rose, readable as a direction at a glance.
    ctx.fillStyle = color
    ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(tip.x, tip.y); ctx.lineTo(left.x, left.y); ctx.closePath(); ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(tip.x, tip.y); ctx.lineTo(right.x, right.y); ctx.closePath(); ctx.fill()
    ctx.strokeStyle = color
    ctx.lineWidth = 1 * ui
    ctx.beginPath(); ctx.moveTo(left.x, left.y); ctx.lineTo(tip.x, tip.y); ctx.lineTo(right.x, right.y); ctx.lineTo(c.x, c.y); ctx.closePath(); ctx.stroke()
  }

  ctx.save()
  ctx.setLineDash([])
  ctx.globalAlpha = 0.9
  ctx.strokeStyle = ROSE_INK
  ctx.lineWidth = 1 * ui
  ctx.beginPath()
  ctx.arc(c.x, c.y, R * 0.62, 0, Math.PI * 2)
  ctx.stroke()
  for (let i = 0; i < 4; i++) arm(tipBearing(rose, i) + 45, R * 0.48, ROSE_INK)
  for (let i = 3; i >= 0; i--) arm(tipBearing(rose, i), R, i === 0 ? ROSE_TIP_ONE : ROSE_INK)
  ctx.globalAlpha = 1

  // The hub: the move handle.
  const hubHot = active?.part === 'hub'
  ctx.fillStyle = hubHot ? ACCENT : '#ffffff'
  ctx.strokeStyle = hubHot ? ACCENT : ROSE_INK
  ctx.lineWidth = 1.5 * ui
  ctx.beginPath()
  ctx.arc(c.x, c.y, 3.5 * ui, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()

  ctx.font = `600 ${11 * ui}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`
  for (let i = 0; i < 4; i++) {
    const bearing = tipBearing(rose, i)
    const tip = alongBearing(c, bearing, R)
    if (interactive) {
      const hot = active?.part === 'tip' && active.tip === i
      ctx.fillStyle = hot ? ACCENT : '#ffffff'
      ctx.strokeStyle = hot ? ACCENT : i === 0 ? ROSE_TIP_ONE : ROSE_INK
      ctx.lineWidth = 1.5 * ui
      ctx.beginPath()
      ctx.arc(tip.x, tip.y, 7 * ui, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = hot ? '#ffffff' : ROSE_INK
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(i + 1), tip.x, tip.y + 0.5 * ui)
    }

    const names = rose.tips[i]
    if (!names) continue
    const at = alongBearing(c, bearing, R + 11 * ui)
    const rad = (bearing * Math.PI) / 180
    const ux = Math.sin(rad)
    const uy = -Math.cos(rad)
    // Hang the text off the side of the point it belongs to, whichever way the rose is turned.
    ctx.textAlign = ux > 0.38 ? 'left' : ux < -0.38 ? 'right' : 'center'
    ctx.textBaseline = uy > 0.38 ? 'top' : uy < -0.38 ? 'bottom' : 'middle'
    ctx.lineJoin = 'round'
    ctx.lineWidth = 3.5 * ui
    ctx.strokeStyle = '#ffffff'
    ctx.strokeText(names, at.x, at.y)
    ctx.fillStyle = i === 0 ? ROSE_TIP_ONE : ROSE_INK
    ctx.fillText(names, at.x, at.y)
  }
  ctx.restore()
}
