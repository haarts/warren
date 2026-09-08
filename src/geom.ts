// Pure geometry helpers. World units are PDF points (1/72 inch) unless noted.

export interface Pt { x: number; y: number }

export const pt = (x: number, y: number): Pt => ({ x, y })

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

/** Squared distance from p to segment ab, plus the closest point and its parameter t. */
export function closestOnSegment(p: Pt, a: Pt, b: Pt): { point: Pt; t: number; dist: number } {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const point = { x: a.x + t * dx, y: a.y + t * dy }
  return { point, t, dist: dist(p, point) }
}

/** Distance from p to a polyline, with the index of the nearest segment. */
export function closestOnPolyline(p: Pt, points: Pt[]): { dist: number; index: number; point: Pt; t: number } {
  let best = { dist: Infinity, index: 0, point: points[0] ?? p, t: 0 }
  for (let i = 0; i < points.length - 1; i++) {
    const r = closestOnSegment(p, points[i], points[i + 1])
    if (r.dist < best.dist) best = { dist: r.dist, index: i, point: r.point, t: r.t }
  }
  return best
}

export function polylineLength(points: Pt[]): number {
  let total = 0
  for (let i = 0; i < points.length - 1; i++) total += dist(points[i], points[i + 1])
  return total
}

/** Constrain `p` to lie on a ray from `anchor` at a multiple of `stepDeg` degrees. */
export function orthoConstrain(anchor: Pt, p: Pt, stepDeg = 45): Pt {
  const dx = p.x - anchor.x
  const dy = p.y - anchor.y
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return { ...p }
  const step = (stepDeg * Math.PI) / 180
  const angle = Math.round(Math.atan2(dy, dx) / step) * step
  // Project onto the snapped ray rather than rotating, so the cursor stays "ahead" of the point.
  const ux = Math.cos(angle)
  const uy = Math.sin(angle)
  const proj = dx * ux + dy * uy
  return { x: anchor.x + ux * proj, y: anchor.y + uy * proj }
}

export interface Rect { x: number; y: number; w: number; h: number }

export function normalizeRect(a: Pt, b: Pt): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }
}

export function rectContains(r: Rect, p: Pt): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return !(b.x > a.x + a.w || b.x + b.w < a.x || b.y > a.y + a.h || b.y + b.h < a.y)
}

/** Does segment ab intersect axis-aligned rect r? Used for rubber-band selection. */
export function segmentIntersectsRect(a: Pt, b: Pt, r: Rect): boolean {
  if (rectContains(r, a) || rectContains(r, b)) return true
  const corners: Pt[] = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ]
  for (let i = 0; i < 4; i++) {
    if (segmentsIntersect(a, b, corners[i], corners[(i + 1) % 4])) return true
  }
  return false
}

function cross(o: Pt, a: Pt, b: Pt): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
}

export function segmentsIntersect(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d1 = cross(p3, p4, p1)
  const d2 = cross(p3, p4, p2)
  const d3 = cross(p1, p2, p3)
  const d4 = cross(p1, p2, p4)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true
  return false
}

export function boundsOf(points: Pt[]): Rect {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** Walk a polyline emitting a position + direction every `spacing` units. */
export function walkPolyline(points: Pt[], spacing: number, offset = 0): { p: Pt; angle: number }[] {
  const out: { p: Pt; angle: number }[] = []
  if (points.length < 2 || spacing <= 0) return out
  let next = offset
  let travelled = 0
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    const segLen = dist(a, b)
    if (segLen < 1e-9) continue
    const angle = Math.atan2(b.y - a.y, b.x - a.x)
    while (next <= travelled + segLen) {
      const t = (next - travelled) / segLen
      out.push({ p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, angle })
      next += spacing
      if (out.length > 4000) return out
    }
    travelled += segLen
  }
  return out
}

/** Point at a given fraction along the polyline, with direction. Used for label placement. */
export function pointAtFraction(points: Pt[], fraction: number): { p: Pt; angle: number } {
  const total = polylineLength(points)
  if (points.length < 2 || total === 0) return { p: points[0] ?? { x: 0, y: 0 }, angle: 0 }
  const target = total * Math.max(0, Math.min(1, fraction))
  let travelled = 0
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    const segLen = dist(a, b)
    if (travelled + segLen >= target) {
      const t = segLen === 0 ? 0 : (target - travelled) / segLen
      return {
        p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
        angle: Math.atan2(b.y - a.y, b.x - a.x),
      }
    }
    travelled += segLen
  }
  const a = points[points.length - 2]
  const b = points[points.length - 1]
  return { p: b, angle: Math.atan2(b.y - a.y, b.x - a.x) }
}

export function roundTo(value: number, step: number): number {
  return step > 0 ? Math.round(value / step) * step : value
}
