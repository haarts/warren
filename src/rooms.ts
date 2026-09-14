import { pointInPolygon, type Pt } from './geom.ts'
import type { Item, RoomItem, Sheet } from './model/types.ts'

/**
 * Which room a thing is in, read from where it is rather than from what it is called.
 *
 * The alternative — labelling everything with the room it serves — has a trap in it: you must
 * declare membership before the thing exists, so a run drawn while filtering on "Renze"
 * vanishes the moment it appears, not yet having been labelled. Geometry has no such problem.
 */

/** The points that decide which room an item is in. */
function anchorsOf(item: Item): Pt[] {
  switch (item.kind) {
    case 'run':
      // Ends, not the whole path. A circuit from the panel to a bedroom serves both, and
      // merely crossing the hall on the way does not make it the hall's business.
      return [item.points[0], item.points[item.points.length - 1]]
    case 'door':
      return item.points
    case 'room':
      return []
    case 'box':
      return [{ x: item.x + item.w / 2, y: item.y + item.h / 2 }]
    default:
      return [{ x: item.x, y: item.y }]
  }
}

export function roomsOf(sheet: Sheet, item: Item): RoomItem[] {
  if (item.kind === 'room') return [item]
  const anchors = anchorsOf(item)
  if (anchors.length === 0) return []
  return sheet.items.filter((r): r is RoomItem =>
    r.kind === 'room' && anchors.some((p) => pointInPolygon(p, r.points)))
}

export function isInRoom(sheet: Sheet, item: Item, roomId: string): boolean {
  if (item.kind === 'room') return item.id === roomId
  const room = sheet.items.find((r): r is RoomItem => r.kind === 'room' && r.id === roomId)
  if (!room) return false
  return anchorsOf(item).some((p) => pointInPolygon(p, room.points))
}

/**
 * Everything in one room, as a set for a render pass to consult cheaply. A door is included
 * whenever either jamb is inside, so the way in and out is never greyed away from the room.
 */
export function itemsInRoom(sheet: Sheet, roomId: string): Set<string> {
  const room = sheet.items.find((r): r is RoomItem => r.kind === 'room' && r.id === roomId)
  if (!room) return new Set()
  const out = new Set<string>([room.id])
  for (const item of sheet.items) {
    if (item.id === room.id) continue
    if (anchorsOf(item).some((p) => pointInPolygon(p, room.points))) out.add(item.id)
  }
  return out
}

export function roomNamed(sheet: Sheet, roomId: string): RoomItem | null {
  return sheet.items.find((r): r is RoomItem => r.kind === 'room' && r.id === roomId) ?? null
}
