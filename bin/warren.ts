#!/usr/bin/env node
/**
 * Warren command line. Reads and edits a project file using the same modules the app runs on,
 * so a length reported here is the length the drawing means - there is no second
 * implementation of the geometry to drift out of step.
 *
 * Everything speaks metres. The file stores PDF points and a per-sheet scale; converting at
 * the boundary is this tool's job, not the caller's.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { polygonArea, polygonCentroid, polylineLength, type Pt } from '../src/geom.ts'
import { bytesToBase64, base64ToBytes, sha256Hex } from '../src/io/base64.ts'
import { parseProject, serialize } from '../src/io/projectFile.ts'
import { missingDefaults } from '../src/model/systems.ts'
import { adopt, applyGenerated, generate, rulesOf } from '../src/generate.ts'
import { assetData, registerAsset } from '../src/model/assets.ts'
import { Store } from '../src/model/doc.ts'
import { newId } from '../src/model/ids.ts'
import { isPositioned, pointsOf, ROOM_USES, LEVELS, type Item, type Level, type Project, type RoomUse, type Sheet } from '../src/model/types.ts'
import { computeTakeoff } from '../src/takeoff.ts'
import { countBySeverity, runChecks } from '../src/check.ts'
import { buildGraph, connectionsOf, networkOf } from '../src/topology.ts'

// ---------------------------------------------------------------------------- arguments

interface Args {
  command: string
  positional: string[]
  flags: Record<string, string | true>
}

function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv
  const positional: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]
    if (token.startsWith('--')) {
      const [name, inline] = token.slice(2).split('=')
      if (inline !== undefined) flags[name] = inline
      else if (rest[i + 1] && !rest[i + 1].startsWith('--')) flags[name] = rest[++i]
      else flags[name] = true
    } else {
      positional.push(token)
    }
  }
  return { command, positional, flags }
}

function fail(message: string): never {
  process.stderr.write(`warren: ${message}\n`)
  process.exit(2)
}

// ------------------------------------------------------------------------------- loading

interface Loaded {
  path: string
  project: Project
  store: Store
  /** Asset ids whose bytes could not be found on disk. */
  missingAssets: string[]
}

/**
 * Finds the bytes for each referenced asset next to the project file: by its recorded name,
 * by `<hash>.pdf`, or under `assets/`. The hash is always verified, so a name collision
 * cannot silently attach the wrong plan.
 */
async function resolveAssets(project: Project, projectPath: string, assetDir?: string): Promise<string[]> {
  const here = assetDir ? resolve(assetDir) : dirname(resolve(projectPath))
  const missing: string[] = []
  for (const [id, ref] of Object.entries(project.assets)) {
    if (ref.data) {
      registerAsset(id, ref.data)
      continue
    }
    const candidates = [join(here, ref.name), join(here, `${id}.pdf`), join(here, 'assets', `${id}.pdf`)]
    let found = false
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue
      const bytes = new Uint8Array(readFileSync(candidate))
      if (await sha256Hex(bytes) !== id) continue
      registerAsset(id, bytesToBase64(bytes))
      found = true
      break
    }
    if (!found) missing.push(id)
  }
  return missing
}

async function load(args: Args): Promise<Loaded> {
  const path = args.positional[0]
  if (!path) fail('which project file? usage: warren <command> <file.warren.json>')
  if (!existsSync(path)) fail(`no such file: ${path}`)
  let project: Project
  try {
    project = parseProject(readFileSync(path, 'utf8'))
  } catch (err) {
    fail(`could not read ${path}: ${err instanceof Error ? err.message : err}`)
  }
  const assetDir = typeof args.flags.assets === 'string' ? args.flags.assets : undefined
  const missingAssets = await resolveAssets(project, path, assetDir)
  const store = new Store()
  store.loadProject(project, basename(path))
  return { path, project, store, missingAssets }
}

// -------------------------------------------------------------------------------- units

const metres = (sheet: Sheet, points: number): number | null =>
  sheet.mmPerPoint === null ? null : (points * sheet.mmPerPoint) / 1000

const pointsFromMetres = (sheet: Sheet, m: number): number | null =>
  sheet.mmPerPoint === null ? null : (m * 1000) / sheet.mmPerPoint

const round = (n: number, places = 2): number => Number(n.toFixed(places))

function sheetOf(project: Project, selector: string | true | undefined): Sheet[] {
  if (selector === undefined || selector === true) return project.sheets
  const index = Number(selector)
  if (Number.isInteger(index) && index >= 1 && index <= project.sheets.length) return [project.sheets[index - 1]]
  const byName = project.sheets.filter((s) => s.name.toLowerCase().includes(String(selector).toLowerCase()))
  if (byName.length === 0) fail(`no sheet matching "${selector}". Sheets: ${project.sheets.map((s) => s.name).join(', ')}`)
  return byName
}

const globToRegExp = (pattern: string): RegExp =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i')

// ------------------------------------------------------------------------ item reporting

interface ItemReport {
  id: string
  kind: Item['kind']
  sheet: string
  system: string
  systemId: string
  level: Level
  label?: string
  size?: string
  flow?: string
  lengthM?: number | null
  atM?: [number, number] | null
  text?: string
  use?: string
  areaM2?: number
}

function reportItem(store: Store, sheet: Sheet, item: Item): ItemReport {
  const system = store.system(item.systemId)
  const report: ItemReport = {
    id: item.id,
    kind: item.kind,
    sheet: sheet.name,
    system: system.name,
    systemId: item.systemId,
    level: item.level,
  }
  if (item.kind !== 'note' && item.kind !== 'room' && item.label) report.label = item.label
  if (item.kind === 'room') {
    report.label = [item.ref, item.name].filter(Boolean).join(' ')
    report.use = item.use
    const mm = sheet.mmPerPoint
    if (mm) report.areaM2 = round(Math.abs(polygonArea(item.points)) * (mm / 1000) ** 2, 1)
    report.atM = pointAtM(sheet, polygonCentroid(item.points))
    return report
  }
  if (item.kind === 'door') {
    report.atM = pointAtM(sheet, item.points[0])
    report.label = [item.ref, item.label].filter(Boolean).join(' ')
    return report
  }
  if (item.kind === 'run') {
    if (item.size) report.size = item.size
    if (item.flow !== 'none') report.flow = item.flow
    const len = metres(sheet, polylineLength(item.points))
    report.lengthM = len === null ? null : round(len)
    const first = item.points[0]
    report.atM = pointAtM(sheet, first)
  } else if (item.kind === 'box' || item.kind === 'marker' || item.kind === 'note') {
    report.atM = pointAtM(sheet, { x: item.x, y: item.y })
    if (item.kind === 'note') report.text = item.text
  }
  return report
}

function pointAtM(sheet: Sheet, p: Pt): [number, number] | null {
  const x = metres(sheet, p.x)
  const y = metres(sheet, p.y)
  return x === null || y === null ? null : [round(x), round(y)]
}

// ----------------------------------------------------------------------------- commands

async function cmdSummary(args: Args): Promise<void> {
  const { project, store, missingAssets } = await load(args)
  const takeoff = computeTakeoff(store, 'project')
  const used = takeoff.rows.filter((r) => r.runs + r.boxes + r.markers + r.notes > 0)

  const data = {
    name: project.name,
    sheets: project.sheets.map((sheet) => ({
      name: sheet.name,
      items: sheet.items.length,
      calibrated: sheet.mmPerPoint !== null,
      mmPerPoint: sheet.mmPerPoint === null ? null : round(sheet.mmPerPoint, 4),
      pageMm: sheet.pdf && sheet.mmPerPoint
        ? [round(sheet.pdf.widthPt * sheet.mmPerPoint), round(sheet.pdf.heightPt * sheet.mmPerPoint)]
        : null,
      plan: sheet.pdf ? { page: sheet.pdf.page, rotation: sheet.pdf.rotation } : null,
    })),
    systems: { total: project.systems.length, inUse: used.length },
    items: project.sheets.flatMap((s) => s.items).reduce<Record<string, number>>((acc, i) => {
      acc[i.kind] = (acc[i.kind] ?? 0) + 1
      return acc
    }, {}),
    totalPlanM: round(takeoff.rows.reduce((n, r) => n + r.lengthMm, 0) / 1000, 1),
    totalOrderM: round(takeoff.rows.reduce((n, r) => n + r.orderMm, 0) / 1000, 1),
    missingAssets,
  }

  if (args.flags.json) return void console.log(JSON.stringify(data, null, 2))

  console.log(`${data.name}`)
  for (const sheet of data.sheets) {
    const scale = sheet.calibrated ? `1 pt = ${sheet.mmPerPoint} mm` : 'NOT CALIBRATED'
    const size = sheet.pageMm ? `, ${(sheet.pageMm[0] / 1000).toFixed(2)} × ${(sheet.pageMm[1] / 1000).toFixed(2)} m` : ''
    console.log(`  ${sheet.name.padEnd(24)} ${String(sheet.items).padStart(4)} items   ${scale}${size}`)
  }
  const plural = (kind: string, n: number): string => (n === 1 ? kind : kind === 'box' ? 'boxes' : `${kind}s`)
  console.log(`  ${Object.entries(data.items).map(([k, n]) => `${n} ${plural(k, n)}`).join(', ')}`)
  console.log(`  ${data.systems.inUse} of ${data.systems.total} systems in use`)
  console.log(`  ${data.totalPlanM} m drawn, ${data.totalOrderM} m to order`)
  if (missingAssets.length) console.log(`  plan PDF not found beside this file (${missingAssets.length})`)
}

async function cmdItems(args: Args): Promise<void> {
  const { store, project } = await load(args)
  const sheets = sheetOf(project, args.flags.sheet)
  const systemPattern = typeof args.flags.system === 'string' ? globToRegExp(args.flags.system) : null
  const level = typeof args.flags.level === 'string' ? args.flags.level : null
  const kind = typeof args.flags.kind === 'string' ? args.flags.kind : null

  const rows: ItemReport[] = []
  for (const sheet of sheets) {
    store.setActiveSheet(sheet.id)
    for (const item of sheet.items) {
      if (systemPattern && !systemPattern.test(item.systemId)) continue
      if (level && item.level !== level) continue
      if (kind && item.kind !== kind) continue
      rows.push(reportItem(store, sheet, item))
    }
  }

  if (args.flags.json) return void console.log(JSON.stringify(rows, null, 2))
  if (rows.length === 0) return void console.log('nothing matched')
  for (const r of rows) {
    const where = r.atM ? `@ ${r.atM[0]},${r.atM[1]} m` : '@ uncalibrated'
    const extra = [r.size, r.label, r.text, r.lengthM != null ? `${r.lengthM} m` : null, r.flow]
      .filter(Boolean).join(' · ')
    console.log(`${r.id.padEnd(22)} ${r.kind.padEnd(7)} ${r.system.padEnd(28)} ${r.level.padEnd(9)} ${where.padEnd(22)} ${extra}`)
  }
  console.log(`${rows.length} item${rows.length === 1 ? '' : 's'}`)
}

async function cmdTakeoff(args: Args): Promise<void> {
  const { store } = await load(args)
  const scope = args.flags.scope === 'sheet' ? 'sheet' : 'project'
  const result = computeTakeoff(store, scope)
  const rows = result.rows
    .filter((r) => r.runs + r.boxes + r.markers > 0)
    .map((r) => ({
      systemId: r.system.id,
      system: r.system.name,
      category: r.system.category,
      runs: r.runs,
      planM: round(r.lengthMm / 1000, 1),
      orderM: round(r.orderMm / 1000, 1),
      boxes: r.boxes,
      markers: r.markers,
      bySize: r.bySize.map((t) => ({
        size: t.size, runs: t.runs, planM: round(t.lengthMm / 1000, 1), orderM: round(t.orderMm / 1000, 1),
      })),
    }))

  if (args.flags.json) return void console.log(JSON.stringify({ slackPct: result.slackPct, uncalibrated: result.uncalibrated, rows }, null, 2))
  if (args.flags.csv) {
    // A row per gauge: what you order is a size, not a system.
    console.log('system_id,system,category,size,runs,plan_m,order_m')
    for (const r of rows) {
      for (const t of r.bySize) {
        console.log([r.systemId, JSON.stringify(r.system), r.category, JSON.stringify(t.size), t.runs, t.planM, t.orderM].join(','))
      }
    }
    return
  }
  for (const r of rows) {
    console.log(`${r.system.padEnd(30)} ${String(r.planM).padStart(7)} m  →  ${String(r.orderM).padStart(7)} m to order   ${r.runs} run(s)`)
    if (r.bySize.length > 1) {
      for (const t of r.bySize) {
        console.log(`  ${t.size.padEnd(28)} ${String(t.planM).padStart(7)} m  →  ${String(t.orderM).padStart(7)} m`)
      }
    }
  }
  if (result.uncalibrated.length) console.log(`uncalibrated, no lengths: ${result.uncalibrated.join(', ')}`)
}

// ------------------------------------------------------------------------------- check

/**
 * The rules live in src/check.ts so the app and this tool cannot drift apart on what counts as
 * a problem. Nothing runs unless you type `check`.
 */
async function cmdCheck(args: Args): Promise<void> {
  const { store, missingAssets } = await load(args)
  const findings = runChecks(store, { strict: args.flags.strict === true, missingAssets })
  const counts = countBySeverity(findings)

  if (args.flags.json) {
    console.log(JSON.stringify({ findings, ...counts }, null, 2))
  } else if (findings.length === 0) {
    console.log('nothing to report')
  } else {
    for (const f of findings) {
      console.log(`${f.severity.padEnd(7)} ${f.rule.padEnd(18)} ${f.where.padEnd(34)} ${f.message}`)
    }
    console.log(`${counts.error} error(s), ${counts.warning} warning(s), ${counts.note} note(s)`)
  }
  if (counts.error > 0) process.exit(1)
}

// ---------------------------------------------------------------------------- topology

async function cmdGraph(args: Args): Promise<void> {
  const { project, store } = await load(args)
  const sheets = sheetOf(project, args.flags.sheet)
  const out = sheets.map((sheet) => {
    const graph = buildGraph(sheet)
    const name = (id: string): string => {
      const item = sheet.items.find((i) => i.id === id)
      return item ? store.system(item.systemId).name : id
    }
    return {
      sheet: sheet.name,
      toleranceMm: sheet.mmPerPoint ? round(graph.tolerance * sheet.mmPerPoint, 1) : null,
      networks: graph.networks.map((n) => ({
        items: n.items,
        systems: [...new Set(n.items.map(name))],
        hasEquipment: n.hasEquipment,
      })),
      junctions: graph.junctions.map((j) => ({ atM: pointAtM(sheet, j.at), items: j.items })),
      freeEnds: graph.freeEnds.map((f) => ({ itemId: f.itemId, end: f.end, atM: pointAtM(sheet, f.at) })),
    }
  })

  if (args.flags.json) return void console.log(JSON.stringify(out, null, 2))
  for (const sheet of out) {
    console.log(`${sheet.sheet}  (things within ${sheet.toleranceMm ?? '—'} mm count as joined)`)
    for (const n of sheet.networks.filter((x) => x.items.length > 1)) {
      console.log(`  ${String(n.items.length).padStart(3)} joined: ${n.systems.join(' + ')}${n.hasEquipment ? '' : '  (no equipment)'}`)
    }
    console.log(`  ${sheet.junctions.length} junctions, ${sheet.freeEnds.length} free ends`)
  }
}

async function cmdTrace(args: Args): Promise<void> {
  const { project, store } = await load(args)
  const id = typeof args.flags.id === 'string' ? args.flags.id : args.positional[1]
  if (!id) fail('which item? usage: warren trace <file> --id <item id>')

  for (const sheet of project.sheets) {
    const item = sheet.items.find((i) => i.id === id)
    if (!item) continue
    store.setActiveSheet(sheet.id)
    const graph = buildGraph(sheet)
    const network = networkOf(graph, id)
    const describe = (other: string): string => {
      const o = sheet.items.find((i) => i.id === other)
      return o ? `${o.id} (${o.kind}, ${store.system(o.systemId).name})` : other
    }
    const data = {
      item: reportItem(store, sheet, item),
      connections: connectionsOf(graph, id).map((c) => ({
        itemId: c.otherId, how: c.how, atM: pointAtM(sheet, c.at), what: describe(c.otherId),
      })),
      freeEnds: graph.freeEnds.filter((f) => f.itemId === id).map((f) => ({ end: f.end, atM: pointAtM(sheet, f.at) })),
      network: network ? { size: network.items.length, items: network.items, hasEquipment: network.hasEquipment } : null,
    }
    if (args.flags.json) return void console.log(JSON.stringify(data, null, 2))
    console.log(`${id} — ${data.item.system} on ${sheet.name}`)
    if (data.connections.length === 0) console.log('  joined to nothing')
    for (const c of data.connections) console.log(`  ${c.how.padEnd(11)} ${c.what} @ ${c.atM?.join(',')} m`)
    for (const f of data.freeEnds) console.log(`  free ${f.end.padEnd(6)} @ ${f.atM?.join(',')} m`)
    if (network) console.log(`  in a network of ${network.items.length}${network.hasEquipment ? '' : ', reaching no equipment'}`)
    return
  }
  fail(`no item with id "${id}"`)
}

/**
 * A project carries its own catalogue, so one saved before a system existed does not have it.
 * The app offers this in the Systems editor; without it here, nothing headless could draw a
 * room in an older project.
 */
async function cmdSystems(args: Args): Promise<void> {
  const { project, path } = await load(args)
  const missing = missingDefaults(project.systems)

  if (args.flags['add-missing']) {
    if (missing.length === 0) return void console.log('catalogue is already complete')
    project.systems.push(...missing)
    writeFileSync(path, serialize(project))
    console.log(`added ${missing.length}: ${missing.map((s) => s.id).join(', ')}`)
    return
  }

  if (typeof args.flags.merge === 'string') {
    const into = typeof args.flags.into === 'string' ? args.flags.into : null
    if (!into) fail('usage: warren systems <file> --merge a,b --into c')
    const sources = args.flags.merge.split(',').map((v) => v.trim()).filter(Boolean)
    if (sources.includes(into)) fail(`--into ${into} cannot also be in --merge`)

    const have = new Set(project.systems.map((s) => s.id))
    const unknown = sources.filter((id) => !have.has(id))
    if (unknown.length) fail(`this project has no system called ${unknown.join(', ')}`)

    if (!have.has(into)) {
      const seed = missingDefaults(project.systems).find((s) => s.id === into)
      if (!seed) fail(`no system called ${into}, and it is not one of the built-in defaults either`)
      project.systems.push(seed)
      console.log(`added ${into} from the defaults`)
    }

    let moved = 0
    for (const sheet of project.sheets) {
      for (const item of sheet.items) {
        if (!sources.includes(item.systemId)) continue
        item.systemId = into
        moved += 1
      }
    }
    project.systems = project.systems.filter((s) => !sources.includes(s.id))
    writeFileSync(path, serialize(project))
    console.log(`moved ${moved} item(s) to ${into}, removed ${sources.join(', ')}`)
    return
  }

  if (args.flags.json) {
    return void console.log(JSON.stringify({
      systems: project.systems.map((s) => ({
        id: s.id, name: s.name, category: s.category, sizes: s.sizes ?? null, assumeFlow: s.assumeFlow ?? false,
      })),
      missingDefaults: missing.map((s) => s.id),
    }, null, 2))
  }
  for (const sys of project.systems) {
    console.log(`${sys.id.padEnd(22)} ${sys.category.padEnd(8)} ${sys.name}`)
  }
  if (missing.length) console.log(`\n${missing.length} default system(s) missing: ${missing.map((s) => s.id).join(', ')} — add with --add-missing`)
}

// -------------------------------------------------------------------------- generate

/**
 * Runs the placement rules. Warren supplies the arithmetic; the rules supply the opinion, and
 * the rooms supply the understanding — which came from a person or an AI, not from here.
 */
async function cmdGenerate(args: Args): Promise<void> {
  const { project, store, path } = await load(args)
  const rules = rulesOf(store).filter((r) => r.enabled)
  const only = typeof args.flags.rule === 'string' ? args.flags.rule : null
  const sheets = sheetOf(project, args.flags.sheet)
  const report: Record<string, unknown>[] = []

  for (const sheet of sheets) {
    for (const rule of rules) {
      if (only && rule.id !== only) continue
      const result = generate(sheet, rule)
      report.push({
        sheet: sheet.name,
        rule: rule.id,
        wouldCreate: result.create.length,
        replacing: result.replace.length,
        leftAlone: result.adopted.length,
      })
      if (!args.flags['dry-run']) applyGenerated(sheet, result)
    }
  }

  if (args.flags.json) return void console.log(JSON.stringify(report, null, 2))
  for (const r of report) {
    console.log(`${String(r.sheet).padEnd(22)} ${String(r.rule).padEnd(12)} ${String(r.wouldCreate).padStart(4)} placed, `
      + `${String(r.replacing).padStart(3)} replaced, ${String(r.leftAlone).padStart(3)} left alone (yours)`)
  }
  if (args.flags['dry-run']) return void console.log('nothing written')
  writeFileSync(path, serialize(project))
  console.log(`written to ${basename(path)}`)
}

/** The rules themselves, so they can be read and replaced without opening the app. */
async function cmdRules(args: Args): Promise<void> {
  const { project, store, path } = await load(args)
  if (typeof args.flags.set === 'string') {
    const incoming: unknown = JSON.parse(readFileSync(args.flags.set, 'utf8'))
    const list = Array.isArray(incoming) ? incoming : (incoming as { rules?: unknown }).rules
    if (!Array.isArray(list)) fail('expected an array of rules, or {"rules": [...]}')
    project.rules = list as typeof project.rules
    writeFileSync(path, serialize(project))
    return void console.log(`set ${list.length} rule(s)`)
  }
  const rules = rulesOf(store)
  if (args.flags.json) return void console.log(JSON.stringify(rules, null, 2))
  for (const r of rules) {
    console.log(`${r.id.padEnd(12)} ${r.enabled ? 'on ' : 'off'} ${r.place.padEnd(16)} ${r.systemId.padEnd(16)} ${r.uses?.join(',') ?? 'any room'}`)
  }
  console.log(`\n${project.rules ? 'from this project' : 'built-in defaults; --set rules.json to replace them'}`)
}

// ----------------------------------------------------------------------- split / bundle

async function cmdSplit(args: Args): Promise<void> {
  const { project, path, missingAssets } = await load(args)
  if (missingAssets.length && !Object.values(project.assets).some((a) => a.data)) {
    fail('this file has no PDF inside it and none beside it, so there is nothing to split out')
  }
  const dir = dirname(resolve(path))
  const written: string[] = []
  for (const [id, ref] of Object.entries(project.assets)) {
    const data = ref.data ?? assetData(id)
    if (!data) continue
    const out = join(dir, ref.name)
    if (!existsSync(out)) {
      writeFileSync(out, base64ToBytes(data))
      written.push(ref.name)
    }
  }
  const before = readFileSync(path).length
  writeFileSync(path, serialize(project))
  const after = readFileSync(path).length
  console.log(`${basename(path)}: ${(before / 1024 / 1024).toFixed(2)} MB → ${(after / 1024).toFixed(1)} KB`)
  for (const name of written) console.log(`wrote ${name}`)
  if (!written.length) console.log('plan PDF was already beside it')
}

async function cmdBundle(args: Args): Promise<void> {
  const { project, path, missingAssets } = await load(args)
  if (missingAssets.length) {
    fail(`cannot bundle: the plan PDF is not beside this file (${missingAssets.map((id) => project.assets[id]?.name).join(', ')})`)
  }
  const out = typeof args.flags.out === 'string'
    ? args.flags.out
    : join(dirname(resolve(path)), basename(path).replace(/\.warren\.json$/i, '') + '.bundle.warren.json')
  writeFileSync(out, serialize(project, { bundle: true }))
  console.log(`wrote ${basename(out)} (${(readFileSync(out).length / 1024 / 1024).toFixed(2)} MB, self-contained)`)
}

// -------------------------------------------------------------------------------- apply

interface SetOp { op: 'set'; id: string; patch: Record<string, unknown> }
interface DeleteOp { op: 'delete'; id: string }
interface MoveOp { op: 'move'; id: string; byM?: [number, number]; byPt?: [number, number] }
interface AddOp { op: 'add'; sheet?: string; item: Record<string, unknown> }
type Op = SetOp | DeleteOp | MoveOp | AddOp

const PATCHABLE = new Set([
  'systemId', 'level', 'label', 'size', 'flow', 'slope', 'note', 'text', 'extraM', 'colorOverride',
  'locked', 'symbol', 'name', 'use', 'ref', 'swing',
])

/**
 * Applies a batch of edits. Everything is validated first and written only if all of it is
 * good, so a half-understood instruction cannot leave the drawing half-changed.
 */
async function cmdApply(args: Args): Promise<void> {
  const { project, store, path } = await load(args)
  const opsPath = args.positional[1]
  if (!opsPath) fail('usage: warren apply <file.warren.json> <ops.json> [--dry-run]')
  if (!existsSync(opsPath)) fail(`no such file: ${opsPath}`)

  let ops: Op[]
  try {
    const parsed: unknown = JSON.parse(readFileSync(opsPath, 'utf8'))
    ops = Array.isArray(parsed) ? parsed as Op[] : (parsed as { ops: Op[] }).ops
    if (!Array.isArray(ops)) throw new Error('expected an array of ops, or {"ops": [...]}')
  } catch (err) {
    fail(`could not read ${opsPath}: ${err instanceof Error ? err.message : err}`)
  }

  const index = new Map<string, { sheet: Sheet; item: Item }>()
  for (const sheet of project.sheets) for (const item of sheet.items) index.set(item.id, { sheet, item })
  const systemIds = new Set(project.systems.map((s) => s.id))

  const problems: string[] = []
  const describe: string[] = []
  const planned: (() => void)[] = []

  ops.forEach((op, n) => {
    const at = `op ${n + 1} (${op?.op})`
    const target = 'id' in op ? index.get(op.id) : undefined
    if ('id' in op && !target) return void problems.push(`${at}: no item with id "${op.id}"`)

    switch (op.op) {
      case 'set': {
        const bad = Object.keys(op.patch ?? {}).filter((k) => !PATCHABLE.has(k))
        if (bad.length) return void problems.push(`${at}: cannot set ${bad.join(', ')} — patchable fields are ${[...PATCHABLE].join(', ')}`)
        if (typeof op.patch.systemId === 'string' && !systemIds.has(op.patch.systemId)) {
          return void problems.push(`${at}: systemId "${op.patch.systemId}" is not in this project's catalogue`)
        }
        if (typeof op.patch.level === 'string' && !LEVELS.includes(op.patch.level as Level)) {
          return void problems.push(`${at}: level "${op.patch.level}" is not one of ${LEVELS.join(', ')}`)
        }
        describe.push(`${at}: ${Object.keys(op.patch).join(', ')} on ${op.id}`)
        planned.push(() => {
          Object.assign(target!.item, op.patch)
          // Editing claims machine output, whoever does the editing. Without this a later
          // `generate` would quietly undo the change.
          adopt(target!.item)
        })
        break
      }
      case 'delete': {
        describe.push(`${at}: delete ${target!.item.kind} ${op.id}`)
        planned.push(() => {
          target!.sheet.items = target!.sheet.items.filter((i) => i.id !== op.id)
        })
        break
      }
      case 'move': {
        let delta: Pt | null = null
        if (op.byPt) delta = { x: op.byPt[0], y: op.byPt[1] }
        else if (op.byM) {
          const x = pointsFromMetres(target!.sheet, op.byM[0])
          const y = pointsFromMetres(target!.sheet, op.byM[1])
          if (x === null || y === null) return void problems.push(`${at}: sheet "${target!.sheet.name}" has no scale, so metres mean nothing here`)
          delta = { x, y }
        }
        if (!delta) return void problems.push(`${at}: needs byM or byPt`)
        describe.push(`${at}: move ${op.id}`)
        planned.push(() => {
          const item = target!.item
          const points = pointsOf(item)
          if (points) (item as { points: Pt[] }).points = points.map((p) => ({ x: p.x + delta.x, y: p.y + delta.y }))
          else if (isPositioned(item)) { item.x += delta.x; item.y += delta.y }
          adopt(item)
        })
        break
      }
      case 'add': {
        const sheets = sheetOf(project, op.sheet)
        const sheet = sheets[0]
        const raw = op.item ?? {}
        if (typeof raw.systemId !== 'string' || !systemIds.has(raw.systemId)) {
          return void problems.push(`${at}: item.systemId must be one of this project's systems`)
        }
        const level = typeof raw.level === 'string' && LEVELS.includes(raw.level as Level) ? raw.level as Level : 'wall'
        const shaped = raw.kind === 'run' || raw.kind === 'room' || raw.kind === 'door'
        if (shaped) {
          const source = Array.isArray(raw.pointsM) ? raw.pointsM : Array.isArray(raw.points) ? raw.points : null
          const least = raw.kind === 'room' ? 3 : 2
          if (!source || source.length < least) {
            return void problems.push(`${at}: a ${raw.kind} needs at least ${least} points`)
          }
          const inMetres = Array.isArray(raw.pointsM)
          const points: Pt[] = []
          for (const pair of source as [number, number][]) {
            const x = inMetres ? pointsFromMetres(sheet, pair[0]) : pair[0]
            const y = inMetres ? pointsFromMetres(sheet, pair[1]) : pair[1]
            if (x === null || y === null) return void problems.push(`${at}: sheet "${sheet.name}" has no scale, so pointsM mean nothing here`)
            points.push({ x, y })
          }
          if (raw.kind === 'room' && typeof raw.expectM2 === 'number') {
            // The architect prints the area on the plan, so a traced outline can check itself.
            const got = Math.abs(polygonArea(points)) * ((sheet.mmPerPoint ?? 0) / 1000) ** 2
            const off = Math.abs(got - raw.expectM2) / raw.expectM2
            if (off > 0.08) {
              return void problems.push(
                `${at}: "${raw.name}" traces to ${got.toFixed(1)} m² but the plan says ${raw.expectM2} m² — ${(off * 100).toFixed(0)}% out`)
            }
          }
          describe.push(`${at}: add ${raw.kind} ${raw.name ?? raw.label ?? ''} of ${points.length} points to ${sheet.name}`.replace(/\s+/g, ' '))
          planned.push(() => {
            if (raw.kind === 'room') {
              sheet.items.push({
                kind: 'room', id: newId('room'), systemId: raw.systemId as string, level, points,
                name: String(raw.name ?? 'Room'),
                use: ROOM_USES.includes(raw.use as RoomUse) ? (raw.use as RoomUse) : 'other',
                ...(typeof raw.ref === 'string' ? { ref: raw.ref } : {}),
              })
            } else if (raw.kind === 'door') {
              sheet.items.push({
                kind: 'door', id: newId('door'), systemId: raw.systemId as string, level,
                points: [points[0], points[1]],
                swing: raw.swing === -1 ? -1 : 1,
                ...(typeof raw.ref === 'string' ? { ref: raw.ref } : {}),
                ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
              })
            } else {
              sheet.items.push({
                kind: 'run', id: newId('run'), systemId: raw.systemId as string, level, points,
                flow: raw.flow === 'forward' || raw.flow === 'reverse' ? raw.flow : 'none',
                size: typeof raw.size === 'string' ? raw.size : store.system(raw.systemId as string).defaultSize,
                ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
              })
            }
          })
        } else if (raw.kind === 'marker' || raw.kind === 'note') {
          const x = typeof raw.xM === 'number' ? pointsFromMetres(sheet, raw.xM) : typeof raw.x === 'number' ? raw.x : null
          const y = typeof raw.yM === 'number' ? pointsFromMetres(sheet, raw.yM) : typeof raw.y === 'number' ? raw.y : null
          if (x === null || y === null) return void problems.push(`${at}: needs x/y in points or xM/yM in metres on a calibrated sheet`)
          describe.push(`${at}: add ${raw.kind} to ${sheet.name}`)
          planned.push(() => {
            if (raw.kind === 'note') {
              sheet.items.push({ kind: 'note', id: newId('note'), systemId: raw.systemId as string, level, x, y, w: 90, text: String(raw.text ?? '') })
            } else {
              sheet.items.push({
                kind: 'marker', id: newId('mk'), systemId: raw.systemId as string, level, x, y,
                symbol: (raw.symbol as never) ?? 'note',
                ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
              })
            }
          })
        } else {
          problems.push(`${at}: kind must be run, room, door, marker or note`)
        }
        break
      }
      default:
        problems.push(`${at}: unknown op`)
    }
  })

  if (problems.length) {
    for (const p of problems) process.stderr.write(`warren: ${p}\n`)
    process.stderr.write(`warren: nothing was written — ${problems.length} of ${ops.length} ops did not validate\n`)
    process.exit(1)
  }

  for (const line of describe) console.log(line)
  if (args.flags['dry-run']) return void console.log(`${planned.length} op(s) would apply; nothing written`)
  for (const apply of planned) apply()
  writeFileSync(path, serialize(project))
  console.log(`applied ${planned.length} op(s) to ${basename(path)}`)
}

// ---------------------------------------------------------------------------------- main

const HELP = `warren — read and edit a Warren project from the command line

  warren summary <file>                      what is in this project
  warren items   <file> [filters]            list items, with real-world positions
  warren takeoff <file> [--scope sheet]      metres per system
  warren check   <file> [--strict]           a second pair of eyes; exits 1 on errors
  warren graph   <file>                      derived connections: networks, junctions, free ends
  warren trace   <file> --id <item>          what one item is joined to, and what it reaches
  warren systems <file> [--add-missing]      list the catalogue, or fill in newer defaults
         systems <file> --merge a,b --into c  fold systems together, moving their items
  warren rules   <file> [--set rules.json]   the placement rules (data, so they are yours)
  warren generate <file> [--rule sockets]    run the rules over the rooms and doors
  warren split   <file>                      move the PDF out beside the file
  warren bundle  <file> [--out X]            write one self-contained file
  warren apply   <file> <ops.json>           apply validated edits

Filters for items:  --sheet <n|name>  --system <glob>  --level <level>  --kind <run|box|marker|note>
Everywhere:         --json    machine-readable output
                    --assets <dir>   where to look for the plan PDF

Lengths and positions are metres. Sheets must be calibrated for those to exist.
`

const args = parseArgs(process.argv.slice(2))
const commands: Record<string, (a: Args) => Promise<void>> = {
  summary: cmdSummary,
  items: cmdItems,
  takeoff: cmdTakeoff,
  check: cmdCheck,
  systems: cmdSystems,
  generate: cmdGenerate,
  rules: cmdRules,
  graph: cmdGraph,
  trace: cmdTrace,
  split: cmdSplit,
  bundle: cmdBundle,
  apply: cmdApply,
}

const run = commands[args.command]
if (!run) {
  process.stdout.write(HELP)
  process.exit(args.command === 'help' || args.flags.help ? 0 : 2)
}
await run(args).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)))
