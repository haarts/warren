import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TypeSafeClient } from '@typesafe-ai/sdk'
import { catalogue } from '../agent/catalog.ts'
import { selectItems } from '../agent/select.ts'
import { AgentError } from '../agent/errors.ts'
import { DEFAULT_SETTINGS, type Project, type Sheet, type Item } from '../src/model/types.ts'

const system = { id: 'power.230v', category: 'power' as const, name: '230V group', color: '#000', dash: [], width: 1, visible: true, locked: false }

function projectWith(items: Item[]): Project {
  const sheet: Sheet = { id: 's1', name: 'Beneden verdieping', pdf: null, mmPerPoint: 20, items }
  return {
    version: 1,
    name: 'Test',
    systems: [system],
    sheets: [sheet],
    assets: {},
    settings: { ...DEFAULT_SETTINGS },
    activeSheetId: 's1',
  }
}

const room = (): Item => ({
  kind: 'room', id: 'room_k', systemId: 'power.230v', level: 'floor',
  name: 'Keuken', use: 'kitchen', ref: '0.04',
  points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
})

const marker = (id: string, x: number, y: number, label?: string): Item => ({
  kind: 'marker', id, systemId: 'power.230v', level: 'ceiling', x, y, symbol: 'light', ...(label ? { label } : {}),
})

test('a candidate says which room it is in, read from geometry', () => {
  const candidates = catalogue(projectWith([room(), marker('inside', 50, 50), marker('outside', 150, 150)]))
  const inside = candidates.find((c) => c.id === 'inside')
  const outside = candidates.find((c) => c.id === 'outside')
  assert.match(inside?.description ?? '', /0\.04 Keuken/, 'inside the polygon is in the room')
  assert.doesNotMatch(outside?.description ?? '', /Keuken/, 'outside it is not')
  assert.match(inside?.description ?? '', /Lichtpunt \(light point\) \(light\)/, 'the symbol is spelled out')
  assert.equal(candidates.find((c) => c.id === 'room_k')?.kind, 'room')
})

/** A client that answers without touching the network; the judgement logic is what is tested. */
function fake(answers: {
  target: { choice: string; confidence: number; probabilities: Record<string, number> }
  match: { noul: number }
}): TypeSafeClient {
  return {
    systemOne: async () => ({ answers, model: 'jev-test', usage: { input_tokens: 1, output_tokens: 1 } }),
  } as unknown as TypeSafeClient
}

const candidates = () => [
  { id: 'a', kind: 'marker' as const, sheet: 'S', description: 'light in the kitchen' },
  { id: 'b', kind: 'marker' as const, sheet: 'S', description: 'socket in the hall' },
]

test('the best match is chosen and the rest are ranked behind it', async () => {
  const selection = await selectItems(
    fake({ target: { choice: 'a', confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } }, match: { noul: 0.95 } }),
    'the kitchen light',
    candidates(),
  )
  assert.equal(selection.matched, true)
  assert.equal(selection.verdict, 'match')
  assert.equal(selection.chosenId, 'a')
  assert.deepEqual(selection.ranking.map((r) => r.id), ['a', 'b'])
  assert.equal(selection.model, 'jev-test')
})

test('a doubtful match is still pointed at, but flagged as uncertain', async () => {
  const selection = await selectItems(
    fake({ target: { choice: 'a', confidence: 0.4, probabilities: { a: 0.55, b: 0.45 } }, match: { noul: 0.5 } }),
    'that light maybe',
    candidates(),
  )
  assert.equal(selection.matched, true)
  assert.equal(selection.verdict, 'uncertain')
  assert.equal(selection.chosenId, 'a')
})

test('a drawing with nothing that fits points at nothing', async () => {
  const selection = await selectItems(
    fake({ target: { choice: 'a', confidence: 0.4, probabilities: { a: 0.6, b: 0.4 } }, match: { noul: 0.2 } }),
    'a purple giraffe',
    candidates(),
  )
  assert.equal(selection.matched, false)
  assert.equal(selection.chosenId, null)
  assert.match(selection.reason ?? '', /no item/)
})

test('a match spread evenly over many items is too vague to act on', async () => {
  const wide = Array.from({ length: 12 }, (_, i) => ({
    id: `i${i}`,
    kind: 'marker' as const,
    sheet: 'S',
    description: `item ${i}`,
  }))
  const probabilities = Object.fromEntries(wide.map((c) => [c.id, 0.083]))
  const selection = await selectItems(
    fake({ target: { choice: 'i0', confidence: 0.1, probabilities }, match: { noul: 0.8 } }),
    'something',
    wide,
  )
  assert.equal(selection.matched, false)
  assert.match(selection.reason ?? '', /vague/)
})

test('more candidates than one Choice can hold is refused rather than guessed', async () => {
  const many = Array.from({ length: 256 }, (_, i) => ({
    id: `i${i}`,
    kind: 'marker' as const,
    sheet: 'S',
    description: `item ${i}`,
  }))
  await assert.rejects(
    selectItems(fake({ target: { choice: 'i0', confidence: 1, probabilities: { i0: 1 } }, match: { noul: 1 } }), 'x', many),
    (err: unknown) => err instanceof AgentError && /255/.test(err.message),
  )
})
