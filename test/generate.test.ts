import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adopt, applyGenerated, DEFAULT_RULES, generate, generatedBy, selectRooms } from '../src/generate.ts'
import { pointInPolygon } from '../src/geom.ts'
import type { DoorItem, MarkerItem, RoomItem, Sheet } from '../src/model/types.ts'

/** 6 x 4 m room on a sheet where 1 pt = 20 mm. */
const room: RoomItem = {
  kind: 'room', id: 'kitchen', systemId: 'struct.room', level: 'floor',
  name: 'Keuken', use: 'kitchen',
  points: [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 200 }, { x: 0, y: 200 }],
}

function sheet(items: (RoomItem | DoorItem | MarkerItem)[] = [room]): Sheet {
  return { id: 's', name: 'S', pdf: null, mmPerPoint: 20, items: [...items] }
}

const rule = (id: string) => DEFAULT_RULES.find((r) => r.id === id)!

test('two sockets per wall, inside the room and clear of the corners', () => {
  const result = generate(sheet(), rule('sockets'))
  assert.equal(result.create.length, 8, 'four walls, two each')
  for (const socket of result.create) {
    assert.equal(pointInPolygon({ x: socket.x, y: socket.y }, room.points), true, 'placed inside the room')
    assert.equal(socket.systemId, 'power.230v')
    assert.equal(socket.generated?.rule, 'sockets')
    assert.equal(socket.generated?.from, 'kitchen')
  }
  // 400 mm inset on a 6 m wall: 0.4 m and 5.6 m along it, i.e. 20 pt and 280 pt.
  const bottom = result.create.filter((s) => s.y < 20).map((s) => Math.round(s.x)).sort((a, b) => a - b)
  assert.deepEqual(bottom, [20, 280])
})

test('a use the rule does not name gets nothing', () => {
  const toilet: RoomItem = { ...room, id: 'wc', use: 'toilet' }
  assert.equal(generate(sheet([toilet]), rule('sockets')).create.length, 0)
  assert.equal(generate(sheet([toilet]), rule('detectors')).create.length, 0)
  assert.equal(generate(sheet([room]), rule('detectors')).create.length, 0, 'a kitchen is not a hall')
  assert.equal(generate(sheet([{ ...room, id: 'hal', use: 'hall' }]), rule('detectors')).create.length, 1)
})

test('walls too short to be worth a socket are skipped', () => {
  const cupboard: RoomItem = {
    ...room, id: 'tiny',
    // 6 m x 0.8 m: the long walls qualify, the 0.8 m ends do not.
    points: [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 40 }, { x: 0, y: 40 }],
  }
  assert.equal(generate(sheet([cupboard]), rule('sockets')).create.length, 4)
})

test('a switch lands past the strike jamb, not behind the door', () => {
  const door: DoorItem = {
    kind: 'door', id: 'b09', systemId: 'struct.door', level: 'floor',
    points: [{ x: 100, y: 0 }, { x: 145, y: 0 }], swing: 1,
  }
  const result = generate(sheet([room, door]), rule('switches'))
  assert.equal(result.create.length, 1)
  const sw = result.create[0]
  assert.ok(sw.x > 145, 'past the strike jamb, which is the far one from the hinge')
  assert.equal(sw.generated?.from, 'b09')

  // Hang the door the other way round and the switch moves to the other side.
  const flipped: DoorItem = { ...door, points: [{ x: 145, y: 0 }, { x: 100, y: 0 }] }
  const other = generate(sheet([room, flipped]), rule('switches')).create[0]
  assert.ok(other.x < 100, 'the hinge is the first jamb, so the strike is now on the left')
})

test('running a rule twice produces exactly the same thing', () => {
  const a = generate(sheet(), rule('sockets')).create
  const b = generate(sheet(), rule('sockets')).create
  assert.deepEqual(a, b, 'ids are derived, not random, so the file does not churn')
})

test('editing generated output claims it, and regenerating leaves it alone', () => {
  const live = sheet()
  applyGenerated(live, generate(live, rule('sockets')))
  assert.equal(live.items.filter((i) => generatedBy(i)).length, 8)

  // A person moves one.
  const mine = live.items.find((i) => i.kind === 'marker') as MarkerItem
  mine.x += 40
  adopt(mine)
  const movedTo = mine.x

  const second = generate(live, rule('sockets'))
  assert.equal(second.replace.length, 7, 'only the seven nobody touched')
  assert.deepEqual(second.adopted, [mine.id])
  applyGenerated(live, second)

  const after = live.items.find((i) => i.id === mine.id) as MarkerItem
  assert.equal(after.x, movedTo, 'the nudge survives')
  assert.equal(generatedBy(after), undefined, 'and it is yours now')
  assert.equal(live.items.filter((i) => i.kind === 'marker').length, 8, 'no duplicate in its place')
})

test('rules are data with no opinions baked into the code', () => {
  const mine = { ...rule('sockets'), perWall: 3, insetMm: 0, uses: [] }
  const result = generate(sheet(), mine)
  assert.equal(result.create.length, 12, 'three per wall because the rule said so')
  const custom = generate(sheet([{ ...room, use: 'toilet' }]), mine)
  assert.equal(custom.create.length, 12, 'an empty use list means every room')
})

const roomNamed = (id: string, name: string, use: RoomItem['use'], x: number, ref?: string): RoomItem => ({
  kind: 'room', id, systemId: 'struct.room', level: 'floor', name, use, ref,
  points: [{ x, y: 0 }, { x: x + 300, y: 0 }, { x: x + 300, y: 200 }, { x, y: 200 }],
})

test('an exact room name wins, so Keuken never drags in the Bijkeuken', () => {
  const rooms = [
    roomNamed('k', 'Keuken', 'kitchen', 0, '0.04'),
    roomNamed('b', 'Bijkeuken', 'utility', 400, '0.09'),
  ]
  assert.deepEqual(selectRooms(rooms, ['Keuken']).map((r) => r.id), ['k'])
  assert.deepEqual(selectRooms(rooms, ['keuken']).map((r) => r.id), ['k'], 'case does not matter')
  assert.deepEqual(selectRooms(rooms, ['0.09']).map((r) => r.id), ['b'], 'a plan ref works too')
  // Nothing matches exactly, so substring is a convenience rather than a trap.
  assert.deepEqual(selectRooms(rooms, ['keu']).map((r) => r.id), ['k', 'b'])
  assert.deepEqual(selectRooms(rooms, []).map((r) => r.id), ['k', 'b'], 'no scope means every room')
})

test('generating for one room leaves the other rooms alone', () => {
  const live = sheet([
    roomNamed('k', 'Keuken', 'kitchen', 0),
    roomNamed('b', 'Bedroom', 'bedroom', 400),
  ])
  const rule = DEFAULT_RULES.find((r) => r.id === 'sockets')!
  applyGenerated(live, generate(live, rule))
  assert.equal(live.items.filter((i) => i.kind === 'marker').length, 16, 'eight in each')

  const scoped = generate(live, rule, { rooms: ['Keuken'] })
  assert.deepEqual(scoped.rooms, ['Keuken'])
  assert.equal(scoped.create.length, 8)
  assert.equal(scoped.replace.length, 8, "only the kitchen's own output is up for replacement")
  applyGenerated(live, scoped)
  assert.equal(live.items.filter((i) => i.kind === 'marker').length, 16, 'the bedroom still has its eight')
})

test('a scoped run with nothing to place clears just that room', () => {
  const live = sheet([
    roomNamed('k', 'Keuken', 'kitchen', 0),
    roomNamed('b', 'Bedroom', 'bedroom', 400),
  ])
  const rule = DEFAULT_RULES.find((r) => r.id === 'sockets')!
  applyGenerated(live, generate(live, rule))
  const scoped = generate(live, rule, { rooms: ['Keuken'] })
  applyGenerated(live, { ...scoped, create: [] })
  const left = live.items.filter((i) => i.kind === 'marker') as { generated?: { from: string } }[]
  assert.equal(left.length, 8)
  assert.ok(left.every((i) => i.generated?.from === 'b'), 'the bedroom keeps all of its own')
})
