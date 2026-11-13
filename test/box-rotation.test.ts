import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setBoxRotation } from '../src/interact/arrange.ts'
import { boxContains, boxCorners, itemBounds } from '../src/render/bounds.ts'
import { hitsItem } from '../src/interact/hittest.ts'
import { buildGraph } from '../src/topology.ts'
import { emptyProject } from '../src/model/doc.ts'
import { parseProject, serialize } from '../src/io/projectFile.ts'
import type { BoxItem, Item } from '../src/model/types.ts'

const box = (id: string, x: number, y: number, w: number, h: number, rotationDeg?: number): BoxItem => ({
  kind: 'box', id, systemId: 'power.board', level: 'on-wall', x, y, w, h, ...(rotationDeg ? { rotationDeg } : {}),
})
const close = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6

test('a turned box is hit, bounded and joined where it is drawn', () => {
  // 100 x 10 turned a quarter: now a tall thin box centred on (50, 5).
  const b = box('b', 0, 0, 100, 10, 90)
  const corners = boxCorners(b)
  assert.ok(close(corners[0].x, 55) && close(corners[0].y, -45), JSON.stringify(corners[0]))
  const r = itemBounds(b)
  assert.ok(close(r.x, 45) && close(r.w, 10) && close(r.y, -45) && close(r.h, 100), JSON.stringify(r))
  assert.ok(boxContains(b, { x: 50, y: -40 }))
  assert.ok(!boxContains(b, { x: 90, y: 5 }), 'where the unturned box was is now empty')
  assert.ok(hitsItem(b, { x: 45, y: 30 }, 1))
  assert.ok(!hitsItem(b, { x: 2, y: 5 }, 1))

  const run: Item = { kind: 'run', id: 'r', systemId: 'power.board', level: 'wall', flow: 'none', points: [{ x: 50, y: -45 }, { x: 50, y: -200 }] }
  const g = buildGraph({ id: 's', name: 'S', pdf: null, mmPerPoint: 1, items: [b, run] })
  assert.ok(g.connections.get('r')?.some((c) => c.otherId === 'b'))
})

test('rotation is normalised, dropped at zero, and survives a save', () => {
  const b = box('b', 0, 0, 10, 10)
  setBoxRotation(b, -90)
  assert.equal(b.rotationDeg, 270)
  setBoxRotation(b, 360)
  assert.equal(b.rotationDeg, undefined)
  setBoxRotation(b, 45)
  const project = emptyProject()
  project.sheets[0].items.push(b)
  const back = parseProject(serialize(project)).sheets[0].items[0] as BoxItem
  assert.equal(back.rotationDeg, 45)
})
