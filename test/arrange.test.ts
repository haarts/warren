import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alignItems, distributeItems } from '../src/interact/arrange.ts'
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
