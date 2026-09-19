// A direction is one bearing with as many names as people actually use for it. Warren never
// interprets what "street" or "north" means - it only ever compares a stored bearing to
// geometry that already exists in the drawing. See model/types.ts for the shape.
//
// A project gets its directions from two places: the four tips of its compass rose, and a short
// list of one-off bearings the rose does not cover. There is one set for the whole project -
// every sheet is drawn the same way round, or nothing that passes between floors would line
// up. Everything below reads both through `directionsOf`, so the browser and the command line
// can never disagree about what is set.
import type { Pt } from './geom.ts'
import type { CompassRose, Direction, Project } from './model/types.ts'

/** Whatever carries a project's orientation - the project itself, or a bare stand-in in tests. */
export type Oriented = Pick<Project, 'compass' | 'directions'>

/** A direction as found on the project, and where it came from. */
export interface ProjectDirection extends Direction {
  /** 'compass' for a rose tip (with `tip` 0-3), 'list' for a one-off bearing. */
  source: 'compass' | 'list'
  tip?: number
}

/** "north, noord , straatzijde" -> ['north', 'noord', 'straatzijde'] */
export function splitNames(text: string): string[] {
  return text.split(',').map((s) => s.trim()).filter(Boolean)
}

/** Bearing of a rose's tip `i` (0-3): its rotation, plus a quarter-turn per tip. */
export function tipBearing(rose: CompassRose, i: number): number {
  return (((rose.rotationDeg + i * 90) % 360) + 360) % 360
}

/** The four tips of the rose that have a name, as directions. An unnamed tip names nothing. */
export function compassDirections(project: Oriented): ProjectDirection[] {
  const rose = project.compass
  if (!rose) return []
  const out: ProjectDirection[] = []
  rose.tips.forEach((text, tip) => {
    const aliases = splitNames(text)
    if (aliases.length === 0) return
    out.push({ id: slugifyDirectionId(aliases[0]), bearingDeg: tipBearing(rose, tip), aliases, source: 'compass', tip })
  })
  return out
}

/** Every direction in the project: the rose's tips first, then the one-off list. */
export function directionsOf(project: Oriented): ProjectDirection[] {
  return [
    ...compassDirections(project),
    ...(project.directions ?? []).map((d): ProjectDirection => ({ ...d, source: 'list' })),
  ]
}

/** The point `distance` away from `from` along `bearingDeg`. */
export function alongBearing(from: Pt, bearingDeg: number, distance: number): Pt {
  const rad = (bearingDeg * Math.PI) / 180
  return { x: from.x + Math.sin(rad) * distance, y: from.y - Math.cos(rad) * distance }
}

/**
 * Degrees clockwise from "up" (this sheet's -y) to the vector from `from` to `to`, in
 * [0, 360). This is the same convention a person reads off a plan's own north arrow: an arrow
 * pointing straight up is 0, pointing right is 90, and so on - regardless of whether "up" here
 * happens to be true north.
 */
export function bearingBetween(from: Pt, to: Pt): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (dx === 0 && dy === 0) return 0
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI
  return (deg + 360) % 360
}

/** The signed difference from a to b, in (-180, 180] - positive means b is clockwise of a. */
export function angleDiff(a: number, b: number): number {
  let d = (b - a) % 360
  if (d > 180) d -= 360
  if (d <= -180) d += 360
  return d
}

/**
 * Find the direction a term resolves to, case-insensitively - by id first, then by any alias.
 * Exact match wins; a substring match is the fallback, same convention as room-name lookup, so
 * "street" still finds a direction aliased "street side" without demanding the whole phrase.
 */
export function resolveDirection(project: Oriented, term: string): ProjectDirection | null {
  const list = directionsOf(project)
  const needle = term.trim().toLowerCase()
  if (!needle) return null
  const names = (d: Direction) => [d.id, ...d.aliases].map((s) => s.toLowerCase())
  const exact = list.find((d) => names(d).includes(needle))
  if (exact) return exact
  return list.find((d) => names(d).some((n) => n.includes(needle) || needle.includes(n))) ?? null
}

/**
 * Does `to`, seen from `from`, lie in the named direction? `toleranceDeg` is the half-width of
 * the sector either side of the bearing (default 45°, i.e. a quarter-turn wide) - loose on
 * purpose, since "toward the street" was never a precise angle to begin with.
 */
export function isToward(
  project: Oriented, from: Pt, to: Pt, term: string, toleranceDeg = 45,
): boolean | null {
  const dir = resolveDirection(project, term)
  if (!dir) return null
  return Math.abs(angleDiff(dir.bearingDeg, bearingBetween(from, to))) <= toleranceDeg
}

/** A point `distance` away from `from`, along the named direction's bearing. */
export function pointToward(project: Oriented, from: Pt, term: string, distance: number): Pt | null {
  const dir = resolveDirection(project, term)
  if (!dir) return null
  return alongBearing(from, dir.bearingDeg, distance)
}

/** Turns whatever a person typed ("Street side!") into a stable id ("street-side"). */
export function slugifyDirectionId(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug || 'direction'
}

const COMPASS_16 = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
]

/** A short human label for a bearing, purely for display - "NE", not a claim about true north. */
export function compassLabel(bearingDeg: number): string {
  const i = Math.round(((bearingDeg % 360) + 360) % 360 / 22.5) % 16
  return COMPASS_16[i]
}
