import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runChecks } from '../src/check.ts'
import { Store } from '../src/model/doc.ts'
import type { Item, Level } from '../src/model/types.ts'

const box = (id: string, systemId: string, x: number, y: number, w: number, h: number): Item =>
  ({ kind: 'box', id, systemId, level: 'ceiling', x, y, w, h })
const run = (id: string, level: Level, pts: [number, number][]): Item =>
  ({ kind: 'run', id, systemId: 'power.230v', level, flow: 'none', points: pts.map(([x, y]) => ({ x, y })) })
const light = (id: string, x: number, y: number): Item =>
  ({ kind: 'marker', id, systemId: 'power.230v', level: 'ceiling', x, y, symbol: 'light' })

function findings(items: Item[]): Record<string, string[]> {
  const store = new Store()
  store.sheet.items.push(...items)
  const out: Record<string, string[]> = {}
  const mine = new Set(['crosses-beam', 'under-beam', 'through-nodrill'])
  for (const f of runChecks(store)) if (mine.has(f.rule)) for (const id of f.itemIds) (out[id] ??= []).push(f.rule)
  return out
}

test('a ceiling run may follow the bay between two beams but not cross one', () => {
  const f = findings([
    box('b1', 'struct.beam', 100, 0, 7, 500),
    box('b2', 'struct.beam', 146, 0, 7, 500),
    run('along', 'ceiling', [[120, 10], [120, 400]]),
    run('across', 'ceiling', [[120, 10], [200, 10]]),
    run('over', 'floor', [[50, 10], [200, 10]]),
  ])
  assert.equal(f.along, undefined)
  assert.deepEqual(f.across, ['crosses-beam'])
  assert.equal(f.over, undefined, 'in the floor above, a run passes over the beams')
})

test('a ceiling point under a beam cannot be fed from above', () => {
  const f = findings([box('b', 'struct.beam', 100, 0, 7, 500), light('under', 103, 50), light('beside', 120, 50)])
  assert.deepEqual(f.under, ['under-beam'])
  assert.equal(f.beside, undefined)
})

test('nothing passes through a no-drill zone, at any level', () => {
  const f = findings([
    box('chimney', 'struct.nodrill', 100, 100, 20, 60),
    run('through', 'floor', [[50, 130], [200, 130]]),
    run('around', 'floor', [[50, 90], [200, 90]]),
  ])
  assert.deepEqual(f.through, ['through-nodrill'])
  assert.equal(f.around, undefined)
})
