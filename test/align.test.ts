import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { calibrationAgreement, floorMapping, mapItem, scaleFromAlignment } from '../src/align.ts'
import { runChecks } from '../src/check.ts'
import { emptyProject, Store } from '../src/model/doc.ts'
import { parseProject, serialize } from '../src/io/projectFile.ts'
import type { BoxItem, MarkerItem, Sheet } from '../src/model/types.ts'

const sheet = (id: string, align?: Sheet['align'], mmPerPoint: number | null = 10): Sheet =>
  ({ id, name: id, pdf: null, mmPerPoint, items: [], ...(align ? { align } : {}) })
const near = (a: { x: number; y: number }, b: { x: number; y: number }): boolean =>
  Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9

// The upper floor's drawing sits 50 pt further right, turned a quarter, at twice the size.
const lower = sheet('lower', { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } }, 10)
const upper = sheet('upper', { a: { x: 50, y: 0 }, b: { x: 50, y: 200 } }, 5)

test('a point is carried between floors by their two reference points, not by its coordinates', () => {
  const m = floorMapping(lower, upper)!
  assert.ok(near(m.apply({ x: 0, y: 0 }), { x: 50, y: 0 }))
  assert.ok(near(m.apply({ x: 100, y: 0 }), { x: 50, y: 200 }))
  assert.ok(near(m.apply({ x: 50, y: 10 }), { x: 30, y: 100 }), JSON.stringify(m.apply({ x: 50, y: 10 })))
  assert.equal(m.scale, 2)
  assert.equal(Math.round(m.turnDeg), 90)
  // And back again.
  const back = floorMapping(upper, lower)!
  assert.ok(near(back.apply(m.apply({ x: 37, y: -12 })), { x: 37, y: -12 }))
})

test('no alignment, no mapping', () => {
  assert.equal(floorMapping(lower, sheet('loose')), null)
})

test('calibrations are compared over the same physical distance', () => {
  // 100 pt at 10 mm and 200 pt at 5 mm: both 1 m. They agree.
  assert.equal(calibrationAgreement(lower, upper)!.off, 0)
  const off = { ...upper, mmPerPoint: 5.2 }
  assert.ok(Math.abs(calibrationAgreement(lower, off)!.off - 0.04 / 1.04) < 1e-9)
  // An uncalibrated floor can take its scale from an aligned, calibrated one.
  assert.equal(scaleFromAlignment({ ...upper, mmPerPoint: null }, lower), 5)
})

test('an item copied between floors keeps its place and size in the building', () => {
  const m = floorMapping(lower, upper)!
  const box: BoxItem = { kind: 'box', id: 'b', systemId: 's', level: 'floor', x: 10, y: 10, w: 20, h: 10 }
  const moved = mapItem(box, m) as BoxItem
  assert.equal(moved.w, 40)
  assert.equal(moved.rotationDeg, 90)
  const centre = m.apply({ x: 20, y: 15 })
  assert.ok(near({ x: moved.x + moved.w / 2, y: moved.y + moved.h / 2 }, centre))
  const marker: MarkerItem = { kind: 'marker', id: 'm', systemId: 's', level: 'floor', x: 100, y: 0, symbol: 'riser-up' }
  assert.ok(near(mapItem(marker, m) as MarkerItem, { x: 50, y: 200 }))
})

test('alignment survives a save, and check reports floors that disagree about the scale', () => {
  const project = emptyProject()
  project.sheets = [lower, { ...upper, mmPerPoint: 5.5 }]
  project.alignNames = ['A1', 'C4']
  const back = parseProject(serialize(project))
  assert.deepEqual(back.sheets[0].align, lower.align)
  assert.deepEqual(back.alignNames, ['A1', 'C4'])
  const store = new Store()
  store.loadProject(back, null)
  const finding = runChecks(store).find((f) => f.rule === 'floors-disagree')
  assert.ok(finding, 'a 10% disagreement is reported')
  assert.match(finding!.message, /1\.00 m .* 1\.10 m/)
})

test('warren align records the points in metres and reports the floors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'warren-align-'))
  const project = emptyProject()
  project.sheets = [sheet('s1', undefined, 20), sheet('s2', undefined, 20)]
  project.sheets[0].name = 'Ground'
  project.sheets[1].name = 'Upper'
  writeFileSync(join(dir, 'h.warren.json'), serialize(project))
  const cli = fileURLToPath(new URL('../bin/warren.ts', import.meta.url))
  const run = (...args: string[]): string => execFileSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' })
  run('align', 'h.warren.json', '--sheet', '1', '--a', '1,1', '--b', '9,1', '--names', 'A1, D1')
  run('align', 'h.warren.json', '--sheet', '2', '--a', '2,1', '--b', '10,1')
  const report = JSON.parse(run('align', 'h.warren.json', '--json'))
  assert.deepEqual(report.names, ['A1', 'D1'])
  assert.deepEqual(report.sheets[0].a, [1, 1])
  assert.equal(report.sheets[1].against.scale, 1)
  assert.equal(report.calibration[0].agrees, true)
})

test('nudging this floor\'s pair moves, turns and sizes the floor seen through it by exactly that', async () => {
  const { nudgeAlignment } = await import('../src/align.ts')
  const pivot = { x: 30, y: 40 }
  const ghostOf = (here: Sheet) => floorMapping(lower, here)!
  const before = ghostOf(upper)
  const spot = { x: 70, y: 20 }
  const was = before.apply(spot)

  const shifted = { ...upper, align: nudgeAlignment(upper.align!, { dx: 3, dy: -2, pivot }) }
  assert.ok(near(ghostOf(shifted).apply(spot), { x: was.x + 3, y: was.y - 2 }))

  const turned = { ...upper, align: nudgeAlignment(upper.align!, { turnDeg: 90, pivot }) }
  // A quarter turn clockwise on screen (y down) about the pivot: (dx, dy) -> (-dy, dx).
  assert.ok(near(ghostOf(turned).apply(spot), { x: pivot.x - (was.y - pivot.y), y: pivot.y + (was.x - pivot.x) }))
  assert.equal(Math.round(ghostOf(turned).turnDeg), Math.round(before.turnDeg + 90))

  const grown = { ...upper, align: nudgeAlignment(upper.align!, { factor: 1.01, pivot }) }
  assert.ok(Math.abs(ghostOf(grown).scale / before.scale - 1.01) < 1e-12)
  assert.ok(near(ghostOf(grown).apply(spot), { x: pivot.x + (was.x - pivot.x) * 1.01, y: pivot.y + (was.y - pivot.y) * 1.01 }))
})
