import { test } from 'node:test'
import assert from 'node:assert/strict'
import { polygonArea, thickOutline } from '../src/geom.ts'
import { emptyProject, Store } from '../src/model/doc.ts'
import { parseProject, serialize } from '../src/io/projectFile.ts'
import { planOps, type Op } from '../bin/ops.ts'
import { computeTakeoff } from '../src/takeoff.ts'
import { reportItem } from '../bin/units.ts'
import type { Project, WallItem, WindowItem } from '../src/model/types.ts'

/** 10 mm per point, so 1 m is 100 points and the arithmetic stays readable. */
function project(): { project: Project; store: Store } {
  const project = emptyProject()
  project.sheets[0].mmPerPoint = 10
  const store = new Store()
  store.loadProject(project, 'walls')
  return { project, store }
}

const apply = (p: Project, store: Store, ops: unknown[]) => {
  const plan = planOps(p, store, ops as Op[], null)
  if (!plan.problems.length) for (const run of plan.planned) run()
  return plan
}

test('a straight wall outlines to a rectangle of its thickness', () => {
  const outline = thickOutline([{ x: 0, y: 0 }, { x: 100, y: 0 }], 5)
  assert.equal(outline.length, 4)
  assert.equal(Math.abs(polygonArea(outline)), 100 * 10)
})

test('a cornered wall is mitred, so its outline covers both legs once', () => {
  // An L of two 100-long legs, 10 thick: the outer faces are 105 long, the inner 95.
  const outline = thickOutline([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 5)
  assert.equal(outline.length, 6)
  assert.ok(Math.abs(Math.abs(polygonArea(outline)) - 2000) < 1e-6, String(polygonArea(outline)))
  assert.ok(outline.some((p) => Math.abs(p.x - 105) < 1e-9 && Math.abs(p.y + 5) < 1e-9), 'outer corner mitred')
})

test('apply adds a wall in metres, and it survives a save and reload', () => {
  const { project: p, store } = project()
  const plan = apply(p, store, [{
    op: 'add',
    item: { kind: 'wall', systemId: 'struct.wall', pointsM: [[0, 0], [4, 0], [4, 3]], thicknessM: 0.3, status: 'new', ref: 'W1' },
  }])
  assert.deepEqual(plan.problems, [])
  const wall = p.sheets[0].items[0] as WallItem
  assert.equal(wall.kind, 'wall')
  assert.equal(wall.thickness, 30)
  assert.deepEqual(wall.points[2], { x: 400, y: 300 })

  const back = parseProject(serialize(p)).sheets[0].items[0] as WallItem
  assert.deepEqual(back, wall)

  const report = reportItem(store, p.sheets[0], wall)
  assert.equal(report.lengthM, 7)
  assert.equal(report.thicknessM, 0.3)
  assert.equal(report.status, 'new')
})

test('a wall without a thickness, or with a made-up status, is refused', () => {
  const { project: p, store } = project()
  const missing = apply(p, store, [{ op: 'add', item: { kind: 'wall', systemId: 'struct.wall', pointsM: [[0, 0], [1, 0]] } }])
  assert.match(missing.problems.join(), /thicknessM/)
  const status = apply(p, store, [{ op: 'add', item: { kind: 'wall', systemId: 'struct.wall', pointsM: [[0, 0], [1, 0]], thicknessM: 0.1, status: 'old' } }])
  assert.match(status.problems.join(), /status/)
  assert.equal(p.sheets[0].items.length, 0)
})

test('set changes a wall’s thickness in metres, and refuses it on anything else', () => {
  const { project: p, store } = project()
  apply(p, store, [
    { op: 'add', item: { kind: 'wall', systemId: 'struct.wall', pointsM: [[0, 0], [1, 0]], thicknessM: 0.1 } },
    { op: 'add', item: { kind: 'run', systemId: 'power.230v', pointsM: [[0, 1], [1, 1]] } },
  ])
  const [wall, run] = p.sheets[0].items
  assert.deepEqual(apply(p, store, [{ op: 'set', id: wall.id, patch: { thicknessM: 0.21, status: 'new' } }]).problems, [])
  assert.equal((wall as WallItem).thickness, 21)
  assert.equal((wall as WallItem).status, 'new')
  assert.ok(!('thicknessM' in wall), 'the metres are converted, not stored')
  assert.match(apply(p, store, [{ op: 'set', id: run.id, patch: { thicknessM: 0.2 } }]).problems.join(), /for walls/)
})

test('walls are architecture: never in the takeoff', () => {
  const { project: p, store } = project()
  apply(p, store, [{ op: 'add', item: { kind: 'wall', systemId: 'struct.wall', pointsM: [[0, 0], [10, 0]], thicknessM: 0.3 } }])
  const takeoff = computeTakeoff(store, 'project')
  assert.equal(takeoff.byCategory.flatMap((g) => g.rows).length, 0)
})

test('a window on a wall takes the wall’s thickness, and survives a save and reload', () => {
  const { project: p, store } = project()
  apply(p, store, [{ op: 'add', item: { kind: 'wall', systemId: 'struct.wall', pointsM: [[0, 0], [5, 0], [5, 4]], thicknessM: 0.3 } }])
  const plan = apply(p, store, [{ op: 'add', item: { kind: 'window', systemId: 'struct.window', pointsM: [[5, 1], [5, 2.2]], ref: 'K1' } }])
  assert.deepEqual(plan.problems, [])
  const win = p.sheets[0].items[1] as WindowItem
  assert.equal(win.kind, 'window')
  assert.equal(win.depth, 30)
  assert.deepEqual(parseProject(serialize(p)).sheets[0].items[1], win)
  const report = reportItem(store, p.sheets[0], win)
  assert.equal(report.lengthM, 1.2)
  assert.equal(report.depthM, 0.3)
  assert.equal(computeTakeoff(store, 'project').byCategory.flatMap((g) => g.rows).length, 0)
})

test('a window off any wall needs a depth, and is never more than two jambs', () => {
  const { project: p, store } = project()
  const loose = apply(p, store, [{ op: 'add', item: { kind: 'window', systemId: 'struct.window', pointsM: [[0, 0], [1, 0]] } }])
  assert.match(loose.problems.join(), /depthM/)
  const three = apply(p, store, [{ op: 'add', item: { kind: 'window', systemId: 'struct.window', pointsM: [[0, 0], [1, 0], [2, 0]], depthM: 0.1 } }])
  assert.match(three.problems.join(), /exactly 2/)
  const given = apply(p, store, [{ op: 'add', item: { kind: 'window', systemId: 'struct.window', pointsM: [[0, 0], [1, 0]], depthM: 0.12 } }])
  assert.deepEqual(given.problems, [])
  const [win] = p.sheets[0].items
  assert.deepEqual(apply(p, store, [{ op: 'set', id: win.id, patch: { depthM: 0.2 } }]).problems, [])
  assert.equal((win as WindowItem).depth, 20)
})

test('two corners on one spot draw as one corner, not a spike', () => {
  const clean = thickOutline([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 5)
  const doubled = thickOutline([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 5)
  assert.deepEqual(doubled, clean)
})
