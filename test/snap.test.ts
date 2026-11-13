import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/model/doc.ts'
import { resolvePoint } from '../src/interact/snap.ts'
import type { RunItem } from '../src/model/types.ts'

function storeWithRun(points: { x: number; y: number }[]): Store {
  const store = new Store()
  const run: RunItem = {
    kind: 'run', id: 'r1', systemId: 'water.cold', level: 'wall', points, flow: 'none',
  }
  store.sheet.items.push(run)
  return store
}

test('a nearby vertex wins over ortho lock', () => {
  const store = storeWithRun([{ x: 100, y: 100 }, { x: 200, y: 100 }])
  const res = resolvePoint(store, { x: 202, y: 103 }, 10, { anchor: { x: 0, y: 0 }, ortho: true })
  assert.deepEqual(res.point, { x: 200, y: 100 })
  assert.equal(res.label, 'end')
})

test('a run being dragged does not snap to its own vertex', () => {
  const store = storeWithRun([{ x: 100, y: 100 }, { x: 200, y: 100 }])
  const res = resolvePoint(store, { x: 201, y: 101 }, 10, { excludeRunId: 'r1', excludeIndex: 1 })
  // Falls through to the on-run edge snap rather than latching onto the point being moved.
  assert.notDeepEqual(res.point, { x: 200, y: 100 })
})

test('grid snapping needs a calibrated sheet', () => {
  const store = storeWithRun([{ x: 0, y: 0 }, { x: 10, y: 0 }])
  store.project.settings.snapToItems = false
  store.project.settings.snapToGrid = true
  store.project.settings.gridMm = 100

  assert.equal(resolvePoint(store, { x: 503, y: 300 }, 10).label, null, 'uncalibrated: no grid')

  store.sheet.mmPerPoint = 10 // 100 mm grid = 10 pt
  const res = resolvePoint(store, { x: 503, y: 301 }, 10)
  assert.deepEqual(res.point, { x: 500, y: 300 })
  assert.equal(res.label, 'grid')
})

test('with nothing to snap to the raw point survives', () => {
  const store = new Store()
  const res = resolvePoint(store, { x: 12.34, y: 56.78 }, 10)
  assert.deepEqual(res.point, { x: 12.34, y: 56.78 })
  assert.equal(res.label, null)
})

test('a run drawn alongside another snaps to the run spacing beside it', () => {
  // 10 mm per point, 50 mm spacing: the guide is 5 pt beside the run.
  const store = storeWithRun([{ x: 0, y: 100 }, { x: 200, y: 100 }])
  store.sheet.mmPerPoint = 10
  const along = resolvePoint(store, { x: 120, y: 106.5 }, 10, { anchor: { x: 20, y: 105 }, spacing: true })
  assert.deepEqual(along.point, { x: 120, y: 105 })
  assert.match(along.label ?? '', /beside run/)
  // Closer than half the gap is still on the run - a tee is a tee.
  const onto = resolvePoint(store, { x: 120, y: 101.5 }, 10, { spacing: true })
  assert.equal(onto.label, 'on run')
  // A run crossing it is not running beside it.
  const crossing = resolvePoint(store, { x: 120, y: 106 }, 10, { anchor: { x: 120, y: 160 }, spacing: true })
  assert.doesNotMatch(crossing.label ?? '', /beside/)
  // Off unless asked for: a marker dragged near a run still lands on it.
  assert.doesNotMatch(resolvePoint(store, { x: 120, y: 106.5 }, 10).label ?? '', /beside/)
})

test('a parallel run turns its corner beside the other one, not on top of it', () => {
  const store = storeWithRun([{ x: 0, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 300 }])
  store.sheet.mmPerPoint = 10
  const res = resolvePoint(store, { x: 194, y: 106 }, 10, { spacing: true })
  assert.deepEqual(res.point, { x: 195, y: 105 })
  assert.equal(res.label, 'beside corner')
})

test('zoomed out too far to see the gap, there is no spacing guide', () => {
  const store = storeWithRun([{ x: 0, y: 100 }, { x: 200, y: 100 }])
  store.sheet.mmPerPoint = 10
  // A tolerance of 40 pt means 11 px is 40 pt: the 5 pt gap is under 2 px on screen.
  assert.doesNotMatch(resolvePoint(store, { x: 120, y: 104 }, 40, { spacing: true }).label ?? '', /beside/)
})
