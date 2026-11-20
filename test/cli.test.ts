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

test('apply adds a box by corner and size, and reshapes an item in place', async () => {
  const { dir, file } = await fixture()
  writeFileSync(join(dir, 'ops.json'), JSON.stringify({
    ops: [
      { op: 'add', item: { kind: 'box', systemId: 'power.230v', level: 'on-floor', label: 'rack', xM: 2, yM: 3, wM: 0.6, hM: 0.8, rotationDeg: 90 } },
      { op: 'add', item: { kind: 'run', systemId: 'power.230v', pointsM: [[1, 1], [6, 1]] } },
    ],
  }))
  assert.equal(warren(['apply', file, 'ops.json'], dir).code, 0)
  const sheet = (): { mmPerPoint: number; items: Record<string, never>[] } => JSON.parse(readFileSync(join(dir, file), 'utf8')).sheets[0]
  const box = sheet().items.find((i) => i.kind === 'box' && i.label === 'rack') as unknown as { x: number; w: number; h: number; rotationDeg: number }
  const m = (pt: number): number => Math.round(pt * sheet().mmPerPoint) / 1000
  assert.deepEqual([m(box.x), m(box.w), m(box.h), box.rotationDeg], [2, 0.6, 0.8, 90])

  const run = JSON.parse(warren(['items', file, '--system', 'power.230v', '--json'], dir).out).find((r: { lengthM: number }) => r.lengthM === 5)
  writeFileSync(join(dir, 'ops.json'), JSON.stringify({ ops: [{ op: 'set', id: run.id, patch: { pointsM: [[1, 1], [6, 1], [6, 4]] } }] }))
  assert.equal(warren(['apply', file, 'ops.json'], dir).code, 0)
  const after = JSON.parse(warren(['items', file, '--system', 'power.230v', '--json'], dir).out).find((r: { id: string }) => r.id === run.id)
  assert.equal(after.lengthM, 8, 'same id, new outline')

  writeFileSync(join(dir, 'ops.json'), JSON.stringify({ ops: [{ op: 'add', item: { kind: 'box', systemId: 'power.230v', xM: 1, yM: 1 } }] }))
  const refused = warren(['apply', file, 'ops.json'], dir)
  assert.equal(refused.code, 1)
  assert.match(refused.out, /wM, hM/)
})

// render drives the built app in headless Chrome; without either there is nothing to test.
const CHROME = [process.env.CHROME_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']
  .find((c) => c && existsSync(c))
const BUILT = existsSync(fileURLToPath(new URL('../dist/render.html', import.meta.url)))

test('render writes a PNG of a region, with the plan, framed and sized as asked', { skip: !CHROME || !BUILT ? 'needs Chrome and npm run build' : false }, async () => {
  const { dir, file } = await fixture()
  const { out, code } = warren(['render', file, '--around', '5,4', '--sizeM', '4,2', '--width', '400', '--grid', '--out', 'spot.png', '--json'], dir)
  assert.equal(code, 0, out)
  const report = JSON.parse(out)
  assert.deepEqual(report.px, [400, 200], 'the longer side gets --width, the other follows the region')
  assert.deepEqual([report.fromM, report.sizeM, report.gridM], [[3, 3], [4, 2], 0.5])
  const png = readFileSync(join(dir, 'spot.png'))
  assert.equal(png.subarray(1, 4).toString(), 'PNG')
  assert.equal(png.readUInt32BE(16), 400)
  assert.equal(png.readUInt32BE(20), 200)

  const framed = warren(['render', file, '--id', 'r1', '--no-plan', '--out', 'r1.png'], dir)
  assert.equal(framed.code, 0, framed.out)
  assert.ok(existsSync(join(dir, 'r1.png')))
  assert.equal(warren(['render', file, '--id', 'nope'], dir).code, 2, 'an unknown id is a wrong command line')
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

test('--as marks what a batch places as unreviewed', async () => {
  const { dir, file } = await fixture()
  writeFileSync(join(dir, 'ops.json'), JSON.stringify({
    ops: [{ op: 'add', item: { kind: 'marker', systemId: 'power.230v', level: 'on-wall', x: 200, y: 200, symbol: 'socket-3' } }],
  }))
  warren(['apply', file, 'ops.json', '--as', 'ai:keuken'], dir)
  const marker = JSON.parse(readFileSync(join(dir, file), 'utf8')).sheets[0].items
    .find((i: { kind: string }) => i.kind === 'marker')
  // It arrives as a suggestion: faint until a person reviews it.
  assert.deepEqual(marker.suggested, { by: 'ai:keuken', via: 'apply' })

  // Without --as it is indistinguishable from something you drew, which is the right default
  // for an edit you made yourself.
  warren(['apply', file, 'ops.json'], dir)
  const plain = JSON.parse(readFileSync(join(dir, file), 'utf8')).sheets[0].items
    .filter((i: { kind: string }) => i.kind === 'marker')
  assert.equal(plain.filter((i: { suggested?: unknown }) => !i.suggested).length, 1)
})

test('items reports which symbol a marker draws with', async () => {
  const { dir, file } = await fixture()
  const project = JSON.parse(readFileSync(join(dir, file), 'utf8'))
  project.sheets[0].items.push(
    { kind: 'marker', id: 'm1', systemId: 'power.smoke', level: 'ceiling', x: 100, y: 100, symbol: 'detector' },
    { kind: 'marker', id: 'm2', systemId: 'power.smoke', level: 'ceiling', x: 200, y: 100, symbol: 'sensor' },
  )
  writeFileSync(join(dir, file), JSON.stringify(project))

  const rows = JSON.parse(warren(['items', file, '--kind', 'marker', '--json'], dir).out) as { id: string; symbol?: string }[]
  // Without this, telling two markers apart means reading the raw file, which is the one thing
  // the command line exists to make unnecessary.
  assert.deepEqual(rows.map((r) => [r.id, r.symbol]), [['m1', 'detector'], ['m2', 'sensor']])
  assert.match(warren(['items', file, '--kind', 'marker'], dir).out, /detector/)
})

test('a new project starts from a file that does not exist yet', async () => {
  const { createProjectFile } = await import('../bin/project.ts')
  const dir = mkdtempSync(join(tmpdir(), 'warren-new-'))
  const file = join(dir, 'Kerkstraat 4.warren.json')
  createProjectFile(file)
  const out = JSON.parse(warren(['summary', file, '--json'], dir).out) as { name?: string }
  assert.ok(existsSync(file))
  assert.equal(out.name, 'Kerkstraat 4')
  assert.equal(warren(['check', file], dir).code, 0)
})

test('calibrate sets one sheet\'s scale, from a printed scale or from another sheet', async () => {
  const { createProjectFile } = await import('../bin/project.ts')
  const dir = mkdtempSync(join(tmpdir(), 'warren-cal-'))
  const file = join(dir, 'two.warren.json')
  createProjectFile(file)
  const project = JSON.parse(readFileSync(file, 'utf8'))
  project.sheets.push({ ...project.sheets[0], id: 'sh_second', name: 'First floor', mmPerPoint: 34.7 })
  writeFileSync(file, JSON.stringify(project))

  assert.equal(warren(['calibrate', file, '--sheet', '1', '--scale', '1:100'], dir).code, 0)
  assert.equal(warren(['calibrate', file, '--sheet', 'first', '--like', '1'], dir).code, 0)
  const sheets = JSON.parse(readFileSync(file, 'utf8')).sheets
  assert.ok(Math.abs(sheets[0].mmPerPoint - 35.2778) < 1e-4, String(sheets[0].mmPerPoint))
  assert.equal(sheets[1].mmPerPoint, sheets[0].mmPerPoint)

  assert.equal(warren(['calibrate', file, '--scale', '1:50'], dir).code, 2, 'two sheets: which one is required')
  assert.equal(warren(['calibrate', file, '--sheet', '1'], dir).code, 2, 'a scale is required')
})
