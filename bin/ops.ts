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
import { polygonArea } from '../src/geom.ts'
import { adopt } from '../src/generate.ts'
import { newId } from '../src/model/ids.ts'
import type { Store } from '../src/model/doc.ts'
import { isPositioned, pointsOf, ROOM_USES, LEVELS, type Item, type Level, type Project, type RoomUse, type Sheet } from '../src/model/types.ts'
import { findSheets, pointsFromMetres } from './units.ts'

export interface SetOp { op: 'set'; id: string; patch: Record<string, unknown> }
export interface DeleteOp { op: 'delete'; id: string }
export interface MoveOp { op: 'move'; id: string; byM?: [number, number]; byPt?: [number, number] }
export interface AddOp { op: 'add'; sheet?: string; item: Record<string, unknown> }
export type Op = SetOp | DeleteOp | MoveOp | AddOp

/** The kinds `add` knows how to build. Named once, so the manifest cannot promise more. */
export const ADDABLE_KINDS: Item['kind'][] = ['run', 'room', 'door', 'marker', 'note']

export const PATCHABLE = new Set([
  'systemId', 'level', 'label', 'size', 'flow', 'slope', 'note', 'text', 'extraM', 'colorOverride',
  'locked', 'symbol', 'name', 'use', 'ref', 'swing',
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

function doSet(op: SetOp, ctx: Ctx): void {
  const { target, at, systemIds, problems, describe, planned } = ctx
  const bad = Object.keys(op.patch ?? {}).filter((k) => !PATCHABLE.has(k))
  if (bad.length) return void problems.push(`${at}: cannot set ${bad.join(', ')} — patchable fields are ${[...PATCHABLE].join(', ')}`)
  if (typeof op.patch.systemId === 'string' && !systemIds.has(op.patch.systemId)) {
    return void problems.push(`${at}: systemId "${op.patch.systemId}" is not in this project's catalogue`)
  }
  if (typeof op.patch.level === 'string' && !LEVELS.includes(op.patch.level as Level)) {
    return void problems.push(`${at}: level "${op.patch.level}" is not one of ${LEVELS.join(', ')}`)
  }
  describe.push(`${at}: ${Object.keys(op.patch).join(', ')} on ${op.id}`)
  planned.push(() => {
    Object.assign(target!.item, op.patch)
    // Editing claims machine output, whoever does the editing. Without this a later
    // `generate` would quietly undo the change.
    adopt(target!.item)
  })
}

function doDelete(op: DeleteOp, ctx: Ctx): void {
  const { target, at, describe, planned } = ctx
  describe.push(`${at}: delete ${target!.item.kind} ${op.id}`)
  planned.push(() => {
    target!.sheet.items = target!.sheet.items.filter((i) => i.id !== op.id)
  })
}

function doMove(op: MoveOp, ctx: Ctx): void {
  const { target, at, problems, describe, planned } = ctx
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
    adopt(item)
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
  const level = typeof raw.level === 'string' && LEVELS.includes(raw.level as Level) ? raw.level as Level : 'wall'
  const shaped = raw.kind === 'run' || raw.kind === 'room' || raw.kind === 'door'
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
          use: ROOM_USES.includes(raw.use as RoomUse) ? (raw.use as RoomUse) : 'other',
          ...(typeof raw.ref === 'string' ? { ref: raw.ref } : {}),
        })
      } else if (raw.kind === 'door') {
        sheet.items.push({
          kind: 'door', id: newId('door'), systemId: raw.systemId as string, level,
          points: [points[0], points[1]],
          swing: raw.swing === -1 ? -1 : 1,
          ...(typeof raw.ref === 'string' ? { ref: raw.ref } : {}),
          ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
        })
      } else {
        sheet.items.push({
          kind: 'run', id: newId('run'), systemId: raw.systemId as string, level, points,
          flow: raw.flow === 'forward' || raw.flow === 'reverse' ? raw.flow : 'none',
          size: typeof raw.size === 'string' ? raw.size : store.system(raw.systemId as string).defaultSize,
          ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
        })
      }
    })
  } else if (raw.kind === 'marker' || raw.kind === 'note') {
    const x = typeof raw.xM === 'number' ? pointsFromMetres(sheet, raw.xM) : typeof raw.x === 'number' ? raw.x : null
    const y = typeof raw.yM === 'number' ? pointsFromMetres(sheet, raw.yM) : typeof raw.y === 'number' ? raw.y : null
    if (x === null || y === null) return void problems.push(`${at}: needs x/y in points or xM/yM in metres on a calibrated sheet`)
    describe.push(`${at}: add ${raw.kind} to ${sheet.name}`)
    planned.push(() => {
      if (raw.kind === 'note') {
        sheet.items.push({ kind: 'note', id: newId('note'), systemId: raw.systemId as string, level, x, y, w: 90, text: String(raw.text ?? '') })
      } else {
        sheet.items.push({
          kind: 'marker', id: newId('mk'), systemId: raw.systemId as string, level, x, y,
          symbol: (raw.symbol as never) ?? 'note',
          ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
          // Whatever placed this - a rule, a person, a model - it arrives unreviewed and
          // is drawn faintly until somebody looks at it and touches it.
          ...(stamp ? { generated: stamp } : {}),
        })
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
