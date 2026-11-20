/**
 * A riser is one pipe through the floors, drawn once on each: the riser up where it leaves, the
 * riser down where it arrives, a pass-through on every floor between. Nothing records that they
 * belong together - like every other connection it is read from the drawing: risers of one
 * system standing on the same spot in the building, on floors that are lined up, are the same
 * pipe. So moving one moves the others with it, to the same new spot on each floor.
 *
 * A riser on a floor that is not lined up has no "same spot" anywhere else, so it moves alone.
 */
import { dist, type Pt } from './geom.ts'
import { floorMapping } from './align.ts'
import { toleranceFor } from './topology.ts'
import type { Item, MarkerItem, Sheet } from './model/types.ts'

const RISER_SYMBOLS: ReadonlySet<MarkerItem['symbol']> = new Set(['riser-up', 'riser-down', 'riser-through'])

export const isRiser = (item: Item): item is MarkerItem => item.kind === 'marker' && RISER_SYMBOLS.has(item.symbol)

/**
 * After an edit: every riser that moved takes the risers of the same pipe on the other floors
 * along with it. `before` is the sheets as they were (a snapshot, not the live objects); the
 * live `sheets` are changed in place. A riser that moved in this same edit is never also carried,
 * and a new one (a copy, a paste) carries nothing - it is not the pipe yet. Returns how many
 * were carried.
 */
export function carryRisers(before: Sheet[], sheets: Sheet[]): number {
  const was = new Map<string, Pt>()
  for (const sheet of before) for (const item of sheet.items) if (isRiser(item)) was.set(item.id, { x: item.x, y: item.y })

  const moved: { sheet: Sheet; riser: MarkerItem; from: Pt }[] = []
  for (const sheet of sheets) {
    for (const item of sheet.items) {
      if (!isRiser(item)) continue
      const from = was.get(item.id)
      if (from && (from.x !== item.x || from.y !== item.y)) moved.push({ sheet, riser: item, from })
    }
  }
  if (moved.length === 0) return 0

  const movedIds = new Set(moved.map((m) => m.riser.id))
  const carried = new Set<string>()
  for (const { sheet, riser, from } of moved) {
    for (const other of sheets) {
      if (other === sheet) continue
      const m = floorMapping(sheet, other)
      if (!m) continue
      const there = m.apply(from)
      const to = m.apply(riser)
      const tol = toleranceFor(other)
      for (const item of other.items) {
        if (!isRiser(item) || item.systemId !== riser.systemId) continue
        if (movedIds.has(item.id) || carried.has(item.id)) continue
        if (dist(item, there) > tol) continue
        item.x = to.x
        item.y = to.y
        carried.add(item.id)
      }
    }
  }
  return carried.size
}
