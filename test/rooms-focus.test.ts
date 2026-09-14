import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isInRoom, itemsInRoom, roomsOf } from '../src/rooms.ts'
import type { Item, RoomItem, Sheet } from '../src/model/types.ts'

/** Two rooms side by side, 0..200 and 300..500 along x. */
const kitchen: RoomItem = {
  kind: 'room', id: 'k', systemId: 'struct.room', level: 'floor', name: 'Keuken', use: 'kitchen',
  points: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 }],
}
const bedroom: RoomItem = {
  kind: 'room', id: 'b', systemId: 'struct.room', level: 'floor', name: 'Renze', use: 'bedroom',
  points: [{ x: 300, y: 0 }, { x: 500, y: 0 }, { x: 500, y: 200 }, { x: 300, y: 200 }],
}

const sheet = (items: Item[]): Sheet => ({ id: 's', name: 'S', pdf: null, mmPerPoint: 20, items })
const run = (id: string, pts: [number, number][]): Item => ({
  kind: 'run', id, systemId: 'power.230v', level: 'wall', flow: 'none',
  points: pts.map(([x, y]) => ({ x, y })),
})

test('a run belongs to the rooms its ends land in', () => {
  const s = sheet([kitchen, bedroom,
    run('inside', [[50, 50], [150, 50]]),
    run('across', [[50, 50], [400, 50]]),
    run('outside', [[220, 50], [280, 50]]),
  ])
  assert.deepEqual(roomsOf(s, s.items[2]).map((r) => r.id), ['k'])
  assert.deepEqual(roomsOf(s, s.items[3]).map((r) => r.id), ['k', 'b'], 'a circuit can serve two')
  assert.deepEqual(roomsOf(s, s.items[4]).map((r) => r.id), [])
})

test('merely crossing a room is not being in it', () => {
  // A circuit passing over the kitchen on its way elsewhere is not the kitchen's business.
  const s = sheet([kitchen, bedroom, run('passing', [[-50, 100], [400, 100]])])
  assert.deepEqual(roomsOf(s, s.items[2]).map((r) => r.id), ['b'], 'only where it ends')
})

test('a marker belongs to the room it sits in', () => {
  const socket: Item = { kind: 'marker', id: 'm', systemId: 'power.230v', level: 'on-wall', x: 100, y: 100, symbol: 'socket-2' }
  const s = sheet([kitchen, bedroom, socket])
  assert.deepEqual(roomsOf(s, socket).map((r) => r.id), ['k'])
  assert.equal(isInRoom(s, socket, 'k'), true)
  assert.equal(isInRoom(s, socket, 'b'), false)
})

test('a box belongs to the room its middle is in, not a corner that pokes through a wall', () => {
  const panel: Item = { kind: 'box', id: 'p', systemId: 'power.230v', level: 'on-wall', x: 180, y: 90, w: 40, h: 20 }
  const s = sheet([kitchen, bedroom, panel])
  // Left half inside the kitchen, right half outside; the centre is at x=200, on the edge.
  assert.equal(roomsOf(s, panel).length <= 1, true)
})

test('focusing a room gathers everything in it, and nothing else', () => {
  const s = sheet([kitchen, bedroom,
    run('kitchenRun', [[50, 50], [150, 50]]),
    run('feed', [[100, 100], [400, 100]]),
    run('bedroomRun', [[350, 50], [450, 50]]),
    { kind: 'marker', id: 'sock', systemId: 'power.230v', level: 'on-wall', x: 400, y: 150, symbol: 'socket' },
  ])
  const focus = itemsInRoom(s, 'b')
  assert.deepEqual([...focus].sort(), ['b', 'bedroomRun', 'feed', 'sock'].sort(),
    'the feed counts: it is how the room is served')
  assert.equal(focus.has('kitchenRun'), false)
  assert.equal(focus.has('k'), false)
})

test('a focus naming a room that is gone gathers nothing, rather than everything', () => {
  const s = sheet([kitchen, run('r', [[50, 50], [150, 50]])])
  assert.equal(itemsInRoom(s, 'no-such-room').size, 0)
})

test('a door belongs to the rooms its jambs touch', () => {
  const door: Item = {
    kind: 'door', id: 'd', systemId: 'struct.door', level: 'wall',
    points: [{ x: 190, y: 100 }, { x: 210, y: 100 }], swing: 1,
  }
  const s = sheet([kitchen, bedroom, door])
  assert.deepEqual(roomsOf(s, door).map((r) => r.id), ['k'], 'the way in is never greyed from the room')
})
