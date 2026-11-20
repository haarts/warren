import { test } from 'node:test'
import assert from 'node:assert/strict'
import { carryRisers } from '../src/risers.ts'
import { emptyProject, Store } from '../src/model/doc.ts'
import { planOps, type Op } from '../bin/ops.ts'
import type { MarkerItem, Project, Sheet } from '../src/model/types.ts'

const riser = (id: string, x: number, y: number, symbol: MarkerItem['symbol'] = 'riser-up', systemId = 'drain.soil'): MarkerItem =>
  ({ kind: 'marker', id, systemId, level: 'wall', x, y, symbol })

/** Three floors at 10 mm per point. The upper floor sits 10 right and 20 down on its page; the attic is not lined up. */
function floors(): Sheet[] {
  return [
    { id: 'g', name: 'begane grond', pdf: null, mmPerPoint: 10, align: { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } },
      items: [riser('up', 100, 100)] },
    { id: 'f', name: 'eerste verdieping', pdf: null, mmPerPoint: 10, align: { a: { x: 10, y: 20 }, b: { x: 110, y: 20 } },
      items: [
        riser('down', 110, 120, 'riser-down'),
        riser('other', 110, 120, 'riser-down', 'water.cold'),
        { kind: 'marker', id: 'socket', systemId: 'drain.soil', level: 'wall', x: 110, y: 120, symbol: 'socket' },
      ] },
    { id: 'z', name: 'zolder', pdf: null, mmPerPoint: 10, items: [riser('attic', 100, 100, 'riser-down')] },
  ] as Sheet[]
}

const at = (sheets: Sheet[], id: string) => {
  const m = sheets.flatMap((s) => s.items).find((i) => i.id === id) as MarkerItem
  return [m.x, m.y]
}

test('moving a riser moves the same pipe on the floor above, to the same new spot in the building', () => {
  const sheets = floors()
  const before = structuredClone(sheets)
  const up = sheets[0].items[0] as MarkerItem
  up.x = 150
  up.y = 130
  assert.equal(carryRisers(before, sheets), 1)
  assert.deepEqual(at(sheets, 'down'), [160, 150], 'shifted the way the floors are lined up')
  assert.deepEqual(at(sheets, 'other'), [110, 120], 'a riser of another system is another pipe')
  assert.deepEqual(at(sheets, 'socket'), [110, 120], 'and a socket is not a riser at all')
  assert.deepEqual(at(sheets, 'attic'), [100, 100], 'a floor that is not lined up has no same spot')
})

test('it works from either end, and a riser moved in the same edit is left where it was put', () => {
  const sheets = floors()
  const before = structuredClone(sheets)
  const down = sheets[1].items[0] as MarkerItem
  down.x = 60
  down.y = 70
  carryRisers(before, sheets)
  assert.deepEqual(at(sheets, 'up'), [50, 50])

  const both = floors()
  const was = structuredClone(both)
  Object.assign(both[0].items[0], { x: 0, y: 0 })
  Object.assign(both[1].items[0], { x: 200, y: 200 })
  assert.equal(carryRisers(was, both), 0)
  assert.deepEqual(at(both, 'up'), [0, 0])
  assert.deepEqual(at(both, 'down'), [200, 200])
})

test('a new riser - a copy, a paste - carries nothing', () => {
  const sheets = floors()
  const before = structuredClone(sheets)
  sheets[0].items.push(riser('copy', 300, 300))
  assert.equal(carryRisers(before, sheets), 0)
})

function project(): { project: Project; store: Store } {
  const p = emptyProject()
  p.sheets = floors()
  p.activeSheetId = 'g'
  const store = new Store()
  store.loadProject(p, 'risers')
  return { project: store.project, store }
}

test('in the app the partner moves in the same undo step', () => {
  const { project: p, store } = project()
  store.mutate(() => { Object.assign(store.item('up')!, { x: 150, y: 130 }) })
  assert.deepEqual(at(p.sheets, 'down'), [160, 150])
  assert.equal(store.lastCarried, 1)
  store.undo()
  assert.deepEqual(at(store.project.sheets, 'down'), [110, 120])
  assert.deepEqual(at(store.project.sheets, 'up'), [100, 100])
})

test('apply moves the partner too', () => {
  const { project: p, store } = project()
  const plan = planOps(p, store, [{ op: 'move', id: 'up', byPt: [50, 30] }] as Op[], null)
  assert.deepEqual(plan.problems, [])
  for (const step of plan.planned) step()
  assert.equal(plan.planned.length, 1, 'still one op')
  assert.equal(plan.carried(), 1)
  assert.deepEqual(at(p.sheets, 'down'), [160, 150])
})
