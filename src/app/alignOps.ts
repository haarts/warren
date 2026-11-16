/**
 * Lining floors up: show another floor underneath this one and nudge it until walls land on
 * walls. A floor nobody has lined up yet starts in the same place on its page, at the size the
 * two calibrations imply - see `ensurePlaced`.
 */
import { ensurePlaced } from '../align.ts'
import type { Sheet } from '../model/types.ts'
import type { App } from '../app.ts'

/** Show `other` under the current sheet, placing either first if it has never been lined up. */
export function showUnderneath(app: App, other: Sheet | null): void {
  const { store, editor } = app
  const sheet = store.sheet
  if (other && other.id !== sheet.id && (!other.align || !sheet.align)) {
    store.mutate(() => { ensurePlaced(sheet, other) })
  }
  editor.ghostSheetId = other && other.id !== sheet.id ? other.id : null
  editor.requestRender()
  app.refresh()
}
