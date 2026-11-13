import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acrossAxis, alignItems, distributeItems, runAxis } from '../src/interact/arrange.ts'
import { itemBounds } from '../src/render/bounds.ts'
import type { BoxItem, Item, MarkerItem } from '../src/model/types.ts'

const box = (id: string, x: number, y: number, w: number, h: number, rotationDeg?: number): BoxItem => ({
  kind: 'box', id, systemId: 'power.board', level: 'on-wall', x, y, w, h, ...(rotationDeg ? { rotationDeg } : {}),
})
const marker = (id: string, x: number, y: number): MarkerItem => ({
  kind: 'marker', id, systemId: 'power.socket', level: 'wall', x, y, symbol: 'socket',
})
const close = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6

test('align lines items up on the edge of the group', () => {
  const items: Item[] = [box('a', 0, 0, 10, 10), box('b', 30, 5, 20, 10), marker('m', 100, 50)]
  alignItems(items, 'right')
  assert.deepEqual(items.map((i) => itemBounds(i).x + itemBounds(i).w), [100, 100, 100])
  alignItems(items, 'middle')
  const middles = items.map((i) => itemBounds(i).y + itemBounds(i).h / 2)
  assert.ok(middles.every((m) => close(m, middles[0])), String(middles))
})

test('distribute leaves equal gaps and keeps the outer two in place', () => {
  const items: Item[] = [box('a', 0, 0, 10, 10), box('b', 12, 0, 30, 10), box('c', 90, 0, 10, 10)]
  distributeItems(items, 'horizontal')
  const [a, b, c] = items.map(itemBounds)
  assert.equal(a.x, 0)
  assert.equal(c.x, 90)
  assert.ok(close(b.x - (a.x + a.w), c.x - (b.x + b.w)))
  // Markers have no size, so even gaps is even centres.
  const dots: Item[] = [marker('1', 0, 0), marker('2', 0, 7), marker('3', 0, 40), marker('4', 0, 10)]
  distributeItems(dots, 'vertical')
  assert.deepEqual(dots.map((d) => (d as MarkerItem).y), [0, 13.333333333333334, 40, 26.666666666666668])
})

const diagonal = (id: string, x: number, y: number): Item => ({
  kind: 'run', id, systemId: 'water.cold', level: 'wall', flow: 'none',
  points: [{ x, y }, { x: x + 100, y: y + 100 }],
})

test('diagonal runs are arranged along and across themselves, not along the page', () => {
  const runs = [diagonal('a', 0, 0), diagonal('b', 30, 0), diagonal('c', 0, 50)]
  const axis = runAxis(runs)
  assert.ok(axis !== null && Math.abs(Math.abs(axis) - Math.PI / 4) < 1e-9, String(axis))
  const flat: Item = { kind: 'run', id: 'c', systemId: 'water.cold', level: 'wall', flow: 'none', points: [{ x: 0, y: 0 }, { x: 100, y: 10 }] }
  assert.equal(runAxis([diagonal('a', 0, 0), box('b', 0, 0, 5, 5), flat]), null, 'runs pointing different ways share no axis')

  // Space them 10 pt apart across their direction: equal perpendicular gaps.
  const across = acrossAxis(runs, axis!)
  distributeItems(runs, across, axis!, 10)
  const offsets = runs.map((r) => {
    const p = (r as { points: { x: number; y: number }[] }).points[0]
    return (p.y - p.x) / Math.SQRT2 // signed distance from the line y = x
  }).sort((p, q) => p - q)
  assert.ok(Math.abs(offsets[1] - offsets[0] - 10) < 1e-9 && Math.abs(offsets[2] - offsets[1] - 10) < 1e-9, JSON.stringify(offsets))
  // ...and each still runs at 45°.
  for (const r of runs) {
    const [p, q] = (r as { points: { x: number; y: number }[] }).points
    assert.ok(Math.abs((q.y - p.y) - (q.x - p.x)) < 1e-9)
  }
})
