/**
 * Ctrl+C, Ctrl+X and Ctrl+V, the way every drawing program has them. The clipboard is this
 * tab's own: what it holds are drawing items, which mean nothing pasted into a text editor.
 *
 * Where a paste lands: at the cursor when it is over the drawing, which is where you are
 * looking. Without one, a paste on the sheet it came from steps down and right so it never
 * hides under its original; on another floor it goes to the same spot in the building when the
 * floors are lined up, and to the same spot on the page when they are not.
 */
import { boundsOf, type Pt } from '../geom.ts'
import { floorMapping, mapItem } from '../align.ts'
import { idPrefix, newId } from '../model/ids.ts'
import { adopt } from '../model/suggested.ts'
import type { Item } from '../model/types.ts'
import { shiftItem } from '../interact/arrange.ts'
import { itemBounds } from '../render/bounds.ts'
import type { App } from '../app.ts'

/** How far a paste with nowhere better to go steps from the last one, in screen pixels. */
const STEP_PX = 20

let clip: { items: Item[]; sheetId: string; pastes: number } | null = null

/** Copies what is selected and can be edited; says so, since nothing on screen changes. */
export function copySelection(app: App): number {
  const items = app.store.selectedItems().filter((i) => app.store.isEditable(i))
  if (items.length === 0) return 0
  clip = { items: items.map((i) => structuredClone(i)), sheetId: app.store.sheet.id, pastes: 0 }
  return items.length
}

export function cutSelection(app: App): number {
  const n = copySelection(app)
  if (n === 0) return 0
  // A cut item is pasted where you put it next, not stepped off from where it used to be.
  clip!.pastes = -1
  app.store.activeVertex = null
  app.editor.deleteSelectionOrVertex()
  return n
}

export function hasClipboard(): boolean {
  return clip !== null && clip.items.length > 0
}

export function paste(app: App): number {
  if (!clip || clip.items.length === 0) return 0
  const { store, editor } = app
  const here = store.sheet
  const from = store.project.sheets.find((s) => s.id === clip!.sheetId)
  const mapping = from && from.id !== here.id ? floorMapping(from, here) : null
  const copies = clip.items.map((item) => {
    const copy = mapping ? mapItem(item, mapping) : structuredClone(item)
    copy.id = newId(idPrefix(copy.kind))
    // Whoever suggested the original, the copy is something a person placed.
    adopt(copy)
    return copy
  })

  const cursor = editor.cursorWorld
  let delta: Pt = { x: 0, y: 0 }
  if (cursor) {
    const b = boundsOf(copies.flatMap((c) => {
      const r = itemBounds(c)
      return [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y + r.h }]
    }))
    delta = { x: cursor.x - (b.x + b.w / 2), y: cursor.y - (b.y + b.h / 2) }
  } else if (from?.id === here.id) {
    clip.pastes += 1
    const step = (STEP_PX * clip.pastes) / editor.cam.zoom
    delta = { x: step, y: step }
  }

  store.mutate(() => {
    store.selection.clear()
    store.activeVertex = null
    for (const copy of copies) {
      if (delta.x || delta.y) shiftItem(copy, delta.x, delta.y)
      here.items.push(copy)
      store.selection.add(copy.id)
    }
  })
  return copies.length
}
