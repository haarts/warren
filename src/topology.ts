import { closestOnPolyline, dist, type Pt } from './geom.ts'
import type { Item, RunItem, Sheet } from './model/types.ts'

/**
 * The connections between things are not stored, they are derived. Endpoints snap while you
 * draw, so runs that meet already share a coordinate - recording a second, editable copy of
 * that fact would only give it a way to disagree with the drawing.
 *
 * Everything here is a reading of the geometry. It never changes it.
 */

/**
 * Two things touch if they are within this much of each other, in real millimetres.
 *
 * Deliberately tiny. Endpoints snap while you draw, so genuine connections land on exactly the
 * same coordinate and this only needs to absorb floating-point drift. Measured on a real
 * drawing, coincident endpoints sit at 0.000 pt and the next nearest pair is 2 pt away - so a
 * generous tolerance does not catch more connections, it invents them, and a cross-connection
 * warning that cries wolf is worse than no warning at all.
 *
 * Two things that look joined but are not will show up as free ends, which is the honest
 * answer: they are not joined.
 */
export const TOUCH_MM = 5

export function toleranceFor(sheet: Sheet): number {
  return sheet.mmPerPoint ? TOUCH_MM / sheet.mmPerPoint : 0.25
}

export type Contact = 'end-to-end' | 'tee' | 'equipment'

export interface Connection {
  otherId: string
  at: Pt
  how: Contact
}

export interface FreeEnd {
  itemId: string
  end: 'start' | 'end'
  at: Pt
}

export interface Network {
  /** Item ids in this connected group, in sheet order. */
  items: string[]
  systemIds: string[]
  /** A network with no box or marker in it reaches no equipment anywhere. */
  hasEquipment: boolean
}

export interface Graph {
  connections: Map<string, Connection[]>
  networks: Network[]
  networkOf: Map<string, number>
  freeEnds: FreeEnd[]
  junctions: { at: Pt; items: string[] }[]
  tolerance: number
}

const endpointsOf = (run: RunItem): [Pt, Pt] => [run.points[0], run.points[run.points.length - 1]]

function touchesBox(p: Pt, item: Item, tol: number): boolean {
  if (item.kind !== 'box') return false
  return p.x >= item.x - tol && p.x <= item.x + item.w + tol
    && p.y >= item.y - tol && p.y <= item.y + item.h + tol
}

/**
 * How a run's endpoint meets another item, or null. A run meeting another run at its own end
 * is a joint; meeting it part-way along is a tee - worth telling apart, because a tee into the
 * middle of a main is a branch and a joint is a continuation.
 */
function contactBetween(p: Pt, other: Item, tol: number): { how: Contact; at: Pt } | null {
  if (other.kind === 'run') {
    for (const end of endpointsOf(other)) {
      if (dist(p, end) <= tol) return { how: 'end-to-end', at: end }
    }
    if (other.points.length >= 2) {
      const near = closestOnPolyline(p, other.points)
      if (near.dist <= tol) return { how: 'tee', at: near.point }
    }
    return null
  }
  if (other.kind === 'box') return touchesBox(p, other, tol) ? { how: 'equipment', at: p } : null
  if (other.kind === 'marker') return dist(p, { x: other.x, y: other.y }) <= tol ? { how: 'equipment', at: { x: other.x, y: other.y } } : null
  return null
}

export function buildGraph(sheet: Sheet, tolerance = toleranceFor(sheet)): Graph {
  const items = sheet.items.filter((i) => i.kind !== 'note')
  const connections = new Map<string, Connection[]>()
  const add = (a: string, b: string, at: Pt, how: Contact): void => {
    const list = connections.get(a) ?? []
    if (!list.some((c) => c.otherId === b)) list.push({ otherId: b, at, how })
    connections.set(a, list)
  }

  const equipment = items.filter((i) => i.kind === 'box' || i.kind === 'marker')
  const runs = items.filter((i): i is RunItem => i.kind === 'run')
  for (const run of runs) {
    for (const p of endpointsOf(run)) {
      // Equipment mediates. Six circuits leaving a distribution board share a coordinate, and
      // several runs meeting at an appliance point share another; in both cases they are
      // joined to the thing, not to each other, and saying otherwise buries the connection
      // that matters under several that do not.
      const insideEquipment = equipment.some((e) =>
        e.kind === 'box' ? touchesBox(p, e, tolerance) : dist(p, { x: e.x, y: e.y }) <= tolerance)
      for (const other of items) {
        if (other.id === run.id) continue
        const contact = contactBetween(p, other, tolerance)
        if (!contact) continue
        if (insideEquipment && other.kind === 'run') continue
        add(run.id, other.id, contact.at, contact.how)
        add(other.id, run.id, contact.at, contact.how === 'tee' ? 'tee' : contact.how)
      }
    }
  }

  // Connected groups, by walking what we just found.
  const networkOf = new Map<string, number>()
  const networks: Network[] = []
  for (const item of items) {
    if (networkOf.has(item.id)) continue
    const group: string[] = []
    const queue = [item.id]
    networkOf.set(item.id, networks.length)
    while (queue.length) {
      const id = queue.shift() as string
      group.push(id)
      for (const c of connections.get(id) ?? []) {
        if (networkOf.has(c.otherId)) continue
        networkOf.set(c.otherId, networks.length)
        queue.push(c.otherId)
      }
    }
    const members = group.map((id) => items.find((i) => i.id === id)).filter(Boolean) as Item[]
    networks.push({
      items: group,
      systemIds: [...new Set(members.map((i) => i.systemId))],
      hasEquipment: members.some((i) => i.kind === 'box' || i.kind === 'marker'),
    })
  }

  // An end that meets nothing: where a run simply stops.
  const freeEnds: FreeEnd[] = []
  for (const run of runs) {
    const ends = endpointsOf(run)
    const met = connections.get(run.id) ?? []
    ;(['start', 'end'] as const).forEach((which, i) => {
      if (!met.some((c) => dist(c.at, ends[i]) <= tolerance)) {
        freeEnds.push({ itemId: run.id, end: which, at: ends[i] })
      }
    })
  }

  return { connections, networks, networkOf, freeEnds, junctions: clusterJunctions(connections, tolerance), tolerance }
}

function clusterJunctions(connections: Map<string, Connection[]>, tol: number): { at: Pt; items: string[] }[] {
  const clusters: { at: Pt; items: Set<string> }[] = []
  for (const [id, list] of connections) {
    for (const c of list) {
      const hit = clusters.find((cl) => dist(cl.at, c.at) <= tol)
      if (hit) {
        hit.items.add(id)
        hit.items.add(c.otherId)
      } else {
        clusters.push({ at: c.at, items: new Set([id, c.otherId]) })
      }
    }
  }
  return clusters.map((c) => ({ at: c.at, items: [...c.items] }))
}

/** Everything reachable from one item, itself included. */
export function networkOf(graph: Graph, itemId: string): Network | null {
  const index = graph.networkOf.get(itemId)
  return index === undefined ? null : graph.networks[index]
}

export function connectionsOf(graph: Graph, itemId: string): Connection[] {
  return graph.connections.get(itemId) ?? []
}
