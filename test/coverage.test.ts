import { test } from 'node:test'
import assert from 'node:assert/strict'
import { polygonArea } from '../src/geom.ts'
import { emptyProject, Store } from '../src/model/doc.ts'
import { parseProject, serialize } from '../src/io/projectFile.ts'
import { planOps, type Op } from '../bin/ops.ts'
import { aimVector, bearingDeg, coverage, obstaclesOf, roomsOf, suggestAim, viewOf } from '../src/coverage.ts'
import type { MarkerItem, Project, Sheet, WallItem } from '../src/model/types.ts'

/** 10 mm per point: 1 m is 100 points. */
const wall = (id: string, points: [number, number][], thickness = 10): WallItem =>
  ({ kind: 'wall', id, systemId: 'struct.wall', level: 'wall', points: points.map(([x, y]) => ({ x, y })), thickness, status: 'existing' })

/** A 4 × 3 m room, walls 10 cm thick on their centrelines at 0 and 400 across, 0 and 300 down. */
const room = (): Sheet => ({
  id: 's', name: 's', pdf: null, mmPerPoint: 10,
  items: [
    wall('w', [[0, 0], [400, 0], [400, 300], [0, 300], [0, 0]]),
    { kind: 'room', id: 'r', systemId: 'struct.room', level: 'floor', name: 'Room', use: 'living', points: [{ x: 5, y: 5 }, { x: 395, y: 5 }, { x: 395, y: 295 }, { x: 5, y: 295 }] },
  ],
})

const sensor = (x: number, y: number, extra: Partial<MarkerItem> = {}): MarkerItem =>
  ({ kind: 'marker', id: 'm', systemId: 'data.sensor', level: 'on-wall', x, y, symbol: 'presence', ...extra })

const farthest = (o: { x: number; y: number }, outline: { x: number; y: number }[]): number =>
  Math.max(...outline.map((p) => Math.hypot(p.x - o.x, p.y - o.y)))

test('aim is degrees clockwise from up the page, and bearing reads it back', () => {
  const right = aimVector(90)
  assert.ok(Math.abs(right.x - 1) < 1e-9 && Math.abs(right.y) < 1e-9)
  const down = aimVector(180)
  assert.ok(Math.abs(down.y - 1) < 1e-9)
  assert.equal(Math.round(bearingDeg({ x: 0, y: 0 }, { x: -1, y: 0 })), 270)
})

test('a presence sensor sees 120° out to six metres unless told otherwise; others see nothing', () => {
  const view = viewOf(sensor(0, 0), 10)!
  assert.equal(view.fovDeg, 120)
  assert.equal(view.range, 600)
  assert.equal(viewOf(sensor(0, 0, { symbol: 'sensor' }), 10), null)
  assert.equal(viewOf(sensor(0, 0), null), null, 'six metres means nothing on a sheet without a scale')
  assert.equal(viewOf(sensor(0, 0, { level: 'ceiling' }), 10)!.fovDeg, 360, 'on the ceiling it looks down')
})

test('a sensor on a wall sees across the room and stops at the far wall, not at its own', () => {
  const sheet = room()
  // On the centreline of the left wall, halfway down, facing right across the 4 m room.
  const o = { x: 0, y: 150 }
  const outline = coverage(o, { aimDeg: 90, fovDeg: 120, range: 600 }, obstaclesOf(sheet))
  // The far wall's inner face is at 395: nothing gets further than that.
  assert.ok(outline.every((p) => p.x <= 395 + 1e-6), `${Math.max(...outline.map((p) => p.x))}`)
  // Straight ahead it reaches the far face exactly.
  const ahead = outline.filter((p) => Math.abs(p.y - 150) < 1)
  assert.ok(ahead.some((p) => Math.abs(p.x - 395) < 1e-6))
  // It sees a real patch of the room, not a sliver stopped by the wall it hangs on.
  assert.ok(Math.abs(polygonArea(outline)) > 395 * 290 * 0.6)
})

test('in open space the cone is a sector of its range', () => {
  const outline = coverage({ x: 0, y: 0 }, { aimDeg: 0, fovDeg: 120, range: 100 }, [])
  assert.ok(Math.abs(farthest({ x: 0, y: 0 }, outline) - 100) < 1e-6)
  const sector = (Math.PI * 100 * 100) / 3
  assert.ok(Math.abs(Math.abs(polygonArea(outline)) - sector) / sector < 0.01)
})

test('a wall in the way casts a shadow behind it, and a doorway lets the view through', () => {
  // A partition across the middle with a 1 m opening: 0-150 and 250-400 at y 150.
  const sheet = room()
  sheet.items.push(wall('p1', [[0, 150], [150, 150]]), wall('p2', [[250, 150], [400, 150]]))
  const edges = obstaclesOf(sheet)
  const o = { x: 200, y: 5 }
  const outline = coverage(o, { aimDeg: 180, fovDeg: 120, range: 600 }, edges)
  // Through the doorway it reaches the bottom wall's face...
  assert.ok(outline.some((p) => Math.abs(p.y - 295) < 1e-6 && p.x > 150 && p.x < 250))
  // ...but only within the lines from the sensor past the doorway's jambs: beyond those the
  // partition stops it. The jambs' faces are 5 either side of the openings at 150 and 250.
  for (const p of outline) {
    if (p.y <= 145 + 1e-6) continue
    const spread = ((p.y - o.y) * (50 + 5)) / (145 - o.y)
    assert.ok(Math.abs(p.x - 200) <= spread + 1e-6, `${p.x},${p.y} is in the partition's shadow`)
  }
  assert.ok(outline.some((p) => p.y > 150), 'and it does get through')
})

test('one hung on a wall is aimed into the room rather than at the wall behind it', () => {
  const sheet = room()
  const rooms = roomsOf(sheet)
  const aim = suggestAim({ x: 400, y: 150 }, { fovDeg: 120, range: 600 }, obstaclesOf(sheet), rooms)
  assert.equal(aim, 270)
  // Without rooms nothing says which side is in, and the open garden wins - which is why it asks.
  assert.notEqual(suggestAim({ x: 400, y: 150 }, { fovDeg: 120, range: 600 }, obstaclesOf(sheet)), 270)
  // In a corner it looks into the room between the two walls, leaning to the longer one.
  const corner = suggestAim({ x: 0, y: 0 }, { fovDeg: 120, range: 600 }, obstaclesOf(sheet), rooms)
  assert.ok(corner > 90 && corner < 180, String(corner))
})

function project(): { project: Project; store: Store } {
  const project = emptyProject()
  project.sheets[0].mmPerPoint = 10
  project.sheets[0].items.push(...room().items)
  const store = new Store()
  store.loadProject(project, 'coverage')
  return { project, store }
}

const apply = (p: Project, store: Store, ops: unknown[]) => {
  const plan = planOps(p, store, ops as Op[], null)
  if (!plan.problems.length) for (const run of plan.planned) run()
  return plan
}

test('apply adds a presence sensor in metres, aims it into the room, and it survives a reload', () => {
  const { project: p, store } = project()
  const plan = apply(p, store, [
    { op: 'add', item: { kind: 'marker', systemId: 'data.sensor', symbol: 'presence', xM: 4, yM: 1.5, rangeM: 5, fovDeg: 100, note: 'CeilSense Mini' } },
  ])
  assert.deepEqual(plan.problems, [])
  const m = p.sheets[0].items.find((i) => i.kind === 'marker') as MarkerItem
  assert.equal(m.range, 500)
  assert.equal(m.fovDeg, 100)
  assert.equal(m.aimDeg, 270, 'nobody aimed it, so it faces into the room')
  assert.equal(m.note, 'CeilSense Mini', 'a note given on add is kept')
  const back = parseProject(serialize(p)).sheets[0].items.find((i) => i.kind === 'marker') as MarkerItem
  assert.deepEqual([back.aimDeg, back.fovDeg, back.range], [270, 100, 500])
})

test('turning a marker into a presence sensor aims it; an aim given is kept; nonsense is refused', () => {
  const { project: p, store } = project()
  apply(p, store, [{ op: 'add', item: { kind: 'marker', systemId: 'data.sensor', symbol: 'sensor', xM: 0, yM: 1.5 } }])
  const m = p.sheets[0].items.find((i) => i.kind === 'marker') as MarkerItem
  assert.equal(m.aimDeg, undefined)
  apply(p, store, [{ op: 'set', id: m.id, patch: { symbol: 'presence' } }])
  assert.equal(m.aimDeg, 90)
  apply(p, store, [{ op: 'set', id: m.id, patch: { aimDeg: -45 } }])
  assert.equal(m.aimDeg, 315)
  const bad = apply(p, store, [{ op: 'set', id: m.id, patch: { fovDeg: 0 } }])
  assert.match(bad.problems[0], /fovDeg/)
  const wallId = p.sheets[0].items.find((i) => i.kind === 'wall')!.id
  assert.match(apply(p, store, [{ op: 'set', id: wallId, patch: { aimDeg: 10 } }]).problems[0], /presence markers/)
})

test('add-missing gives an older project the presence symbol for the systems it already has', async () => {
  const { addMissing, missingSymbols, defaultSystems } = await import('../src/model/systems.ts')
  const systems = defaultSystems()
  const sensor = systems.find((s) => s.id === 'data.sensor')!
  sensor.symbols = sensor.symbols!.filter((s) => s !== 'presence')
  assert.deepEqual(missingSymbols(systems), [{ id: 'data.sensor', symbols: ['presence'] }])
  const added = addMissing(systems)
  assert.deepEqual(added, { systems: [], symbols: ['data.sensor:presence'] })
  assert.ok(sensor.symbols!.includes('presence'))
  assert.deepEqual(missingSymbols(systems), [])
})

test('a shut door stops the view like the wall it is in', () => {
  const sheet = room()
  sheet.items.push(wall('p1', [[0, 150], [150, 150]]), wall('p2', [[250, 150], [400, 150]]))
  sheet.items.push({ kind: 'door', id: 'd', systemId: 'struct.door', level: 'wall', points: [{ x: 150, y: 150 }, { x: 250, y: 150 }], swing: 1 })
  const outline = coverage({ x: 200, y: 5 }, { aimDeg: 180, fovDeg: 120, range: 600 }, obstaclesOf(sheet))
  assert.ok(outline.every((p) => p.y <= 150), 'nothing past the door')
})

test('on a wall between two rooms it faces the room it can see the most of, not the view through a doorway', () => {
  // Two rooms side by side, 2 m and 3 m wide, sharing the wall at 200. The bigger one is on the
  // right; the small one has a doorway out to a long corridor that a ray would happily run along.
  const sheet: Sheet = {
    id: 's', name: 's', pdf: null, mmPerPoint: 10,
    items: [
      wall('outer', [[0, 0], [500, 0], [500, 300], [0, 300]]),
      wall('mid', [[200, 0], [200, 300]]),
      { kind: 'room', id: 'a', systemId: 'struct.room', level: 'floor', name: 'Small', use: 'hall', points: [{ x: 5, y: 5 }, { x: 195, y: 5 }, { x: 195, y: 295 }, { x: 5, y: 295 }] },
      { kind: 'room', id: 'b', systemId: 'struct.room', level: 'floor', name: 'Big', use: 'living', points: [{ x: 205, y: 5 }, { x: 495, y: 5 }, { x: 495, y: 295 }, { x: 205, y: 295 }] },
    ],
  }
  const aim = suggestAim({ x: 200, y: 150 }, { fovDeg: 120, range: 600 }, obstaclesOf(sheet), roomsOf(sheet))
  assert.equal(aim, 90)
})
