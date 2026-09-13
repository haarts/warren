/**
 * The command line has to be usable by something that has never read the README. These are the
 * tests for that: that help exists everywhere it is looked for, and — the part that rots — that
 * what it promises is what the commands actually accept.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LEVELS, ITEM_KINDS, MARKER_SYMBOLS, ROOM_USES } from '../src/model/types.ts'
import { PLACEMENTS } from '../src/generate.ts'

const CLI = fileURLToPath(new URL('../bin/warren.ts', import.meta.url))

function warren(args: string[]): { out: string; code: number } {
  try {
    return { out: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }), code: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number }
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 }
  }
}

interface Manifest {
  tool: string
  version: string
  guide: string
  commands: { name: string; summary: string; usage: string[]; writes: boolean; flags: { flag: string }[] }[]
  apply: { ops: { op: string; fields: Record<string, string> }[]; patchable: string[] }
  enums: Record<string, string[]>
  exitCodes: Record<string, string>
}

const manifest = (): Manifest => JSON.parse(warren(['help', '--json']).out) as Manifest

test('help is where anyone would look for it', () => {
  for (const args of [[], ['help'], ['--help'], ['-h']]) {
    const got = warren(args)
    assert.equal(got.code, 0, `warren ${args.join(' ')} should succeed`)
    assert.match(got.out, /read and edit a Warren project/, `warren ${args.join(' ')} should print the overview`)
  }
})

test('--help on a command answers without a project file', () => {
  // The state whoever is asking is usually in: no file yet, or not the one they meant.
  const got = warren(['items', '--help'])
  assert.equal(got.code, 0)
  assert.match(got.out, /warren items —/)
  assert.doesNotMatch(got.out, /which project file/)
  assert.equal(warren(['help', 'apply']).out, warren(['apply', '--help']).out, 'the two spellings agree')
})

test('a near-miss command says what was probably meant', () => {
  for (const [typo, meant] of [['takoff', 'takeoff'], ['sytems', 'systems'], ['aply', 'apply']]) {
    const got = warren([typo])
    assert.equal(got.code, 2)
    assert.match(got.out, new RegExp(`Did you mean "${meant}"`), `${typo} should suggest ${meant}`)
  }
  assert.match(warren(['xyzzy']).out, /no such command: xyzzy\n/, 'and invents nothing when nothing is close')
  assert.equal(warren(['help', 'xyzzy']).code, 2)
})

test('every command in the manifest is a command that runs', () => {
  const { commands } = manifest()
  assert.ok(commands.length >= 12, 'the manifest is not empty')
  for (const { name, summary, usage } of commands) {
    assert.ok(summary.length > 0 && usage.length > 0, `${name} is described`)
    // Reached the loader rather than the dispatcher: the command exists, it just wants a file.
    const got = warren([name])
    assert.equal(got.code, 2)
    assert.match(got.out, /which project file/, `${name} is documented but does not dispatch`)
    assert.equal(warren(['help', name]).code, 0, `${name} has its own help page`)
  }
})

test('the manifest enums are the enums the code uses', () => {
  // They are printed from the same constants, so this is a guard against someone re-typing them.
  const { enums } = manifest()
  assert.deepEqual(enums.level, [...LEVELS])
  assert.deepEqual(enums.itemKind, [...ITEM_KINDS])
  assert.deepEqual(enums.roomUse, [...ROOM_USES])
  assert.deepEqual(enums.markerSymbol, [...MARKER_SYMBOLS])
  assert.deepEqual(enums.placement, [...PLACEMENTS])
  assert.ok(enums.addableKind.every((k) => ITEM_KINDS.includes(k as never)), 'you cannot add a kind that is not a kind')
})

test('the manifest promises the ops apply actually has', () => {
  const { apply, commands } = manifest()
  assert.deepEqual(apply.ops.map((o) => o.op).sort(), ['add', 'delete', 'move', 'set'])
  assert.ok(apply.patchable.includes('label'))
  assert.equal(commands.find((c) => c.name === 'apply')?.writes, true)
  assert.equal(commands.find((c) => c.name === 'summary')?.writes, false)

  const add = apply.ops.find((o) => o.op === 'add')!
  for (const field of ['item.kind', 'item.systemId', 'item.pointsM', 'item.expectM2']) {
    assert.ok(field in add.fields, `add documents ${field}`)
  }
})

test('what the manifest calls patchable is what apply will patch', () => {
  // The list is printed from the same Set the validator checks against; this proves the Set is
  // the one that runs, rather than a copy that agreed with it once.
  const { apply } = manifest()
  const dir = mkdtempSync(join(tmpdir(), 'warren-help-'))
  const file = join(dir, 'p.warren.json')
  writeFileSync(file, JSON.stringify({
    version: 1, name: 'x', systems: [], assets: {}, activeSheetId: 's1',
    sheets: [{
      id: 's1', name: 'Sheet', mmPerPoint: 20, pdf: null,
      items: [{ kind: 'run', id: 'r1', systemId: 'water.cold', level: 'floor', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], size: 'Ø16', flow: 'none' }],
    }],
  }))

  const ops = join(dir, 'ops.json')
  writeFileSync(ops, JSON.stringify([{ op: 'set', id: 'r1', patch: { label: 'ok' } }]))
  assert.equal(warren(['apply', file, ops, '--dry-run']).code, 0, 'a patchable field is accepted')

  writeFileSync(ops, JSON.stringify([{ op: 'set', id: 'r1', patch: { kind: 'room' } }]))
  const refused = warren(['apply', file, ops, '--dry-run'])
  assert.equal(refused.code, 1)
  for (const field of apply.patchable) {
    assert.ok(refused.out.includes(field), `the refusal names ${field}, so the two lists are one list`)
  }
})

test('the guide the manifest points at is the one in the repo', () => {
  const { guide, tool, version, exitCodes } = manifest()
  assert.equal(tool, 'warren')
  assert.equal(guide, 'AGENTS.md')
  assert.match(version, /^\d+\.\d+\.\d+$/, 'a real version, not "unknown"')
  assert.deepEqual(Object.keys(exitCodes).sort(), ['0', '1', '2'])
})
