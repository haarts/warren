import { polylineLength } from './geom.ts'
import type { Store } from './model/doc.ts'
import type { Category, Sheet, System } from './model/types.ts'

export interface TakeoffRow {
  system: System
  runs: number
  boxes: number
  markers: number
  /** Annotations, counted but never treated as material. */
  notes: number
  /** Straight plan length, before slack. */
  lengthMm: number
  /** With the global slack percentage and any per-run extra applied. */
  orderMm: number
}

export interface TakeoffResult {
  rows: TakeoffRow[]
  byCategory: { category: Category; rows: TakeoffRow[] }[]
  uncalibrated: string[]
  slackPct: number
}

/**
 * A plan length is not a material length: drops down walls, rises into ceilings, service loops
 * and the bend radius at every corner are all invisible from above. The slack percentage is
 * there so the number you order from is honest about that.
 */
export function computeTakeoff(store: Store, scope: 'sheet' | 'project'): TakeoffResult {
  const sheets: Sheet[] = scope === 'sheet' ? [store.sheet] : store.project.sheets
  const slackPct = store.project.settings.takeoffSlackPct
  const map = new Map<string, TakeoffRow>()
  const uncalibrated: string[] = []

  for (const sheet of sheets) {
    if (!sheet.mmPerPoint && sheet.items.some((i) => i.kind === 'run')) uncalibrated.push(sheet.name)
    for (const item of sheet.items) {
      const system = store.system(item.systemId)
      let row = map.get(system.id)
      if (!row) {
        row = { system, runs: 0, boxes: 0, markers: 0, notes: 0, lengthMm: 0, orderMm: 0 }
        map.set(system.id, row)
      }
      if (item.kind === 'run') {
        row.runs += 1
        if (sheet.mmPerPoint) {
          const mm = polylineLength(item.points) * sheet.mmPerPoint
          row.lengthMm += mm
          row.orderMm += mm * (1 + slackPct / 100) + (item.extraM ?? 0) * 1000
        }
      } else if (item.kind === 'box') {
        row.boxes += 1
      } else if (item.kind === 'marker') {
        row.markers += 1
      } else {
        row.notes += 1
      }
    }
  }

  const rows = [...map.values()].sort((a, b) => {
    if (a.system.category !== b.system.category) return a.system.category.localeCompare(b.system.category)
    return b.lengthMm - a.lengthMm || a.system.name.localeCompare(b.system.name)
  })

  const byCategory: { category: Category; rows: TakeoffRow[] }[] = []
  for (const row of rows) {
    let group = byCategory.find((g) => g.category === row.system.category)
    if (!group) {
      group = { category: row.system.category, rows: [] }
      byCategory.push(group)
    }
    group.rows.push(row)
  }

  return { rows, byCategory, uncalibrated, slackPct }
}

/** Systems actually used on a sheet - the legend should only show what is drawn. */
export function systemsInUse(store: Store, scope: 'sheet' | 'project'): System[] {
  const sheets = scope === 'sheet' ? [store.sheet] : store.project.sheets
  const ids = new Set<string>()
  for (const sheet of sheets) for (const item of sheet.items) ids.add(item.systemId)
  return store.project.systems.filter((s) => ids.has(s.id))
}
