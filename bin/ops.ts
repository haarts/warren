/**
 * The op planner: what `warren apply` validates and, if everything validates, does. Pulled out
 * of the apply command so `warren serve` can run the exact same checks against the project it is
 * holding — there must not be two ideas of what a valid op is.
 *
 * `planOps` never writes anything itself. It returns a plan — problems (if any), a description
 * of each op for `--dry-run`, and a list of thunks that make the change when called — so a
 * caller can validate everything before applying any of it.
 */
import type { Pt } from '../src/geom.ts'
import { closestOnSegment, polygonArea } from '../src/geom.ts'
import { adopt } from '../src/generate.ts'
import { newId } from '../src/model/ids.ts'
import type { Store } from '../src/model/doc.ts'
import { isPositioned, pointsOf, ROOM_USES, LEVELS, WALL_STATUSES, type Item, type WallItem, type WallStatus, type Level, type Project, type Sheet } from '../src/model/types.ts'
import { oneOf } from '../src/io/projectFile.ts'
import { aimIfUnset } from '../src/coverage.ts'
import type { MarkerItem } from '../src/model/types.ts'
import { findSheets, pointsFromMetres } from './units.ts'

export interface SetOp { op: 'set'; id: string; patch: Record<string, unknown> }
export interface DeleteOp { op: 'delete'; id: string }
export interface MoveOp { op: 'move'; id: string; byM?: [number, number]; byPt?: [number, number] }
export interface AddOp { op: 'add'; sheet?: string; item: Record<string, unknown> }
export type Op = SetOp | DeleteOp | MoveOp | AddOp

/** The kinds `add` knows how to build. Named once, so the manifest cannot promise more. */
export const ADDABLE_KINDS: Item['kind'][] = ['run', 'room', 'door', 'wall', 'window', 'box', 'marker', 'note']

export const PATCHABLE = new Set([
  'systemId', 'level', 'label', 'size', 'flow', 'slope', 'note', 'text', 'extraM', 'colorOverride',
  'locked', 'symbol', 'name', 'use', 'ref', 'swing', 'status', 'thicknessM', 'depthM', 'pointsM', 'rotationDeg',
  'aimDeg', 'fovDeg', 'rangeM',
])

export interface Plan {
  problems: string[]
  describe: string[]
  planned: (() => void)[]
}

/** What one op handler shares: the sheet+item it targets (id-based ops only), and where to
 *  report success or failure. */
interface Ctx {
  project: Project
  store: Store
  systemIds: Set<string>
  stamp: { rule: string; from: string } | null
  target?: { sheet: Sheet; item: Item }
  at: string
  problems: string[]
  describe: string[]
  planned: (() => void)[]
}

/**
 * A presence sensor's view from an op - aimDeg, fovDeg and rangeM - checked, with the range in
 * points. Null when something is wrong, after saying what.
 */
function readView(raw: Record<string, unknown>, sheet: Sheet, at: string, problems: string[]): Partial<Pick<MarkerItem, 'aimDeg' | 'fovDeg' | 'range'>> | null {
  const view: Partial<Pick<MarkerItem, 'aimDeg' | 'fovDeg' | 'range'>> = {}
  if (raw.aimDeg !== undefined) {
    if (typeof raw.aimDeg !== 'number' || !isFinite(raw.aimDeg)) return void problems.push(`${at}: aimDeg must be a number of degrees, clockwise from up the page`), null
    view.aimDeg = ((raw.aimDeg % 360) + 360) % 360
  }
  if (raw.fovDeg !== undefined) {
    if (typeof raw.fovDeg !== 'number' || !(raw.fovDeg > 0) || raw.fovDeg > 360) return void problems.push(`${at}: fovDeg must be a number of degrees above 0 and up to 360`), null
    view.fovDeg = raw.fovDeg
  }
  if (raw.rangeM !== undefined) {
    if (typeof raw.rangeM !== 'number' || !(raw.rangeM > 0)) return void problems.push(`${at}: rangeM must be a positive number of metres`), null
    const range = pointsFromMetres(sheet, raw.rangeM)
    if (range === null) return void problems.push(`${at}: sheet "${sheet.name}" has no scale, so rangeM means nothing here`), null
    view.range = range
  }
  return view
}

function doSet(op: SetOp, ctx: Ctx): void {
  const { target, at, systemIds, stamp, problems, describe, planned } = ctx
  const bad = Object.keys(op.patch ?? {}).filter((k) => !PATCHABLE.has(k))
  if (bad.length) return void problems.push(`${at}: cannot set ${bad.join(', ')} — patchable fields are ${[...PATCHABLE].join(', ')}`)
  if (typeof op.patch.systemId === 'string' && !systemIds.has(op.patch.systemId)) {
    return void problems.push(`${at}: systemId "${op.patch.systemId}" is not in this project's catalogue`)
  }
  if (typeof op.patch.level === 'string' && !LEVELS.includes(op.patch.level as Level)) {
    return void problems.push(`${at}: level "${op.patch.level}" is not one of ${LEVELS.join(', ')}`)
  }
  const { thicknessM, depthM, pointsM, aimDeg, fovDeg, rangeM, ...patch } = op.patch as Record<string, unknown>
  let view: ReturnType<typeof readView> = {}
  if (aimDeg !== undefined || fovDeg !== undefined || rangeM !== undefined) {
    if (target!.item.kind !== 'marker') return void problems.push(`${at}: aimDeg, fovDeg and rangeM are for presence markers; ${op.id} is a ${target!.item.kind}`)
    view = readView({ aimDeg, fovDeg, rangeM }, target!.sheet, at, problems)
    if (!view) return
  }
  let thickness: number | null = null
  let depth: number | null = null
  let points: Pt[] | null = null
  if (pointsM !== undefined) {
    // The whole outline, replaced: the way to straighten a wall or move one corner of a room
    // without deleting the item and losing its id.
    const kind = target!.item.kind
    if (!pointsOf(target!.item)) return void problems.push(`${at}: pointsM is for items with an outline; ${op.id} is a ${kind} — use move`)
    const exact = kind === 'door' || kind === 'window'
    const least = kind === 'room' ? 3 : 2
    if (!Array.isArray(pointsM) || pointsM.length < least || (exact && pointsM.length !== 2)) {
      return void problems.push(`${at}: a ${kind} takes ${exact ? 'exactly 2' : `at least ${least}`} points`)
    }
    points = []
    for (const pair of pointsM as unknown[]) {
      const [mx, my] = Array.isArray(pair) ? pair : []
      if (typeof mx !== 'number' || typeof my !== 'number') return void problems.push(`${at}: pointsM is [[x, y], ...] in metres`)
      const x = pointsFromMetres(target!.sheet, mx)
      const y = pointsFromMetres(target!.sheet, my)
      if (x === null || y === null) return void problems.push(`${at}: sheet "${target!.sheet.name}" has no scale, so pointsM mean nothing here`)
      points.push({ x, y })
    }
  }
  if ('rotationDeg' in patch) {
    if (target!.item.kind !== 'box') return void problems.push(`${at}: rotationDeg is for boxes; ${op.id} is a ${target!.item.kind}`)
    if (typeof patch.rotationDeg !== 'number' || !isFinite(patch.rotationDeg)) return void problems.push(`${at}: rotationDeg must be a number of degrees`)
  }
  if (depthM !== undefined) {
    if (target!.item.kind !== 'window') return void problems.push(`${at}: depthM is for windows; ${op.id} is a ${target!.item.kind}`)
    if (typeof depthM !== 'number' || !(depthM > 0)) return void problems.push(`${at}: depthM must be a positive number of metres`)
    depth = pointsFromMetres(target!.sheet, depthM)
    if (depth === null) return void problems.push(`${at}: sheet "${target!.sheet.name}" has no scale, so depthM means nothing here`)
  }
  if ('status' in patch || thicknessM !== undefined) {
    if (target!.item.kind !== 'wall') return void problems.push(`${at}: status and thicknessM are for walls; ${op.id} is a ${target!.item.kind}`)
  }
  if ('status' in patch && !WALL_STATUSES.includes(patch.status as WallStatus)) {
    return void problems.push(`${at}: status must be one of ${WALL_STATUSES.join(', ')}`)
  }
  if (thicknessM !== undefined) {
    if (typeof thicknessM !== 'number' || !(thicknessM > 0)) return void problems.push(`${at}: thicknessM must be a positive number of metres`)
    thickness = pointsFromMetres(target!.sheet, thicknessM)
    if (thickness === null) return void problems.push(`${at}: sheet "${target!.sheet.name}" has no scale, so thicknessM means nothing here`)
  }
  describe.push(`${at}: ${Object.keys(op.patch).join(', ')} on ${op.id}`)
  planned.push(() => {
    Object.assign(target!.item, patch)
    if (points) (target!.item as { points: Pt[] }).points = points
    if (thickness !== null && target!.item.kind === 'wall') target!.item.thickness = thickness
    if (depth !== null && target!.item.kind === 'window') target!.item.depth = depth
    if (target!.item.kind === 'marker') {
      Object.assign(target!.item, view)
      aimIfUnset(target!.item, target!.sheet)
    }
    claim(target!.item, stamp)
  })
}

/**
 * The wall a window's two jambs both sit in: within its thickness of one straight stretch of its
 * centreline. A window is one straight opening, so a corner between the jambs does not count.
 */
function hostWall(sheet: Sheet, a: Pt, b: Pt): WallItem | null {
  for (const item of sheet.items) {
    if (item.kind !== 'wall') continue
    const reach = item.thickness / 2 + 0.5
    for (let i = 0; i + 1 < item.points.length; i++) {
      const [p, q] = [item.points[i], item.points[i + 1]]
      if (closestOnSegment(a, p, q).dist <= reach && closestOnSegment(b, p, q).dist <= reach) return item
    }
  }
  return null
}

/**
 * Who an edited item belongs to afterwards. An edit by a person claims machine output, so a later
 * `generate` never quietly undoes it. An edit made `--as` someone is still unreviewed: an item
 * nobody has looked at yet stays that way, now stamped with whoever changed it last, rather than
 * turning solid as if a person had approved it. A person's own item stays theirs either way.
 */
function claim(item: Item, stamp: Ctx['stamp']): void {
  if (stamp && item.kind === 'marker' && item.generated) item.generated = { ...stamp }
  else adopt(item)
}

function doDelete(op: DeleteOp, ctx: Ctx): void {
  const { target, at, describe, planned } = ctx
  describe.push(`${at}: delete ${target!.item.kind} ${op.id}`)
  planned.push(() => {
    target!.sheet.items = target!.sheet.items.filter((i) => i.id !== op.id)
  })
}

function doMove(op: MoveOp, ctx: Ctx): void {
  const { target, at, stamp, problems, describe, planned } = ctx
  let delta: Pt | null = null
  if (op.byPt) delta = { x: op.byPt[0], y: op.byPt[1] }
  else if (op.byM) {
    const x = pointsFromMetres(target!.sheet, op.byM[0])
    const y = pointsFromMetres(target!.sheet, op.byM[1])
    if (x === null || y === null) return void problems.push(`${at}: sheet "${target!.sheet.name}" has no scale, so metres mean nothing here`)
    delta = { x, y }
  }
  if (!delta) return void problems.push(`${at}: needs byM or byPt`)
  describe.push(`${at}: move ${op.id}`)
  planned.push(() => {
    const item = target!.item
    const points = pointsOf(item)
    if (points) (item as { points: Pt[] }).points = points.map((p) => ({ x: p.x + delta.x, y: p.y + delta.y }))
    else if (isPositioned(item)) { item.x += delta.x; item.y += delta.y }
    claim(item, stamp)
  })
}

function doAdd(op: AddOp, ctx: Ctx): void {
  const { project, store, at, systemIds, stamp, problems, describe, planned } = ctx
  const sheets = findSheets(project, op.sheet)
  if (sheets.length === 0) return void problems.push(`${at}: no sheet matching "${String(op.sheet)}"`)
  const sheet = sheets[0]
  const raw = op.item ?? {}
  if (typeof raw.systemId !== 'string' || !systemIds.has(raw.systemId)) {
    return void problems.push(`${at}: item.systemId must be one of this project's systems`)
  }
  const level = oneOf(LEVELS, raw.level, 'wall')
  const shaped = raw.kind === 'run' || raw.kind === 'room' || raw.kind === 'door' || raw.kind === 'wall' || raw.kind === 'window'
  if (shaped) {
    const source = Array.isArray(raw.pointsM) ? raw.pointsM : Array.isArray(raw.points) ? raw.points : null
    const least = raw.kind === 'room' ? 3 : 2
    if (!source || source.length < least) {
      return void problems.push(`${at}: a ${raw.kind} needs at least ${least} points`)
    }
    const inMetres = Array.isArray(raw.pointsM)
    const points: Pt[] = []
    for (const pair of source as [number, number][]) {
      const x = inMetres ? pointsFromMetres(sheet, pair[0]) : pair[0]
      const y = inMetres ? pointsFromMetres(sheet, pair[1]) : pair[1]
      if (x === null || y === null) return void problems.push(`${at}: sheet "${sheet.name}" has no scale, so pointsM mean nothing here`)
      points.push({ x, y })
    }
    let thickness = 0
    if (raw.kind === 'wall') {
      if (typeof raw.thicknessM !== 'number' || !(raw.thicknessM > 0)) {
        return void problems.push(`${at}: a wall needs thicknessM, its full thickness in metres`)
      }
      thickness = pointsFromMetres(sheet, raw.thicknessM) as number
      if (raw.status !== undefined && !WALL_STATUSES.includes(raw.status as WallStatus)) {
        return void problems.push(`${at}: status must be one of ${WALL_STATUSES.join(', ')}`)
      }
    }
    let depth = 0
    if (raw.kind === 'window') {
      if (source.length !== 2) return void problems.push(`${at}: a window is exactly 2 points, one jamb then the other`)
      if (raw.depthM !== undefined) {
        if (typeof raw.depthM !== 'number' || !(raw.depthM > 0)) return void problems.push(`${at}: depthM must be a positive number of metres`)
        depth = pointsFromMetres(sheet, raw.depthM) as number
      } else {
        const host = hostWall(sheet, points[0], points[1])
        if (!host) {
          return void problems.push(`${at}: a window needs depthM, or both jambs on the centreline of a wall already in the drawing to take its thickness from`)
        }
        depth = host.thickness
      }
    }
    if (raw.kind === 'room' && typeof raw.expectM2 === 'number') {
      // The architect prints the area on the plan, so a traced outline can check itself.
      const got = Math.abs(polygonArea(points)) * ((sheet.mmPerPoint ?? 0) / 1000) ** 2
      const off = Math.abs(got - raw.expectM2) / raw.expectM2
      if (off > 0.08) {
        return void problems.push(
          `${at}: "${raw.name}" traces to ${got.toFixed(1)} m² but the plan says ${raw.expectM2} m² — ${(off * 100).toFixed(0)}% out`)
      }
    }
    describe.push(`${at}: add ${raw.kind} ${raw.name ?? raw.label ?? ''} of ${points.length} points to ${sheet.name}`.replace(/\s+/g, ' '))
    planned.push(() => {
      if (raw.kind === 'room') {
        sheet.items.push({
          kind: 'room', id: newId('room'), systemId: raw.systemId as string, level, points,
          name: String(raw.name ?? 'Room'),
          use: oneOf(ROOM_USES, raw.use, 'other'),
          ...(typeof raw.ref === 'string' ? { ref: raw.ref } : {}),
        })
      } else if (raw.kind === 'wall') {
        sheet.items.push({
          kind: 'wall', id: newId('wall'), systemId: raw.systemId as string, level, points, thickness,
          status: (raw.status as WallStatus | undefined) ?? 'existing',
          ...(typeof raw.ref === 'string' ? { ref: raw.ref } : {}),
          ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
          ...(typeof raw.note === 'string' && raw.note ? { note: raw.note } : {}),
        })
      } else if (raw.kind === 'window') {
        sheet.items.push({
          kind: 'window', id: newId('window'), systemId: raw.systemId as string, level,
          points: [points[0], points[1]], depth,
          ...(typeof raw.ref === 'string' ? { ref: raw.ref } : {}),
          ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
          ...(typeof raw.note === 'string' && raw.note ? { note: raw.note } : {}),
        })
      } else if (raw.kind === 'door') {
        sheet.items.push({
          kind: 'door', id: newId('door'), systemId: raw.systemId as string, level,
          points: [points[0], points[1]],
          swing: raw.swing === -1 ? -1 : 1,
          ...(typeof raw.ref === 'string' ? { ref: raw.ref } : {}),
          ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
          ...(typeof raw.note === 'string' && raw.note ? { note: raw.note } : {}),
        })
      } else {
        sheet.items.push({
          kind: 'run', id: newId('run'), systemId: raw.systemId as string, level, points,
          flow: raw.flow === 'forward' || raw.flow === 'reverse' ? raw.flow : 'none',
          size: typeof raw.size === 'string' ? raw.size : store.system(raw.systemId as string).defaultSize,
          ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
          ...(typeof raw.note === 'string' && raw.note ? { note: raw.note } : {}),
        })
      }
    })
  } else if (raw.kind === 'box') {
    // A piece of equipment in plan: its unturned rectangle by one corner and its size, then
    // turned about its centre if it does not sit square to the page.
    const dim = (metres: unknown, pts: unknown): number | null =>
      typeof metres === 'number' ? pointsFromMetres(sheet, metres) : typeof pts === 'number' ? pts : null
    const [x, y, w, h] = [dim(raw.xM, raw.x), dim(raw.yM, raw.y), dim(raw.wM, raw.w), dim(raw.hM, raw.h)]
    if (x === null || y === null || w === null || h === null) {
      return void problems.push(`${at}: a box needs xM, yM (its top-left corner) and wM, hM in metres on a calibrated sheet — or x, y, w, h in points`)
    }
    if (!(w > 0) || !(h > 0)) return void problems.push(`${at}: a box needs a positive wM and hM`)
    if (raw.rotationDeg !== undefined && (typeof raw.rotationDeg !== 'number' || !isFinite(raw.rotationDeg))) {
      return void problems.push(`${at}: rotationDeg must be a number of degrees`)
    }
    describe.push(`${at}: add box ${raw.label ?? ''} to ${sheet.name}`.replace(/\s+/g, ' '))
    planned.push(() => {
      sheet.items.push({
        kind: 'box', id: newId('box'), systemId: raw.systemId as string, level, x, y, w, h,
        ...(typeof raw.rotationDeg === 'number' && raw.rotationDeg % 360 !== 0 ? { rotationDeg: raw.rotationDeg } : {}),
        ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
        ...(typeof raw.note === 'string' && raw.note ? { note: raw.note } : {}),
      })
    })
  } else if (raw.kind === 'marker' || raw.kind === 'note') {
    const x = typeof raw.xM === 'number' ? pointsFromMetres(sheet, raw.xM) : typeof raw.x === 'number' ? raw.x : null
    const y = typeof raw.yM === 'number' ? pointsFromMetres(sheet, raw.yM) : typeof raw.y === 'number' ? raw.y : null
    if (x === null || y === null) return void problems.push(`${at}: needs x/y in points or xM/yM in metres on a calibrated sheet`)
    const view = raw.kind === 'marker' ? readView(raw, sheet, at, problems) : {}
    if (!view) return
    describe.push(`${at}: add ${raw.kind} to ${sheet.name}`)
    planned.push(() => {
      if (raw.kind === 'note') {
        sheet.items.push({ kind: 'note', id: newId('note'), systemId: raw.systemId as string, level, x, y, w: 90, text: String(raw.text ?? '') })
      } else {
        const marker: MarkerItem = {
          kind: 'marker', id: newId('mk'), systemId: raw.systemId as string, level, x, y,
          symbol: (raw.symbol as never) ?? 'note',
          ...view,
          ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
          ...(typeof raw.note === 'string' && raw.note ? { note: raw.note } : {}),
          // Whatever placed this - a rule, a person, a model - it arrives unreviewed and
          // is drawn faintly until somebody looks at it and touches it.
          ...(stamp ? { generated: stamp } : {}),
        }
        aimIfUnset(marker, sheet)
        sheet.items.push(marker)
      }
    })
  } else {
    problems.push(`${at}: kind must be one of ${ADDABLE_KINDS.join(', ')}`)
  }
}

const HANDLERS = { set: doSet, delete: doDelete, move: doMove, add: doAdd }

/**
 * Validates a batch of edits and returns what it would do, without doing any of it. Everything
 * is checked before anything is planned, so a half-understood instruction cannot leave the
 * drawing half-changed.
 */
export function planOps(
  project: Project, store: Store, ops: Op[], stamp: { rule: string; from: string } | null,
): Plan {
  const index = new Map<string, { sheet: Sheet; item: Item }>()
  for (const sheet of project.sheets) for (const item of sheet.items) index.set(item.id, { sheet, item })
  const systemIds = new Set(project.systems.map((s) => s.id))

  const problems: string[] = []
  const describe: string[] = []
  const planned: (() => void)[] = []

  ops.forEach((op, n) => {
    const at = `op ${n + 1} (${op?.op})`
    const target = 'id' in op ? index.get(op.id) : undefined
    if ('id' in op && !target) return void problems.push(`${at}: no item with id "${op.id}"`)

    const handler = HANDLERS[op.op as keyof typeof HANDLERS] as ((op: Op, ctx: Ctx) => void) | undefined
    if (!handler) return void problems.push(`${at}: unknown op`)
    handler(op, { project, store, systemIds, stamp, target, at, problems, describe, planned })
  })

  return { problems, describe, planned }
}
