import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../bin/warren.ts', import.meta.url))
const PDF = fileURLToPath(new URL('../samples/sample-floorplan.pdf', import.meta.url))

function warren(args: string[], cwd: string): { out: string; code: number } {
  try {
    return { out: execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' }), code: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number }
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 }
  }
}

/** A project on a calibrated sheet, referencing the sample plan by hash. */
async function fixture(): Promise<{ dir: string; file: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'warren-cli-'))
  const bytes = new Uint8Array(readFileSync(PDF))
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer)
  const id = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  writeFileSync(join(dir, 'plan.pdf'), bytes)
  const project = {
    version: 1,
    name: 'Test house',
    systems: [],
    assets: { [id]: { name: 'plan.pdf', bytes: bytes.length } },
    activeSheetId: 's1',
    sheets: [{
      id: 's1',
      name: 'Ground floor',
      mmPerPoint: 20,
      pdf: { assetId: id, page: 1, rotation: 0, widthPt: 842, heightPt: 595 },
      items: [
        { kind: 'run', id: 'r1', systemId: 'water.cold', level: 'floor', points: [{ x: 100, y: 100 }, { x: 600, y: 100 }], size: 'Ø16', flow: 'none' },
        { kind: 'run', id: 'r2', systemId: 'drain.soil', level: 'crawl', points: [{ x: 100, y: 300 }, { x: 300, y: 300 }], size: 'Ø110', flow: 'none' },
      ],
    }],
  }
  const file = join(dir, 'test.warren.json')
  writeFileSync(file, JSON.stringify(project, null, 2))
  return { dir, file: 'test.warren.json' }
}

test('summary reports metres, not points', async () => {
  const { dir, file } = await fixture()
  const { out } = warren(['summary', file, '--json'], dir)
  const data = JSON.parse(out)
  assert.equal(data.name, 'Test house')
  assert.equal(data.sheets[0].calibrated, true)
  // 500 pt + 200 pt at 20 mm/pt = 14 m
  assert.equal(data.totalPlanM, 14)
  assert.deepEqual(data.missingAssets, [], 'finds the plan PDF sitting next to the project')
})

test('items are reported with real-world positions and lengths', async () => {
  const { dir, file } = await fixture()
  const rows = JSON.parse(warren(['items', file, '--system', 'water.*', '--json'], dir).out)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'r1')
  assert.equal(rows[0].lengthM, 10, '500 pt at 20 mm/pt is 10 m')
  assert.deepEqual(rows[0].atM, [2, 2])
})

test('check finds what the parser would quietly forgive', async () => {
  const { dir, file } = await fixture()
  const project = JSON.parse(readFileSync(join(dir, file), 'utf8'))
  project.sheets[0].items.push(
    { kind: 'run', id: 'dup', systemId: 'water.cold', level: 'floor', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], flow: 'none' },
    { kind: 'run', id: 'dup', systemId: 'nope.missing', level: 'floor', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], flow: 'none' },
    // Metres written where points were expected - the classic machine-writing mistake.
    { kind: 'marker', id: 'far', systemId: 'water.cold', level: 'wall', x: 12, y: 9000, symbol: 'valve' },
  )
  writeFileSync(join(dir, file), JSON.stringify(project))

  const { out, code } = warren(['check', file, '--json'], dir)
  const rules = JSON.parse(out).findings.map((f: { rule: string }) => f.rule)
  assert.ok(rules.includes('duplicate-id'))
  assert.ok(rules.includes('unknown-system'))
  assert.ok(rules.includes('off-page'), 'coordinates far off the page are flagged')
  assert.ok(rules.includes('no-direction'), 'a drain with no fall direction is flagged')
  assert.equal(code, 1, 'errors exit non-zero so CI can use it')
})

test('an assumed direction is reported once, not once per run', async () => {
  const { dir, file } = await fixture()
  const project = JSON.parse(readFileSync(join(dir, file), 'utf8'))
  for (const item of project.sheets[0].items) {
    if (item.kind === 'run') { item.flow = 'forward'; item.flowAssumed = true }
  }
  writeFileSync(join(dir, file), JSON.stringify(project))

  const result = JSON.parse(warren(['check', file, '--json'], dir).out)
  const assumed = result.findings.filter((f: { rule: string }) => f.rule === 'direction-assumed')
  assert.equal(assumed.length, 1, 'one finding however many runs are assumed')
  assert.equal(assumed[0].itemIds.length, 2, 'but every one of them is listed, so a fixer can work through them')
  assert.equal(result.findings.some((f: { rule: string }) => f.rule === 'no-direction'), false)
})

test('check refuses a non-potable cross-connection', async () => {
  const { dir, file } = await fixture()
  const project = JSON.parse(readFileSync(join(dir, file), 'utf8'))
  project.sheets[0].items.push({
    kind: 'run', id: 'rain', systemId: 'reuse.dist', level: 'floor',
    points: [{ x: 100, y: 100 }, { x: 100, y: 400 }], flow: 'none',
  })
  writeFileSync(join(dir, file), JSON.stringify(project))
  const findings = JSON.parse(warren(['check', file, '--json'], dir).out).findings
  const cross = findings.find((f: { rule: string }) => f.rule === 'cross-connection')
  assert.ok(cross, 'non-potable sharing an endpoint with drinking water is an error')
  assert.equal(cross.severity, 'error')
  assert.ok(cross.itemIds.includes('rain') && cross.itemIds.includes('r1'), 'names both sides')
})

test('apply validates the whole batch before writing any of it', async () => {
  const { dir, file } = await fixture()
  const before = readFileSync(join(dir, file), 'utf8')
  writeFileSync(join(dir, 'ops.json'), JSON.stringify({
    ops: [
      { op: 'set', id: 'r1', patch: { size: 'Ø20' } },
      { op: 'set', id: 'r1', patch: { level: 'in-the-roof' } },
    ],
  }))
  const { out, code } = warren(['apply', file, 'ops.json'], dir)
  assert.equal(code, 1)
  assert.match(out, /in-the-roof/)
  assert.equal(readFileSync(join(dir, file), 'utf8'), before, 'a bad op leaves the file untouched')
})

test('apply accepts metres and converts them to the sheet scale', async () => {
  const { dir, file } = await fixture()
  writeFileSync(join(dir, 'ops.json'), JSON.stringify({
    ops: [{ op: 'add', item: { kind: 'run', systemId: 'power.230v', level: 'wall', pointsM: [[1, 1], [6, 1]] } }],
  }))
  assert.equal(warren(['apply', file, 'ops.json'], dir).code, 0)
  const rows = JSON.parse(warren(['items', file, '--system', 'power.230v', '--json'], dir).out)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].lengthM, 5, '5 m asked for, 5 m measured back')
  assert.deepEqual(rows[0].atM, [1, 1])
  assert.equal(rows[0].size, '3×2.5mm²', 'a new run takes its system default')
})

test('split and bundle are inverses', async () => {
  const { dir, file } = await fixture()
  const original = JSON.parse(readFileSync(join(dir, file), 'utf8'))

  assert.equal(warren(['bundle', file, '--out', 'one-file.json'], dir).code, 0)
  const bundled = JSON.parse(readFileSync(join(dir, 'one-file.json'), 'utf8')) as { assets: Record<string, { data?: string }> }
  assert.equal(typeof Object.values(bundled.assets)[0]?.data, 'string', 'bundling puts the bytes in')
  assert.ok(readFileSync(join(dir, 'one-file.json')).length > readFileSync(join(dir, file)).length)

  // Splitting a bundle writes the PDF out and shrinks the file back down.
  const { out } = warren(['split', 'one-file.json', '--assets', '.'], dir)
  assert.match(out, /MB|KB/)
  const resplit = JSON.parse(readFileSync(join(dir, 'one-file.json'), 'utf8')) as { assets: Record<string, object>; sheets: unknown }
  assert.equal('data' in (Object.values(resplit.assets)[0] ?? {}), false, 'splitting takes the bytes out again')
  assert.deepEqual(resplit.sheets, original.sheets, 'the drawing survives both directions')
  assert.ok(existsSync(join(dir, 'plan.pdf')))
})

test('a project whose plan is not beside it still reads, and says so', async () => {
  const { dir, file } = await fixture()
  const { out, code } = warren(['summary', file, '--json', '--assets', join(dir, 'elsewhere')], dir)
  assert.equal(code, 0, 'a missing plan is not a fatal error')
  assert.equal(JSON.parse(out).missingAssets.length, 1)
})

test('systems can be merged, taking their items with them', async () => {
  const { dir, file } = await fixture()
  const project = JSON.parse(readFileSync(join(dir, file), 'utf8'))
  project.systems = [
    { id: 'power.light', category: 'power', name: 'Lighting', color: '#ca8a04', dash: [], width: 1.4 },
    { id: 'power.socket', category: 'power', name: 'Sockets', color: '#ea580c', dash: [], width: 1.7 },
    { id: 'water.cold', category: 'water', name: 'Cold', color: '#2563eb', dash: [], width: 1.8 },
  ]
  project.sheets[0].items.push(
    { kind: 'run', id: 'l1', systemId: 'power.light', level: 'wall', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], flow: 'none' },
    { kind: 'run', id: 's1', systemId: 'power.socket', level: 'wall', points: [{ x: 0, y: 5 }, { x: 10, y: 5 }], flow: 'none' },
  )
  writeFileSync(join(dir, file), JSON.stringify(project))

  const { out, code } = warren(['systems', file, '--merge', 'power.light,power.socket', '--into', 'power.230v'], dir)
  assert.equal(code, 0, out)
  assert.match(out, /moved 2 item/)

  const after = JSON.parse(readFileSync(join(dir, file), 'utf8'))
  assert.deepEqual(after.systems.map((s: { id: string }) => s.id).sort(), ['power.230v', 'water.cold'])
  const items = after.sheets[0].items.filter((i: { id: string }) => i.id === 'l1' || i.id === 's1')
  assert.deepEqual(items.map((i: { systemId: string }) => i.systemId), ['power.230v', 'power.230v'])
  // The cold water run is none of its business.
  assert.ok(after.sheets[0].items.some((i: { systemId: string }) => i.systemId === 'water.cold'))
})

test('a merge that makes no sense is refused before anything is written', async () => {
  const { dir, file } = await fixture()
  const before = readFileSync(join(dir, file), 'utf8')
  for (const args of [
    ['systems', file, '--merge', 'power.nope', '--into', 'power.230v'],
    ['systems', file, '--merge', 'water.cold', '--into', 'water.cold'],
    ['systems', file, '--merge', 'water.cold'],
  ]) {
    const { code } = warren(args, dir)
    assert.equal(code, 2, args.join(' '))
  }
  assert.equal(readFileSync(join(dir, file), 'utf8'), before)
})

/** A project with two rooms, so scoping has something to get wrong. */
async function twoRooms(): Promise<{ dir: string; file: string }> {
  const made = await fixture()
  const project = JSON.parse(readFileSync(join(made.dir, made.file), 'utf8'))
  project.sheets[0].items = [
    { kind: 'room', id: 'k', systemId: 'struct.room', level: 'floor', name: 'Keuken', use: 'kitchen',
      points: [{ x: 100, y: 100 }, { x: 400, y: 100 }, { x: 400, y: 300 }, { x: 100, y: 300 }] },
    { kind: 'room', id: 'b', systemId: 'struct.room', level: 'floor', name: 'Bijkeuken', use: 'utility',
      points: [{ x: 500, y: 100 }, { x: 800, y: 100 }, { x: 800, y: 300 }, { x: 500, y: 300 }] },
  ]
  writeFileSync(join(made.dir, made.file), JSON.stringify(project))
  return made
}

const markers = (dir: string, file: string): { id: string; from: string }[] =>
  JSON.parse(readFileSync(join(dir, file), 'utf8')).sheets[0].items
    .filter((i: { kind: string }) => i.kind === 'marker')
    .map((i: { id: string; generated?: { from: string } }) => ({ id: i.id, from: i.generated?.from ?? '' }))

test('generate can be scoped to one room, and says which it found', async () => {
  const { dir, file } = await twoRooms()
  const { out } = warren(['generate', file, '--rule', 'sockets', '--room', 'Keuken'], dir)
  assert.match(out, /in Keuken/)
  assert.equal(markers(dir, file).length, 8, 'the Bijkeuken is not swept up by a substring')
  assert.ok(markers(dir, file).every((m) => m.from === 'k'))
})

test('a second room can be generated without disturbing the first', async () => {
  const { dir, file } = await twoRooms()
  warren(['generate', file, '--rule', 'sockets', '--room', 'Keuken'], dir)
  warren(['generate', file, '--rule', 'sockets', '--room', 'Bijkeuken'], dir)
  const all = markers(dir, file)
  assert.equal(all.length, 16)
  assert.equal(all.filter((m) => m.from === 'k').length, 8)

  // And clearing one leaves the other be.
  warren(['generate', file, '--rule', 'sockets', '--room', 'Keuken', '--clear'], dir)
  const left = markers(dir, file)
  assert.equal(left.length, 8)
  assert.ok(left.every((m) => m.from === 'b'))
})

test('--set tries a parameter without keeping it, --save keeps it', async () => {
  const { dir, file } = await twoRooms()
  const trial = warren(['generate', file, '--rule', 'sockets', '--room', 'Keuken', '--set', 'perWall=3', '--dry-run'], dir)
  assert.match(trial.out, /12 placed/, 'three per wall on four walls')
  assert.match(trial.out, /nothing written/)
  assert.equal(markers(dir, file).length, 0, 'a dry run writes nothing at all')

  warren(['generate', file, '--rule', 'sockets', '--room', 'Keuken', '--set', 'perWall=3,insetMm=600'], dir)
  assert.equal(markers(dir, file).length, 12)
  // The rule itself is untouched, so the next room gets the original two per wall.
  warren(['generate', file, '--rule', 'sockets', '--room', 'Bijkeuken'], dir)
  assert.equal(markers(dir, file).filter((m) => m.from === 'b').length, 8)

  warren(['generate', file, '--rule', 'sockets', '--room', 'Bijkeuken', '--set', 'perWall=3', '--save'], dir)
  const rules = JSON.parse(warren(['rules', file, '--json'], dir).out)
  assert.equal(rules.find((r: { id: string }) => r.id === 'sockets').perWall, 3, 'saved this time')
})

test('a nonsense --set is refused with the fields that do exist', async () => {
  const { dir, file } = await twoRooms()
  const bad = warren(['generate', file, '--rule', 'sockets', '--set', 'perWal=3'], dir)
  assert.equal(bad.code, 2)
  assert.match(bad.out, /perWall/, 'names the real fields')
  const notNumber = warren(['generate', file, '--rule', 'sockets', '--set', 'perWall=lots'], dir)
  assert.equal(notNumber.code, 2)
  assert.match(notNumber.out, /wants a number/)
  assert.equal(warren(['generate', file, '--rule', 'nope'], dir).code, 2, 'and an unknown rule')
})
