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
