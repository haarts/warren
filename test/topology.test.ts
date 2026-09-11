import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph, connectionsOf, networkOf, toleranceFor } from '../src/topology.ts'
import type { Item, Sheet } from '../src/model/types.ts'

function sheet(items: Item[], mmPerPoint: number | null = 20): Sheet {
  return { id: 's', name: 'S', pdf: null, mmPerPoint, items }
}

const run = (id: string, systemId: string, pts: [number, number][]): Item => ({
  kind: 'run', id, systemId, level: 'floor', flow: 'none',
  points: pts.map(([x, y]) => ({ x, y })),
})

test('runs that share an endpoint are joined; runs that merely pass close are not', () => {
  const g = buildGraph(sheet([
    run('a', 'water.cold', [[0, 0], [100, 0]]),
    run('b', 'water.cold', [[100, 0], [100, 100]]),
    // Ends 3 pt away — on a 20 mm/pt sheet that is 60 mm, far outside the 5 mm tolerance.
    run('c', 'water.cold', [[103, 0], [200, 0]]),
  ]))
  assert.deepEqual(connectionsOf(g, 'a').map((c) => c.otherId), ['b'])
  assert.deepEqual(connectionsOf(g, 'c'), [], 'nearly touching is not touching')
  assert.equal(networkOf(g, 'a')?.items.length, 2)
  assert.equal(networkOf(g, 'c')?.items.length, 1)
})

test('an end landing part way along another run is a tee, not a joint', () => {
  const g = buildGraph(sheet([
    run('main', 'drain.soil', [[0, 0], [200, 0]]),
    run('branch', 'drain.waste', [[100, 0], [100, 80]]),
  ]))
  const c = connectionsOf(g, 'branch')
  assert.equal(c.length, 1)
  assert.equal(c[0].how, 'tee', 'telling a branch from a continuation is the point')
  assert.equal(networkOf(g, 'main')?.items.length, 2)
})

test('a run ending on a box reaches equipment', () => {
  const withBox = buildGraph(sheet([
    run('feed', 'power.socket', [[0, 0], [50, 50]]),
    { kind: 'box', id: 'board', systemId: 'power.socket', level: 'on-wall', x: 40, y: 40, w: 30, h: 30 },
  ]))
  assert.equal(connectionsOf(withBox, 'feed').length, 1)
  assert.equal(connectionsOf(withBox, 'feed')[0].how, 'equipment')
  assert.equal(networkOf(withBox, 'feed')?.hasEquipment, true)

  const without = buildGraph(sheet([run('feed', 'power.socket', [[0, 0], [50, 50]])]))
  assert.equal(networkOf(without, 'feed')?.hasEquipment, false)
})

test('both ends of a lone run are free; a joined end is not', () => {
  const g = buildGraph(sheet([
    run('a', 'water.cold', [[0, 0], [100, 0]]),
    run('b', 'water.cold', [[100, 0], [100, 100]]),
    run('lonely', 'water.cold', [[0, 500], [100, 500]]),
  ]))
  assert.equal(g.freeEnds.filter((f) => f.itemId === 'lonely').length, 2)
  assert.equal(g.freeEnds.filter((f) => f.itemId === 'a').length, 1, 'only the end that meets nothing')
})

test('tolerance is tiny, and scales with the sheet', () => {
  // 5 mm of real world, whatever the drawing scale happens to be.
  assert.equal(toleranceFor(sheet([], 20)), 0.25)
  assert.equal(toleranceFor(sheet([], 10)), 0.5)
  assert.equal(toleranceFor(sheet([], null)), 0.25, 'a sensible fallback with no scale')
})

test('notes are not part of the network - they are annotations', () => {
  const g = buildGraph(sheet([
    run('a', 'water.cold', [[0, 0], [100, 0]]),
    { kind: 'note', id: 'n', systemId: 'water.cold', level: 'wall', x: 0, y: 0, w: 90, text: 'hi' },
  ]))
  assert.equal(networkOf(g, 'a')?.items.length, 1)
  assert.equal(networkOf(g, 'n'), null)
})
