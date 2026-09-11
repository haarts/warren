import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyProject } from '../src/model/doc.ts'
import { parseProject, projectNameFromFileName, serialize, suggestedFileName } from '../src/io/projectFile.ts'
import type { BoxItem, MarkerItem, NoteItem, RunItem } from '../src/model/types.ts'

function sampleProject() {
  const project = emptyProject()
  const sheet = project.sheets[0]
  sheet.mmPerPoint = 3.527
  sheet.pdf = { assetId: 'abc123', page: 4, rotation: 90, widthPt: 842, heightPt: 595 }
  project.assets.abc123 = { name: 'ground-floor.pdf', bytes: 5 }
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
  const note: NoteItem = {
    kind: 'note', id: 'n1', systemId: 'struct.note', level: 'wall',
    x: 30, y: 40, w: 120, text: 'Check duct height with the architect\nbefore the pour',
  }
  sheet.items.push(run, box, marker, note)
  return project
}

test('a project survives a save/load round trip', () => {
  const original = sampleProject()
  const restored = parseProject(serialize(original))
  assert.deepEqual(restored, original)
})

test('unreferenced PDF assets are dropped on save', () => {
  const project = sampleProject()
  project.assets.orphan = { name: 'stale.pdf', bytes: 3 }
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

test('notes round trip, and a broken one is repaired rather than dropped', () => {
  const restored = parseProject(serialize(sampleProject()))
  const note = restored.sheets[0].items[3]
  assert.equal(note.kind, 'note')
  assert.equal(note.kind === 'note' && note.text.includes('architect'), true)
  assert.equal(note.kind === 'note' && note.w, 120)

  const odd = parseProject(JSON.stringify({
    version: 1,
    sheets: [{ id: 's', name: 'S', items: [{ kind: 'note', id: 'n', w: 2, x: 1, y: 1 }] }],
  })).sheets[0].items[0]
  assert.equal(odd.kind === 'note' && odd.w >= 30, true, 'a silly width is clamped, not honoured')
  assert.equal(odd.kind === 'note' && odd.text, '', 'missing text becomes empty, not undefined')
})

test('a catalogue written before size lists existed gains them on load', () => {
  const older = JSON.stringify({
    version: 1,
    sheets: [{ id: 's', name: 'S', items: [] }],
    systems: [
      // Exactly how these were written before the field existed: a default, no list.
      { id: 'power.socket', category: 'power', name: '230V socket group', color: '#ea580c', dash: [], width: 1.7, defaultSize: '3×2.5mm²' },
      // A default the user edited away from the seed's first entry.
      { id: 'power.outdoor', category: 'power', name: 'Outdoor feed', color: '#4d7c0f', dash: [7, 4], width: 2, defaultSize: 'XMvK 4×6' },
      // A system that has no size list to inherit.
      { id: 'struct.shaft', category: 'struct', name: 'Shaft', color: '#475569', dash: [14, 5], width: 1.8 },
      // A system of the user's own invention matches no seed.
      { id: 'mine.custom', category: 'water', name: 'Something of mine', color: '#123456', dash: [], width: 1 },
    ],
  })
  const systems = parseProject(older).systems
  const get = (id: string) => systems.find((s) => s.id === id)

  assert.deepEqual(get('power.socket')?.sizes, ['3×2.5mm²', '3×1.5mm²', '3×4mm²'])
  assert.equal(get('power.socket')?.defaultSize, '3×2.5mm²')

  const outdoor = get('power.outdoor')
  assert.equal(outdoor?.defaultSize, 'XMvK 4×6', 'an edited default is never overwritten')
  assert.equal(outdoor?.sizes?.[0], 'XMvK 4×6', 'and stays first, because first is the default')
  assert.ok((outdoor?.sizes?.length ?? 0) > 1, 'the seed suggestions come along too')

  assert.equal(get('struct.shaft')?.sizes, undefined)
  assert.equal(get('mine.custom')?.sizes, undefined, 'a system of your own gains nothing')
})

test('a catalogue written before direction guessing gains it too', () => {
  const older = JSON.stringify({
    version: 1,
    sheets: [{ id: 's', name: 'S', items: [] }],
    systems: [
      { id: 'drain.soil', category: 'drain', name: 'Soil', color: '#b45309', dash: [], width: 3 },
      { id: 'power.socket', category: 'power', name: 'Sockets', color: '#ea580c', dash: [], width: 1.7 },
      // Somebody turned it off on purpose; that must survive.
      { id: 'air.supply', category: 'air', name: 'Supply air', color: '#0891b2', dash: [], width: 3.4, assumeFlow: false },
      { id: 'mine.custom', category: 'water', name: 'Mine', color: '#123456', dash: [], width: 1 },
    ],
  })
  const systems = parseProject(older).systems
  const get = (id: string) => systems.find((s) => s.id === id)
  assert.equal(get('drain.soil')?.assumeFlow, true, 'a drain falls, so it guesses')
  assert.equal(get('power.socket')?.assumeFlow, undefined, 'a socket circuit does not')
  assert.equal(get('air.supply')?.assumeFlow, false, 'an explicit false is a decision, not an absence')
  assert.equal(get('mine.custom')?.assumeFlow, undefined)
})

test('an emptied size list stays empty across a reload', () => {
  const cleared = JSON.stringify({
    version: 1,
    sheets: [{ id: 's', name: 'S', items: [] }],
    systems: [{ id: 'power.socket', category: 'power', name: 'Sockets', color: '#ea580c', dash: [], width: 1.7, sizes: [] }],
  })
  const once = parseProject(cleared)
  assert.deepEqual(once.systems[0].sizes, [], 'clearing the list is a choice, not an absence')
  // And it survives being written back out and read again.
  assert.deepEqual(parseProject(serialize(once)).systems[0].sizes, [])
})

test('an assumed direction survives a save, but cannot exist without one', () => {
  const kept = parseProject(JSON.stringify({
    version: 1,
    sheets: [{ id: 's', name: 'S', items: [
      { kind: 'run', id: 'a', systemId: 'drain.soil', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], flow: 'forward', flowAssumed: true },
      // Nonsense: assumed, but no direction to have assumed. The flag is dropped.
      { kind: 'run', id: 'b', systemId: 'drain.soil', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], flow: 'none', flowAssumed: true },
    ] }],
  })).sheets[0].items
  assert.equal(kept[0].kind === 'run' && kept[0].flowAssumed, true)
  assert.equal(kept[1].kind === 'run' && kept[1].flowAssumed, undefined)
})

test('project name and file name convert both ways', () => {
  assert.equal(suggestedFileName('kelder 2026'), 'kelder-2026.warren.json')
  // Characters that are awkward in a file name are replaced rather than passed through.
  assert.equal(suggestedFileName('Aarts — services'), 'Aarts-_-services.warren.json')
  assert.equal(projectNameFromFileName('house.warren.json'), 'house')
  assert.equal(projectNameFromFileName('house.json'), 'house')
  assert.equal(projectNameFromFileName('ground floor v2.warren.json'), 'ground floor v2')
  assert.equal(projectNameFromFileName('.warren.json'), 'Untitled', 'never yields an empty title')
  assert.equal(projectNameFromFileName('house.ductwork.json'), 'house', 'the former extension still resolves')
  // A name survives the trip out to a file name and back.
  assert.equal(projectNameFromFileName(suggestedFileName('kelder-2026')), 'kelder-2026')
})

test('a file with no systems falls back to the default catalogue', () => {
  const project = parseProject(JSON.stringify({ version: 1, sheets: [], systems: [] }))
  assert.ok(project.systems.length > 20)
  assert.ok(project.systems.some((s) => s.id === 'reuse.dist'))
})
