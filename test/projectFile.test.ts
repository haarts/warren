import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyProject } from '../src/model/doc.ts'
import { parseProject, serialize } from '../src/io/projectFile.ts'
import type { BoxItem, MarkerItem, RunItem } from '../src/model/types.ts'

function sampleProject() {
  const project = emptyProject()
  const sheet = project.sheets[0]
  sheet.mmPerPoint = 3.527
  sheet.pdf = { assetId: 'abc123', page: 4, rotation: 90, widthPt: 842, heightPt: 595 }
  project.assets.abc123 = 'JVBERi0=' // pretend PDF bytes
  const run: RunItem = {
    kind: 'run', id: 'r1', systemId: 'air.supply', level: 'ceiling',
    points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }],
    size: 'Ø125', flow: 'forward', label: 'Bedroom 1', extraM: 1.5,
  }
  const box: BoxItem = {
    kind: 'box', id: 'b1', systemId: 'air.outside', level: 'above',
    x: 10, y: 10, w: 60, h: 40, label: 'HRV',
  }
  const marker: MarkerItem = {
    kind: 'marker', id: 'm1', systemId: 'drain.soil', level: 'floor',
    x: 5, y: 5, symbol: 'riser-down', label: 'to crawl space',
  }
  sheet.items.push(run, box, marker)
  return project
}

test('a project survives a save/load round trip', () => {
  const original = sampleProject()
  const restored = parseProject(serialize(original))
  assert.deepEqual(restored, original)
})

test('unreferenced PDF assets are dropped on save', () => {
  const project = sampleProject()
  project.assets.orphan = 'AAAA'
  const restored = parseProject(serialize(project))
  assert.deepEqual(Object.keys(restored.assets), ['abc123'])
})

test('a damaged file still opens with the good parts intact', () => {
  const broken = JSON.stringify({
    version: 1,
    name: 'Half eaten',
    systems: [{ id: 'x', name: 'Custom', color: '#fff', category: 'nonsense', width: 'wide' }],
    sheets: [{
      id: 's1', name: 'Ground', mmPerPoint: -4,
      items: [
        { kind: 'run', id: 'ok', systemId: 'water.cold', points: [{ x: 1, y: 2 }], flow: 'sideways' },
        { kind: 'run', id: 'nopoints', points: [] },
        { kind: 'alien', id: 'weird' },
        null,
      ],
    }],
    settings: { gridMm: 'lots', showGrid: true, levelFilter: 'basement' },
  })
  const project = parseProject(broken)
  assert.equal(project.sheets.length, 1)
  assert.equal(project.sheets[0].items.length, 1, 'only the recoverable item survives')
  assert.equal(project.sheets[0].mmPerPoint, null, 'a negative scale is rejected')
  assert.equal(project.systems[0].category, 'struct', 'unknown category falls back')
  assert.equal(project.systems[0].width, 1.6, 'a non-numeric width falls back')
  assert.equal(project.settings.gridMm, 100, 'a non-numeric setting falls back')
  assert.equal(project.settings.showGrid, true, 'valid settings are kept')
  assert.equal(project.settings.levelFilter, 'all', 'an unknown level filter falls back')
  const run = project.sheets[0].items[0]
  assert.equal(run.kind === 'run' && run.flow, 'none')
})

test('mounting levels survive a round trip, unknown ones fall back', () => {
  const project = sampleProject()
  const sheet = project.sheets[0]
  sheet.items[1].level = 'on-wall'   // the distribution board hangs on a wall
  sheet.items[2].level = 'on-floor'  // the cylinder stands on the floor
  const restored = parseProject(serialize(project))
  assert.equal(restored.sheets[0].items[1].level, 'on-wall')
  assert.equal(restored.sheets[0].items[2].level, 'on-floor')

  const junk = parseProject(JSON.stringify({
    version: 1,
    sheets: [{ id: 's', name: 'S', items: [{ kind: 'box', id: 'b', level: 'on-the-moon' }] }],
  }))
  assert.equal(junk.sheets[0].items[0].level, 'wall')
})

test('a file with no systems falls back to the default catalogue', () => {
  const project = parseProject(JSON.stringify({ version: 1, sheets: [], systems: [] }))
  assert.ok(project.systems.length > 20)
  assert.ok(project.systems.some((s) => s.id === 'reuse.dist'))
})
