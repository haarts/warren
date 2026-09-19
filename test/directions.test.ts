import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  angleDiff, bearingBetween, compassDirections, compassLabel, directionsOf, isToward, pointToward,
  resolveDirection, splitNames, tipBearing,
  type Oriented,
} from '../src/directions.ts'
import type { Direction } from '../src/model/types.ts'

/** Orientation lives on the project; these tests only need that slice of one. */
function sheet(directions: Direction[]): Oriented {
  return { directions }
}

test('bearingBetween reads like a plan\'s own north arrow: up is 0, clockwise from there', () => {
  assert.equal(bearingBetween({ x: 0, y: 0 }, { x: 0, y: -10 }), 0, 'straight up')
  assert.equal(bearingBetween({ x: 0, y: 0 }, { x: 10, y: 0 }), 90, 'straight right')
  assert.equal(bearingBetween({ x: 0, y: 0 }, { x: 0, y: 10 }), 180, 'straight down')
  assert.equal(bearingBetween({ x: 0, y: 0 }, { x: -10, y: 0 }), 270, 'straight left')
})

test('pointToward is the inverse of bearingBetween', () => {
  const s = sheet([{ id: 'east', bearingDeg: 90, aliases: [] }])
  const p = pointToward(s, { x: 5, y: 5 }, 'east', 10)!
  assert.ok(Math.abs(p.x - 15) < 1e-9 && Math.abs(p.y - 5) < 1e-9, `expected ~(15, 5), got (${p.x}, ${p.y})`)
  assert.equal(bearingBetween({ x: 5, y: 5 }, p), 90)
})

test('angleDiff wraps around the compass correctly', () => {
  assert.equal(angleDiff(350, 10), 20, 'crossing 0/360 the short way')
  assert.equal(angleDiff(10, 350), -20)
  assert.equal(angleDiff(0, 180), 180)
})

test('resolveDirection matches by id, by exact alias, and by substring — all case-insensitive', () => {
  const s = sheet([
    { id: 'street', bearingDeg: 0, aliases: ['North', 'noord', 'left', 'straatzijde', 'street side'] },
    { id: 'garden', bearingDeg: 180, aliases: ['south', 'zuid', 'right', 'tuinzijde'] },
  ])
  assert.equal(resolveDirection(s, 'street')?.id, 'street', 'by id')
  assert.equal(resolveDirection(s, 'NOORD')?.id, 'street', 'exact alias, case-insensitive')
  assert.equal(resolveDirection(s, 'straatzijde')?.id, 'street')
  assert.equal(resolveDirection(s, 'Left')?.id, 'street')
  assert.equal(resolveDirection(s, 'street')?.id, 'street', 'substring fallback still resolves to the same one')
  assert.equal(resolveDirection(s, 'tuin')?.id, 'garden', 'substring against a multi-word alias')
  assert.equal(resolveDirection(s, 'nowhere'), null)
})

test('one bearing really can answer to three unrelated names at once', () => {
  const s = sheet([{ id: 'a', bearingDeg: 0, aliases: ['north', 'left', 'straatzijde'] }])
  const viaEach = ['north', 'left', 'straatzijde'].map((term) => resolveDirection(s, term)?.id)
  assert.deepEqual(viaEach, ['a', 'a', 'a'])
})

test('isToward checks a real point against a named bearing within tolerance', () => {
  const s = sheet([{ id: 'street', bearingDeg: 0, aliases: ['north'] }])
  assert.equal(isToward(s, { x: 0, y: 0 }, { x: 1, y: -10 }, 'street'), true, 'nearly straight up, within 45°')
  assert.equal(isToward(s, { x: 0, y: 0 }, { x: 10, y: 0 }, 'street'), false, 'due east is not toward a north-ish street')
  assert.equal(isToward(s, { x: 0, y: 0 }, { x: 10, y: 0 }, 'nowhere'), null, 'unknown direction answers null, not false')
})

test('compassLabel is a display convenience, not a claim about true north', () => {
  assert.equal(compassLabel(0), 'N')
  assert.equal(compassLabel(90), 'E')
  assert.equal(compassLabel(180), 'S')
  assert.equal(compassLabel(270), 'W')
  assert.equal(compassLabel(10), 'N', 'rounds to the nearest 16th')
  assert.equal(compassLabel(46), 'NE')
})

test('a compass rose names four bearings a quarter-turn apart, starting from its rotation', () => {
  const s: Oriented = {
    compass: { x: 0, y: 0, rotationDeg: 300, tips: ['north, straatzijde', 'east', '', 'west, links'] },
  }
  const dirs = compassDirections(s)
  assert.deepEqual(dirs.map((d) => [d.id, d.bearingDeg, d.tip]), [
    ['north', 300, 0],
    ['east', 30, 1],
    // tip 3 has no name, so it names nothing
    ['west', 210, 3],
  ])
  assert.equal(tipBearing(s.compass!, 2), 120, 'an unnamed tip still has a bearing, it just is not a direction')
})

test('a rose on its own resolves by any tip name, and one-off directions sit alongside it', () => {
  const s: Oriented = {
    compass: { x: 0, y: 0, rotationDeg: 12, tips: ['north, straatzijde', '', 'south, tuin', ''] },
    directions: [{ id: 'carport', bearingDeg: 250, aliases: ['carport', 'oprit'] }],
  }
  assert.equal(resolveDirection(s, 'straatzijde')?.bearingDeg, 12)
  assert.equal(resolveDirection(s, 'straatzijde')?.source, 'compass')
  assert.equal(resolveDirection(s, 'tuin')?.bearingDeg, 192)
  assert.equal(resolveDirection(s, 'oprit')?.source, 'list')
  assert.deepEqual(directionsOf(s).map((d) => d.id), ['north', 'south', 'carport'], 'rose first, then the list')
  const p = pointToward(s, { x: 0, y: 0 }, 'straatzijde', 100)!
  assert.equal(Math.round(bearingBetween({ x: 0, y: 0 }, p)), 12)
})

test('splitNames trims and drops empties, so stray commas do not become names', () => {
  assert.deepEqual(splitNames(' north ,, noord,  '), ['north', 'noord'])
  assert.deepEqual(splitNames(''), [])
})
