import { dist, inwardNormal, polygonCentroid, polygonEdges, type Pt } from './geom.ts'
import type { Store } from './model/doc.ts'
import type { GeneratedBy, Item, Level, MarkerItem, MarkerSymbol, RoomUse, Sheet } from './model/types.ts'

/**
 * Rules are data, not code. "Two sockets on every wall" is somebody's opinion about their own
 * house, not a law, so Warren executes a rule set rather than believing one. The rules live in
 * the project, travel with it, and are as editable as anything else in it.
 *
 * This file knows how to *place* things. It does not know which room is a kitchen - that is
 * imported intelligence, and it arrives as a room with a use on it.
 */

export type Placement = 'along-walls' | 'at-door-strike' | 'centre'

export interface GenerateRule {
  id: string
  enabled: boolean
  place: Placement
  systemId: string
  level: Level
  symbol: MarkerSymbol
  label?: string
  /** Rooms this applies to. Empty means every room. */
  uses?: RoomUse[]
  /** along-walls: how many per wall, and how far from each corner. */
  perWall?: number
  insetMm?: number
  /** along-walls: walls shorter than this get nothing. */
  minWallMm?: number
  /** How far off the wall to sit, so the symbol reads inside the room. */
  offWallMm?: number
  /** at-door-strike: how far past the jamb. */
  offsetMm?: number
}

export const DEFAULT_RULES: GenerateRule[] = [
  {
    id: 'sockets', enabled: true, place: 'along-walls',
    // No label: fifty-six identical "socket" pills drown the drawing, and the symbol and the
    // system colour already say what it is. Rarer things keep their label.
    systemId: 'power.socket', level: 'on-wall', symbol: 'socket',
    uses: ['living', 'kitchen', 'dining', 'bedroom', 'workshop', 'utility'],
    perWall: 2, insetMm: 400, minWallMm: 1200, offWallMm: 120,
  },
  {
    id: 'switches', enabled: true, place: 'at-door-strike',
    systemId: 'power.light', level: 'on-wall', symbol: 'switch', label: 'switch',
    offsetMm: 200, offWallMm: 120,
  },
  {
    id: 'detectors', enabled: true, place: 'centre',
    systemId: 'power.smoke', level: 'ceiling', symbol: 'detector', label: 'rookmelder',
    uses: ['hall', 'stairs', 'living', 'bedroom'],
  },
]

export interface GenerateResult {
  /** Items this rule would create, in a stable order. */
  create: MarkerItem[]
  /** Ids of previous output of this rule that is still unclaimed, and so can be replaced. */
  replace: string[]
  /** Previous output somebody has since edited, which is left alone. */
  adopted: string[]
}

const mmToPt = (sheet: Sheet, mm: number): number => (sheet.mmPerPoint ? mm / sheet.mmPerPoint : mm)

/**
 * Ids are derived from the rule and what it came from, not random, so regenerating produces
 * the same file rather than a diff full of new identifiers.
 */
const generatedId = (rule: string, from: string, index: number): string => `gen_${rule}_${from}_${index}`

function marker(rule: GenerateRule, from: string, index: number, at: Pt): MarkerItem {
  const item: MarkerItem = {
    kind: 'marker',
    id: generatedId(rule.id, from, index),
    systemId: rule.systemId,
    level: rule.level,
    x: at.x,
    y: at.y,
    symbol: rule.symbol,
    generated: { rule: rule.id, from },
  }
  if (rule.label) item.label = rule.label
  return item
}

export function generate(sheet: Sheet, rule: GenerateRule): GenerateResult {
  const create: MarkerItem[] = []
  const rooms = sheet.items.filter((i) => i.kind === 'room')
  const applies = (use: RoomUse): boolean => !rule.uses?.length || rule.uses.includes(use)

  if (rule.place === 'centre') {
    for (const room of rooms) {
      if (room.kind !== 'room' || !applies(room.use)) continue
      create.push(marker(rule, room.id, 0, polygonCentroid(room.points)))
    }
  }

  if (rule.place === 'along-walls') {
    const perWall = Math.max(1, rule.perWall ?? 2)
    const inset = mmToPt(sheet, rule.insetMm ?? 400)
    const minWall = mmToPt(sheet, rule.minWallMm ?? 1200)
    const offWall = mmToPt(sheet, rule.offWallMm ?? 120)
    for (const room of rooms) {
      if (room.kind !== 'room' || !applies(room.use)) continue
      let index = 0
      for (const [a, b] of polygonEdges(room.points)) {
        const length = dist(a, b)
        if (length < minWall) continue
        const u = { x: (b.x - a.x) / length, y: (b.y - a.y) / length }
        const n = inwardNormal(a, b, room.points)
        // Spread across the wall but kept clear of the corners, because that is where the
        // furniture goes and a socket behind a wardrobe is a socket you do not have.
        const usable = Math.max(0, length - inset * 2)
        for (let i = 0; i < perWall; i++) {
          const t = perWall === 1 ? length / 2 : inset + (usable * i) / (perWall - 1)
          create.push(marker(rule, room.id, index++, {
            x: a.x + u.x * t + n.x * offWall,
            y: a.y + u.y * t + n.y * offWall,
          }))
        }
      }
    }
  }

  if (rule.place === 'at-door-strike') {
    const offset = mmToPt(sheet, rule.offsetMm ?? 200)
    const offWall = mmToPt(sheet, rule.offWallMm ?? 120)
    for (const door of sheet.items) {
      if (door.kind !== 'door') continue
      const [hinge, strike] = door.points
      const length = dist(hinge, strike) || 1
      const u = { x: (strike.x - hinge.x) / length, y: (strike.y - hinge.y) / length }
      const n = { x: -u.y * door.swing, y: u.x * door.swing }
      // Past the strike jamb, on the side the door opens to: reachable as you walk in,
      // rather than behind the door once it is open.
      create.push(marker(rule, door.id, 0, {
        x: strike.x + u.x * offset + n.x * offWall,
        y: strike.y + u.y * offset + n.y * offWall,
      }))
    }
  }

  const previous = sheet.items.filter((i) => generatedBy(i)?.rule === rule.id)
  return {
    create,
    replace: previous.map((i) => i.id),
    // Output somebody has since edited stops being the machine's and is never replaced.
    adopted: sheet.items
      .filter((i) => generatedBy(i) === undefined && i.id.startsWith(`gen_${rule.id}_`))
      .map((i) => i.id),
  }
}

/** Replaces a rule's unclaimed output with a fresh run of it. Returns what changed. */
export function applyGenerated(sheet: Sheet, result: GenerateResult): { added: number; removed: number } {
  const doomed = new Set(result.replace)
  const kept = sheet.items.filter((i) => !doomed.has(i.id))
  const claimed = new Set(kept.map((i) => i.id))
  // Never clobber something a person has since made their own.
  const fresh = result.create.filter((i) => !claimed.has(i.id))
  sheet.items = [...kept, ...fresh]
  return { added: fresh.length, removed: doomed.size }
}

export function generatedBy(item: Item): GeneratedBy | undefined {
  return item.kind === 'marker' ? item.generated : undefined
}

/**
 * Editing a generated item claims it. From then on regenerating leaves it alone, so a socket
 * you nudged two metres is never quietly shoved back where the rule wanted it.
 */
export function adopt(item: Item): void {
  if (item.kind === 'marker') delete item.generated
}

export function rulesOf(store: Store): GenerateRule[] {
  return store.project.rules?.length ? store.project.rules : DEFAULT_RULES
}

export type { Item }
