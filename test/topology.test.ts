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

test('circuits leaving a board are joined to the board, not to each other', () => {
  // Six dedicated runs from a distribution board share a start coordinate, because that is
  // where snapping puts them. Reporting each as joined to the other five buries the one
  // connection that matters.
  const board: Item = { kind: 'box', id: 'board', systemId: 'power.230v', level: 'on-wall', x: 0, y: 0, w: 20, h: 30 }
  // Fanned out after they leave the board, so the only shared point is the one at the board.
  const at = (id: string, endX: number): Item =>
    run(id, 'power.230v', [[10, 15], [endX, 15], [endX, 200]])
  const g = buildGraph(sheet([board, at('koelkast', 200), at('vaatwasser', 300), at('oven', 400)]))

  for (const id of ['koelkast', 'vaatwasser', 'oven']) {
    const c = connectionsOf(g, id)
    assert.equal(c.length, 1, `${id} should see only the board`)
    assert.equal(c[0].otherId, 'board')
    assert.equal(c[0].how, 'equipment')
  }
  assert.equal(connectionsOf(g, 'board').length, 3, 'the board sees all three')
  // Connectivity is not lost - they are joined through the board.
  assert.equal(networkOf(g, 'oven')?.items.length, 4)
})

test('runs meeting at an appliance point are joined to it, not to each other', () => {
  // Two circuits reaching the same outlet, and a third whose route happens to pass through it.
  const point: Item = { kind: 'marker', id: 'koelkast', systemId: 'power.230v', level: 'on-wall', x: 100, y: 0, symbol: 'socket' }
  const g = buildGraph(sheet([
    point,
    run('a', 'power.230v', [[0, 0], [100, 0]]),
    run('b', 'power.230v', [[100, 0], [100, 80]]),
    run('c', 'power.230v', [[100, 0], [180, 40]]),
  ]))
  for (const id of ['a', 'b', 'c']) {
    assert.deepEqual(connectionsOf(g, id).map((x) => x.otherId), ['koelkast'], `${id} sees only the outlet`)
  }
  assert.equal(connectionsOf(g, 'koelkast').length, 3)
  assert.equal(networkOf(g, 'a')?.items.length, 4, 'still one network, joined through the outlet')
})

test('two runs meeting in open space are still joined to each other', () => {
  // The board rule must not swallow an ordinary joint away from any equipment.
  const g = buildGraph(sheet([
    run('a', 'water.cold', [[0, 0], [100, 0]]),
    run('b', 'water.cold', [[100, 0], [100, 100]]),
  ]))
  assert.deepEqual(connectionsOf(g, 'a').map((c) => c.otherId), ['b'])
})

test('things join only when they carry the same thing', () => {
  // A UTP cable ending inside the rainwater manifold's box is drawn there, not plugged into it.
  const manifold: Item = { kind: 'box', id: 'manifold', systemId: 'reuse.dist', level: 'on-wall', x: 0, y: 0, w: 40, h: 40 }
  const rainPipe = run('rain', 'reuse.dist', [[20, 20], [20, 300]])
  const g = buildGraph(sheet([
    manifold, rainPipe,
    run('utp', 'data.cat6', [[20, 20], [300, 20]]),
    run('utp2', 'data.cat6', [[20, 20], [20, -300]]),
    { kind: 'marker', id: 'sensor', systemId: 'data.presence', level: 'ceiling', x: 300, y: 20, symbol: 'presence' },
  ]))
  assert.deepEqual(connectionsOf(g, 'manifold').map((c) => c.otherId), ['rain'], 'the box sees only its own pipe')
  assert.deepEqual(connectionsOf(g, 'utp').map((c) => c.otherId).sort(), ['sensor', 'utp2'],
    'the cable meets its sensor, and the other cable at the shared point - not through somebody else\'s box')
  assert.equal(g.freeEnds.some((f) => f.itemId === 'rain' && f.end === 'start'), false)
})

test('pipes join across categories - a gutter into the tank, a fill loop into the heating', () => {
  const g = buildGraph(sheet([
    { kind: 'box', id: 'tank', systemId: 'reuse.supply', level: 'crawl', x: 0, y: 0, w: 40, h: 40 },
    run('gutter', 'drain.rain', [[20, 20], [20, 300]]),
    run('fill', 'water.fill', [[100, 0], [200, 0]]),
    run('flow', 'heat.flow', [[200, 0], [200, 100]]),
  ]))
  assert.deepEqual(connectionsOf(g, 'gutter').map((c) => c.otherId), ['tank'])
  assert.deepEqual(connectionsOf(g, 'fill').map((c) => c.otherId), ['flow'])
})

test('structure joins only its own kind: a shaft connects nothing that passes through it', () => {
  const g = buildGraph(sheet([
    { kind: 'box', id: 'shaft', systemId: 'struct.shaft', level: 'wall', x: 0, y: 0, w: 40, h: 40 },
    run('pipe', 'water.cold', [[20, 20], [20, 300]]),
    run('cable', 'power.230v', [[20, 20], [300, 20]]),
    run('seal', 'struct.airtight', [[0, 500], [100, 500]]),
    run('seal2', 'struct.airtight', [[100, 500], [100, 600]]),
  ]))
  assert.deepEqual(connectionsOf(g, 'shaft'), [])
  assert.deepEqual(connectionsOf(g, 'pipe'), [])
  assert.deepEqual(connectionsOf(g, 'seal').map((c) => c.otherId), ['seal2'])
})

test('the catalogue decides the category, so a custom system joins its family', () => {
  const g = buildGraph(sheet([
    run('a', 'my-own-pipe', [[0, 0], [100, 0]]),
    run('b', 'water.cold', [[100, 0], [100, 100]]),
    run('c', 'no-idea', [[100, 100], [200, 100]]),
  ]), (id) => (id === 'my-own-pipe' ? 'heat' : id === 'water.cold' ? 'water' : undefined))
  assert.deepEqual(connectionsOf(g, 'a').map((c) => c.otherId), ['b'])
  assert.deepEqual(connectionsOf(g, 'c'), [], 'a system of unknown category joins only itself')
})
