/**
 * Sheets: one project can hold a floor plan per storey. Adding, renaming, deleting one,
 * copying the current selection across to another at the same coordinates, and taking a run
 * up or down through the floor to another.
 */
import { dist, type Pt } from '../geom.ts'
import { idPrefix, newId } from '../model/ids.ts'
import { emptySheet } from '../model/doc.ts'
import type { Item, MarkerItem, Sheet } from '../model/types.ts'
import { buildGraph, toleranceFor } from '../topology.ts'
import { floorMapping, mapItem } from '../align.ts'
import { startAlign } from './alignOps.ts'
import { alertDialog, chooseDialog, confirmDialog } from '../ui/modal.ts'
import { refit } from './pdfOps.ts'
import type { App } from '../app.ts'

export function addSheet(app: App): void {
  app.store.mutate(() => {
    const sheet = emptySheet(`Sheet ${app.store.project.sheets.length + 1}`)
    app.store.project.sheets.push(sheet)
    app.store.project.activeSheetId = sheet.id
  })
  app.editor.invalidateBackground()
}

export async function renameSheet(app: App, sheet: Sheet): Promise<void> {
  const name = window.prompt('Sheet name', sheet.name)
  if (name === null) return
  app.store.mutate(() => {
    const live = app.store.project.sheets.find((s) => s.id === sheet.id)
    if (live) live.name = name.trim() || live.name
  })
}

export async function deleteSheet(app: App, sheet: Sheet): Promise<void> {
  if (app.store.project.sheets.length <= 1) {
    alertDialog('Cannot delete', 'A project needs at least one sheet.')
    return
  }
  const ok = await confirmDialog('Delete sheet?', `"${sheet.name}" and its ${sheet.items.length} items will be removed.`, 'Delete')
  if (!ok) return
  app.store.mutate(() => {
    app.store.project.sheets = app.store.project.sheets.filter((s) => s.id !== sheet.id)
    if (app.store.project.activeSheetId === sheet.id) {
      app.store.project.activeSheetId = app.store.project.sheets[0].id
    }
  })
  refit(app)
}

export function duplicateSelectionToSheet(app: App, sheetId: string): void {
  const items = app.store.selectedItems()
  if (items.length === 0) return
  const target = app.store.project.sheets.find((s) => s.id === sheetId)
  if (!target) return
  // Aligned floors carry each copy to the same spot in the building; otherwise all there is to
  // go on is the page, and the message says so.
  const mapping = floorMapping(app.store.sheet, target)
  app.store.mutate(() => {
    for (const item of items) {
      const copy = mapping ? mapItem(item, mapping) : structuredClone(item)
      copy.id = newId(idPrefix(item.kind))
      target.items.push(copy)
    }
  })
  app.editor.flash(mapping
    ? `Copied ${items.length} item(s) to the same place on ${target.name}`
    : `Copied ${items.length} item(s) to ${target.name} at the same page position — align the floors to place them by the building instead`)
}

/**
 * Where a selected run or marker would pass through the floor: the marker itself, or the end of
 * the run - the corner you picked if it is an end, else its loose end, else where it was drawn to.
 */
export function riserPointFor(app: App, item: Item): Pt | null {
  if (item.kind === 'marker') return { x: item.x, y: item.y }
  if (item.kind !== 'run' || item.points.length === 0) return null
  const last = item.points.length - 1
  const av = app.store.activeVertex
  if (av?.itemId === item.id && (av.index === 0 || av.index === last)) return { ...item.points[av.index] }
  const loose = buildGraph(app.store.sheet).freeEnds.filter((f) => f.itemId === item.id)
  const end = loose.find((f) => f.end === 'end') ?? loose[0]
  return { ...(end ? end.at : item.points[last]) }
}

/**
 * Takes the selected run (or marker) through the floor to another sheet: a riser marker here
 * pointing the way it goes, its partner at the same spot on the other sheet pointing back, each
 * labelled with the other sheet's name. Then it follows the pipe there, with the partner
 * selected, so the next thing you draw carries on from it.
 *
 * Sheets do not know which floor is above which, so `way` is said, not worked out. Nor do
 * they know where the other floor's drawing sits on its page: that is what the alignment is
 * for, and without it this refuses rather than put a riser in the wrong room.
 */
export function riseToSheet(app: App, sheetId: string, way: 'up' | 'down'): void {
  const { store } = app
  const items = store.selectedItems()
  const item = items.length === 1 ? items[0] : null
  const at = item ? riserPointFor(app, item) : null
  const source = store.sheet
  const target = store.project.sheets.find((s) => s.id === sheetId)
  if (!item || !at || !target || target.id === source.id) return
  const mapping = floorMapping(source, target)
  if (!mapping) {
    void offerAlignment(app, source, target)
    return
  }
  const there = mapping.apply(at)

  const hereSymbol: MarkerItem['symbol'] = way === 'up' ? 'riser-up' : 'riser-down'
  const thereSymbol: MarkerItem['symbol'] = way === 'up' ? 'riser-down' : 'riser-up'
  const riser = (p: Pt, symbol: MarkerItem['symbol'], label: string): MarkerItem => ({
    kind: 'marker', id: newId('mk'), systemId: item.systemId, level: item.level,
    x: p.x, y: p.y, symbol, label,
  })
  // A riser already standing on that spot is the one you meant, not a reason for a second.
  const existing = (sheet: Sheet, p: Pt, symbol: MarkerItem['symbol']): MarkerItem | undefined =>
    sheet.items.find((i): i is MarkerItem =>
      i.kind === 'marker' && i.symbol === symbol && i.systemId === item.systemId && dist(i, p) <= toleranceFor(sheet))

  let arrival = existing(target, there, thereSymbol)
  store.mutate(() => {
    if (!(item.kind === 'marker' && item.symbol === hereSymbol) && !existing(source, at, hereSymbol)) {
      source.items.push(riser(at, hereSymbol, target.name))
    }
    if (!arrival) {
      arrival = riser(there, thereSymbol, source.name)
      target.items.push(arrival)
    }
    store.project.activeSheetId = target.id
    store.selection.clear()
    store.selection.add(arrival.id)
    store.activeVertex = null
  })
  app.editor.activeSystemId = item.systemId
  app.editor.ghostSheetId = source.id
  // The camera stays put: the riser is at the same coordinates up there, so it lands right
  // where your eye already is.
  app.editor.invalidateBackground()
  app.editor.flash(`${way === 'up' ? 'Up' : 'Down'} to ${target.name} — the riser is selected here; press L and start on it to carry on`)
}

/** Rise/Drop needs both floors aligned. Says which is not, and offers to go and do it. */
async function offerAlignment(app: App, source: Sheet, target: Sheet): Promise<void> {
  const missing = [source, target].filter((s) => !s.align)
  const go = await chooseDialog('Align the floors first',
    `Every floor plan sits differently on its page, so a riser cannot be carried to ${target.name} ` +
    `by page position alone. Click the same two spots - a grid-line crossing, a stair corner - on ` +
    `${missing.map((s) => s.name).join(' and ')}, and Warren lines the floors up.`,
    [{ label: `Align ${missing[0].name} now`, value: true, primary: true }])
  if (!go) return
  if (missing[0].id !== app.store.sheet.id) {
    app.store.setActiveSheet(missing[0].id)
    refit(app)
  }
  startAlign(app)
}
