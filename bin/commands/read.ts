/**
 * The read-only commands: summary, items, takeoff, check, graph, trace. None of these write —
 * they load a project, ask one of the shared modules a question, and print the answer.
 */
import { computeTakeoff } from '../../src/takeoff.ts'
import { countBySeverity, runChecks } from '../../src/check.ts'
import { buildGraph, connectionsOf, networkOf } from '../../src/topology.ts'
import { fail, type Args } from '../args.ts'
import { load } from '../project.ts'
import { globToRegExp, pointAtM, reportItem, round, sheetOf, type ItemReport } from '../units.ts'

export async function cmdSummary(args: Args): Promise<void> {
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

export async function cmdItems(args: Args): Promise<void> {
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
    const extra = [r.size, r.symbol, r.label, r.text, r.lengthM != null ? `${r.lengthM} m` : null, r.flow]
      .filter(Boolean).join(' · ')
    console.log(`${r.id.padEnd(22)} ${r.kind.padEnd(7)} ${r.system.padEnd(28)} ${r.level.padEnd(9)} ${where.padEnd(22)} ${extra}`)
  }
  console.log(`${rows.length} item${rows.length === 1 ? '' : 's'}`)
}

export async function cmdTakeoff(args: Args): Promise<void> {
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

/**
 * The rules live in src/check.ts so the app and this tool cannot drift apart on what counts as
 * a problem. Nothing runs unless you type `check`.
 */
export async function cmdCheck(args: Args): Promise<void> {
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

export async function cmdGraph(args: Args): Promise<void> {
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

export async function cmdTrace(args: Args): Promise<void> {
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
