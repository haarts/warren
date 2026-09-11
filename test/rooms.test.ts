import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inwardNormal, pointInPolygon, polygonArea, polygonCentroid, polygonEdges } from '../src/geom.ts'
import { parseProject, serialize } from '../src/io/projectFile.ts'
import { emptyProject, Store } from '../src/model/doc.ts'
import type { DoorItem, RoomItem } from '../src/model/types.ts'

const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]

test('polygon area, centroid and containment', () => {
  assert.equal(Math.abs(polygonArea(square)), 100)
  assert.deepEqual(polygonCentroid(square), { x: 5, y: 5 })
  assert.equal(pointInPolygon({ x: 5, y: 5 }, square), true)
  assert.equal(pointInPolygon({ x: 15, y: 5 }, square), false)
  // An L shape, to be sure it is not just handling rectangles.
  const ell = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 10 }, { x: 0, y: 10 }]
  assert.equal(Math.abs(polygonArea(ell)), 64)
  assert.equal(pointInPolygon({ x: 8, y: 8 }, ell), false, 'the notch is outside')
})

test('the inward normal points into the room, whichever way it winds', () => {
  for (const poly of [square, [...square].reverse()]) {
    for (const [a, b] of polygonEdges(poly)) {
      const n = inwardNormal(a, b, poly)
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      assert.equal(pointInPolygon({ x: mid.x + n.x, y: mid.y + n.y }, poly), true)
    }
  }
})

test('rooms and doors round trip, and nonsense is rejected', () => {
  const project = emptyProject()
  const room: RoomItem = {
    kind: 'room', id: 'r1', systemId: 'struct.room', level: 'floor',
    name: 'Keuken', use: 'kitchen', ref: '0.04', points: square,
  }
  const door: DoorItem = {
    kind: 'door', id: 'd1', systemId: 'struct.door', level: 'floor',
    points: [{ x: 0, y: 0 }, { x: 0, y: 9 }], swing: -1, ref: 'B.09',
  }
  project.sheets[0].items.push(room, door)
  assert.deepEqual(parseProject(serialize(project)).sheets[0].items, [room, door])

  const junk = parseProject(JSON.stringify({
    version: 1,
    sheets: [{ id: 's', name: 'S', items: [
      { kind: 'room', id: 'thin', systemId: 'struct.room', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
      { kind: 'room', id: 'odd', systemId: 'struct.room', use: 'dungeon', points: square },
      { kind: 'door', id: 'onepoint', systemId: 'struct.door', points: [{ x: 0, y: 0 }] },
      { kind: 'door', id: 'ok', systemId: 'struct.door', points: [{ x: 0, y: 0 }, { x: 5, y: 0 }], swing: 7 },
    ] }],
  })).sheets[0].items
  assert.deepEqual(junk.map((i) => i.id), ['odd', 'ok'], 'two points is not a room, one is not a door')
  assert.equal(junk[0].kind === 'room' && junk[0].use, 'other', 'an unknown use falls back')
  assert.equal(junk[1].kind === 'door' && junk[1].swing, 1, 'a nonsense swing falls back')
})

test('a level filter never hides the building', () => {
  const project = emptyProject()
  project.settings.levelFilter = 'ceiling'
  const room: RoomItem = {
    kind: 'room', id: 'r1', systemId: 'struct.room', level: 'floor',
    name: 'Keuken', use: 'kitchen', points: square,
  }
  project.sheets[0].items.push(room)
  // Rooms are the context you read the services against; filtering ducts must not remove it.
  const store = new Store()
  store.loadProject(project, null)
  assert.equal(store.isVisible(room), true)
})
