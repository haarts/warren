import type { Store } from './model/doc.ts'
import { coordsOf, LEVELS, type Item, type Project, type Sheet } from './model/types.ts'
import { buildGraph, connectionsOf, type Graph } from './topology.ts'
import type { Pt } from './geom.ts'

/**
 * A second pair of eyes, never a gate. Nothing here stops you drawing, and none of it runs
 * unless somebody asks for it: the app hides it behind a tab you have to open, and on the
 * command line you have to type `check`.
 *
 * The rigour is aimed at whatever writes to the file without looking at it. The parser is
 * deliberately forgiving so an old drawing still opens, which is right for a person and
 * dangerous for a machine - a run with one vertex, or millimetres where points belong, gets
 * quietly repaired into something plausible and wrong. These rules fail where it forgives.
 */

export type Severity = 'error' | 'warning' | 'note'

export interface Finding {
  severity: Severity
  rule: string
  /** Human-readable location. */
  where: string
  message: string
  sheetId?: string
  /** Items this is about, so a caller can select or zoom to them. */
  itemIds: string[]
}

export interface CheckOptions {
  /** Also report things that are merely unfinished, like a run with no size. */
  strict?: boolean
  /** Asset ids whose bytes could not be found. */
  missingAssets?: string[]
}

export function runChecks(store: Store, opts: CheckOptions = {}): Finding[] {
  const project = store.project
  const findings: Finding[] = []
  const add = (
    severity: Severity, rule: string, where: string, message: string, itemIds: string[] = [], sheetId?: string,
  ): void => {
    findings.push({ severity, rule, where, message, itemIds, sheetId })
  }

  for (const id of opts.missingAssets ?? []) {
    add('warning', 'asset-missing', project.name,
      `the plan "${project.assets[id]?.name ?? id.slice(0, 8)}" is not beside this file, so sheets draw without it`)
  }

  const systemIds = new Set(project.systems.map((s) => s.id))
  const seenIds = new Set<string>()
  let assumed: string[] = []

  for (const sheet of project.sheets) {
    checkSheet(store, sheet, systemIds, seenIds, opts, add)
    assumed = assumed.concat(
      sheet.items.filter((i) => i.kind === 'run' && i.flowAssumed).map((i) => i.id),
    )
  }

  if (assumed.length) {
    add('warning', 'direction-assumed', `${assumed.length} run${assumed.length === 1 ? '' : 's'}`,
      'direction was guessed from the order they were drawn and nobody has confirmed it — worth a look before anyone builds from the sheet',
      assumed)
  }
  return findings
}

type Add = (severity: Severity, rule: string, where: string, message: string, itemIds?: string[], sheetId?: string) => void

function checkSheet(
  store: Store, sheet: Sheet, systemIds: Set<string>, seenIds: Set<string>, opts: CheckOptions, add: Add,
): void {
  // Most findings are about one item on this sheet - `flag` is `add` with that boilerplate filled in.
  const flag = (item: Item, severity: Severity, rule: string, message: string): void =>
    add(severity, rule, `${sheet.name}/${item.id}`, message, [item.id], sheet.id)

  if (sheet.mmPerPoint === null && sheet.items.some((i) => i.kind === 'run')) {
    add('warning', 'uncalibrated', sheet.name,
      'runs are drawn but the sheet has no scale, so no length is knowable', [], sheet.id)
  }
  if (sheet.pdf && !store.project.assets[sheet.pdf.assetId]) {
    add('error', 'asset-dangling', sheet.name,
      `points at a plan (${sheet.pdf.assetId.slice(0, 8)}) this file does not list`, [], sheet.id)
  }

  const page = sheet.pdf
  for (const item of sheet.items) {
    if (seenIds.has(item.id)) flag(item, 'error', 'duplicate-id', 'two items share this id')
    seenIds.add(item.id)
    if (!systemIds.has(item.systemId)) {
      flag(item, 'error', 'unknown-system', `systemId "${item.systemId}" is not in this project's catalogue`)
    }
    if (!LEVELS.includes(item.level)) flag(item, 'error', 'unknown-level', `level "${item.level}" is not a level`)

    const coords: Pt[] = coordsOf(item)
    if (item.kind === 'run' && item.points.length < 2) {
      flag(item, 'error', 'run-too-short', `a run needs two points, this has ${item.points.length}`)
    }
    if (coords.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
      flag(item, 'error', 'bad-coordinate', 'has a coordinate that is not a finite number')
    }
    if (page) {
      // Coordinates are PDF points. A value far off the page usually means metres or
      // millimetres were written where points were expected.
      const margin = Math.max(page.widthPt, page.heightPt)
      const off = coords.some((p) =>
        p.x < -margin || p.y < -margin || p.x > page.widthPt + margin || p.y > page.heightPt + margin)
      if (off) {
        flag(item, 'warning', 'off-page',
          `sits far outside the ${Math.round(page.widthPt)}×${Math.round(page.heightPt)} pt page — are these points, or did millimetres get written here?`)
      }
    }
    if (item.kind === 'run' && !item.size && opts.strict) {
      flag(item, 'warning', 'no-size', 'no size or spec, so it cannot be ordered from')
    }
    const sys = store.system(item.systemId)
    if (item.kind === 'run' && sys.assumeFlow && item.flow === 'none') {
      flag(item, 'warning', 'no-direction', `a ${sys.name} run with no direction: which way does it fall or blow?`)
    }
  }

  checkTopology(store, sheet, buildGraph(sheet), add)
}

function checkTopology(store: Store, sheet: Sheet, graph: Graph, add: Add): void {
  for (const network of graph.networks) {
    const members = network.items
      .map((id) => sheet.items.find((i) => i.id === id))
      .filter(Boolean) as Item[]

    // The one rule worth enforcing above all others. Derived from the geometry rather than
    // declared, so it holds whether or not anybody remembered to label anything.
    const nonPotable = members.filter((i) => store.system(i.systemId).tag === 'NON-POTABLE')
    const potable = members.filter((i) => store.system(i.systemId).category === 'water')
    if (nonPotable.length && potable.length) {
      add('error', 'cross-connection', sheet.name,
        `${store.system(nonPotable[0].systemId).name} and ${store.system(potable[0].systemId).name} are joined — `
        + 'non-potable water must never be able to reach drinking water',
        [...nonPotable.map((i) => i.id), ...potable.map((i) => i.id)], sheet.id)
    }

    const runs = members.filter((i) => i.kind === 'run')
    if (runs.length >= 2 && !network.hasEquipment) {
      add('note', 'no-equipment', sheet.name,
        `${runs.length} joined runs (${store.system(runs[0].systemId).name}) reach no box or marker anywhere`,
        network.items, sheet.id)
    }
    if (members.length === 1 && members[0].kind === 'run' && connectionsOf(graph, members[0].id).length === 0) {
      add('note', 'isolated', `${sheet.name}/${members[0].id}`,
        `a ${store.system(members[0].systemId).name} run joined to nothing at either end`,
        [members[0].id], sheet.id)
    }
  }
}

export function countBySeverity(findings: Finding[]): Record<Severity, number> {
  return {
    error: findings.filter((f) => f.severity === 'error').length,
    warning: findings.filter((f) => f.severity === 'warning').length,
    note: findings.filter((f) => f.severity === 'note').length,
  }
}

export type { Project }
