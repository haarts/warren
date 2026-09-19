/**
 * The compass rose - one per project, shown on every sheet - plus the one-off bearings it does
 * not cover and the two commands (calibrate, name a direction) that turn a two-point click into
 * a fact recorded on the project rather than an item on the sheet.
 */
import { dist, type Pt } from '../geom.ts'
import { HIT_TOL_PX } from './hittest.ts'
import { COMPASS_RADIUS_PX, type CompassPart } from '../render/compass.ts'
import { alongBearing, slugifyDirectionId, splitNames, tipBearing } from '../directions.ts'
import type { Editor } from './editor.ts'

/**
 * The rose is drawn at a fixed size on screen, like a marker, so what counts as "on a tip" is
 * measured in pixels and converted - otherwise it would be ungrabbable when zoomed out.
 */
export function hitCompass(ed: Editor, world: Pt): CompassPart | null {
  const rose = ed.store.project.compass
  if (!rose) return null
  const centre = { x: rose.x, y: rose.y }
  const tol = ed.tol(HIT_TOL_PX)
  const radius = COMPASS_RADIUS_PX / ed.cam.zoom
  for (let tip = 0; tip < 4; tip++) {
    if (dist(alongBearing(centre, tipBearing(rose, tip), radius), world) <= tol * 1.3) return { part: 'tip', tip }
  }
  if (dist(centre, world) <= tol * 1.3) return { part: 'hub' }
  return null
}

/** The rose part currently being dragged, or - failing that - hovered. Shared by the overlay
 * (what to highlight) and the cursor (what shape to show). */
export function compassPart(ed: Editor): CompassPart | null {
  return ed.drag.mode === 'compassTurn' ? { part: 'tip', tip: ed.drag.tip }
    : ed.drag.mode === 'compassMove' ? { part: 'hub' }
    : ed.hover.compass
}

/**
 * Drops a compass rose in the middle of whatever is on screen, pointing straight up. There is
 * one for the whole project, shown on every sheet at the same spot: asking again just brings it
 * into view - which is also the way back if a page of another size leaves it off the edge.
 */
export function placeCompass(ed: Editor): void {
  const existing = ed.store.project.compass
  if (existing) {
    ed.cam.x = existing.x - ed.cssWidth / 2 / ed.cam.zoom
    ed.cam.y = existing.y - ed.cssHeight / 2 / ed.cam.zoom
    ed.flash('The project already has a compass rose — it is in the middle of the view now')
    return
  }
  const centre = ed.cam.toWorld(ed.cssWidth / 2, ed.cssHeight / 2)
  ed.edit(
    'Compass rose placed — drag a tip to turn it, drag the centre to move it, name the tips in Properties',
    () => { ed.store.project.compass = { x: centre.x, y: centre.y, rotationDeg: 0, tips: ['', '', '', ''] } },
  )
}

/** What tip `tip` (0-3) is called, comma-separated as typed. */
export function nameCompassTip(ed: Editor, tip: number, names: string): void {
  const rose = ed.store.project.compass
  if (!rose || tip < 0 || tip > 3) return
  const text = splitNames(names).join(', ')
  if (rose.tips[tip] === text) return
  ed.edit(null, () => { rose.tips[tip] = text })
}

/** Types an exact rotation instead of dragging one. */
export function turnCompass(ed: Editor, rotationDeg: number): void {
  const rose = ed.store.project.compass
  if (!rose || !isFinite(rotationDeg)) return
  const next = ((rotationDeg % 360) + 360) % 360
  if (next === rose.rotationDeg) return
  ed.edit(null, () => { rose.rotationDeg = next })
}

export function removeCompass(ed: Editor): void {
  if (!ed.store.project.compass) return
  ed.edit(null, () => { delete ed.store.project.compass })
  ed.hover.compass = null
}

export function removeDirection(ed: Editor, id: string): void {
  ed.edit(null, () => {
    const list = ed.store.project.directions
    if (!list) return
    ed.store.project.directions = list.filter((d) => d.id !== id)
    if (ed.store.project.directions.length === 0) delete ed.store.project.directions
  })
}

export function applyCalibration(ed: Editor, realMm: number): void {
  if (ed.measurePts.length !== 2 || realMm <= 0) return
  const lengthPt = dist(ed.measurePts[0], ed.measurePts[1])
  if (lengthPt < 1e-6) return
  const mmPerPoint = realMm / lengthPt
  ed.measurePts = []
  ed.edit(`Calibrated: 1 pt = ${mmPerPoint.toFixed(3)} mm`, () => { ed.store.sheet.mmPerPoint = mmPerPoint })
}

/**
 * `names` is whatever the person typed — comma-separated, e.g. "street, north, noord,
 * straatzijde". The first one becomes the stable id; all of them become aliases, so typing the
 * id back later still resolves. Re-using a name updates that direction's bearing instead of
 * adding a duplicate, so clicking again to fix a mistake just works.
 */
export function applyDirection(ed: Editor, bearingDeg: number, names: string): void {
  const aliases = splitNames(names)
  ed.measurePts = []
  if (aliases.length === 0) return
  const id = slugifyDirectionId(aliases[0])
  ed.edit(`Direction "${id}" set: ${aliases.join(', ')}`, () => {
    const list = ed.store.project.directions ?? (ed.store.project.directions = [])
    const existing = list.find((d) => d.id === id)
    if (existing) { existing.bearingDeg = bearingDeg; existing.aliases = aliases }
    else list.push({ id, bearingDeg, aliases })
  })
}
