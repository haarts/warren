import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/model/doc.ts'
import { computeTakeoff, systemsInUse } from '../src/takeoff.ts'
import { defaultSystems, missingDefaults } from '../src/model/systems.ts'
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

test('interlinked smoke detectors are a power circuit, not low-voltage wiring', () => {
  const smoke = defaultSystems().find((s) => s.id === 'power.smoke')
  assert.ok(smoke, 'the catalogue seeds it')
  assert.equal(smoke.category, 'power', 'it belongs with the electrician, not the data sheet')
  assert.match(smoke.defaultSize ?? '', /interlink/)
  // It must be tellable apart from every other power system on a greyscale print.
  const others = defaultSystems().filter((s) => s.category === 'power' && s.id !== 'power.smoke')
  const signature = (s: { color: string; dash: number[] }) => `${s.color}|${s.dash.join(',')}`
  assert.equal(others.some((o) => signature(o) === signature(smoke)), false)
})

test('every seeded size list starts with that system\'s default', () => {
  for (const sys of defaultSystems()) {
    if (!sys.sizes) {
      assert.equal(sys.defaultSize, undefined, `${sys.id} has a default with no list to pick it from`)
      continue
    }
    assert.equal(sys.defaultSize, sys.sizes[0], `${sys.id}: default must be the first suggestion`)
    assert.equal(new Set(sys.sizes).size, sys.sizes.length, `${sys.id} lists a size twice`)
    assert.equal(sys.sizes.every((v) => v.trim() !== ''), true, `${sys.id} has a blank size`)
  }
})

test('the common electrical specs are the ones an electrician expects', () => {
  const by = (id: string) => defaultSystems().find((s) => s.id === id)
  // NEN 1010 practice: 3x1.5 lighting, 3x2.5 sockets and dedicated appliances on a 16 A group,
  // 5x2.5 for a 3x16 A hob or an 11 kW charge point, 5x6 for 3x32 A.
  assert.equal(by('power.light')?.defaultSize, '3×1.5mm²')
  assert.equal(by('power.socket')?.defaultSize, '3×2.5mm²')
  assert.equal(by('power.appliance')?.defaultSize, '3×2.5mm²')
  assert.equal(by('power.3ph')?.defaultSize, '5×2.5mm²')
  assert.ok(by('power.3ph')?.sizes?.includes('5×6mm²'), '3x32 A / 22 kW must be offered')
  assert.ok(by('power.earth')?.sizes?.includes('16mm²'), 'main earthing conductor')
})

test('missingDefaults reports the gap without resurrecting deletions', () => {
  const full = defaultSystems()
  assert.deepEqual(missingDefaults(full), [], 'a complete catalogue has no gap')

  const older = full.filter((s) => s.id !== 'power.smoke' && s.id !== 'struct.note')
  const missing = missingDefaults(older).map((s) => s.id).sort()
  assert.deepEqual(missing, ['power.smoke', 'struct.note'])

  // A system the user renamed is still present, so it is never offered again.
  const renamed = full.map((s) => (s.id === 'power.smoke' ? { ...s, name: 'Rookmelders' } : s))
  assert.deepEqual(missingDefaults(renamed), [])
})

test('the legend only lists systems that are actually drawn', () => {
  const store = new Store()
  store.sheet.items.push(run('a', 'heat.ufh', [{ x: 0, y: 0 }, { x: 10, y: 0 }]))
  const used = systemsInUse(store, 'sheet')
  assert.deepEqual(used.map((s) => s.id), ['heat.ufh'])
})
