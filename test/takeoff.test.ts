import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/model/doc.ts'
import { computeTakeoff, systemsInUse } from '../src/takeoff.ts'
import type { RunItem } from '../src/model/types.ts'

function run(id: string, systemId: string, points: { x: number; y: number }[], extraM?: number): RunItem {
  return { kind: 'run', id, systemId, level: 'wall', points, flow: 'none', extraM }
}

test('lengths use the sheet calibration and the slack percentage', () => {
  const store = new Store()
  store.sheet.mmPerPoint = 10 // 1 pt = 10 mm
  store.project.settings.takeoffSlackPct = 10
  store.sheet.items.push(run('a', 'data.cat6', [{ x: 0, y: 0 }, { x: 100, y: 0 }]))
  store.sheet.items.push(run('b', 'data.cat6', [{ x: 0, y: 0 }, { x: 0, y: 300 }]))

  const result = computeTakeoff(store, 'sheet')
  const row = result.rows.find((r) => r.system.id === 'data.cat6')
  assert.ok(row)
  assert.equal(row.runs, 2)
  assert.equal(row.lengthMm, 4000, '400 pt × 10 mm')
  assert.equal(row.orderMm, 4400, 'plus 10% slack')
})

test('per-run extra length is added on top of the slack', () => {
  const store = new Store()
  store.sheet.mmPerPoint = 10
  store.project.settings.takeoffSlackPct = 0
  store.sheet.items.push(run('a', 'power.socket', [{ x: 0, y: 0 }, { x: 100, y: 0 }], 2.5))
  const row = computeTakeoff(store, 'sheet').rows[0]
  assert.equal(row.lengthMm, 1000)
  assert.equal(row.orderMm, 3500, '1 m plan + 2.5 m of drops')
})

test('an uncalibrated sheet is reported instead of producing bogus metres', () => {
  const store = new Store()
  store.sheet.name = 'First floor'
  store.sheet.items.push(run('a', 'water.cold', [{ x: 0, y: 0 }, { x: 100, y: 0 }]))
  const result = computeTakeoff(store, 'sheet')
  assert.deepEqual(result.uncalibrated, ['First floor'])
  assert.equal(result.rows[0].lengthMm, 0)
  assert.equal(result.rows[0].runs, 1)
})

test('notes are counted apart from equipment and never become material', () => {
  const store = new Store()
  store.sheet.mmPerPoint = 10
  store.sheet.items.push(
    run('a', 'air.supply', [{ x: 0, y: 0 }, { x: 100, y: 0 }]),
    { kind: 'note', id: 'n1', systemId: 'air.supply', level: 'ceiling', x: 0, y: 0, w: 90, text: 'reroute' },
    { kind: 'marker', id: 'm1', systemId: 'air.supply', level: 'ceiling', x: 5, y: 5, symbol: 'outlet' },
  )
  const row = computeTakeoff(store, 'sheet').rows[0]
  assert.equal(row.notes, 1)
  assert.equal(row.markers, 1, 'a note must not be miscounted as a marker')
  assert.equal(row.boxes, 0)
  assert.equal(row.lengthMm, 1000, 'a note adds no length')
})

test('the legend only lists systems that are actually drawn', () => {
  const store = new Store()
  store.sheet.items.push(run('a', 'heat.ufh', [{ x: 0, y: 0 }, { x: 10, y: 0 }]))
  const used = systemsInUse(store, 'sheet')
  assert.deepEqual(used.map((s) => s.id), ['heat.ufh'])
})
