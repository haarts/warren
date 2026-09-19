/**
 * Sheets: one project can hold a floor plan per storey. Adding, renaming, deleting one, and
 * copying the current selection across to another at the same coordinates.
 */
import { newId } from '../model/ids.ts'
import { emptySheet } from '../model/doc.ts'
import type { Sheet } from '../model/types.ts'
import { alertDialog, confirmDialog } from '../ui/modal.ts'
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
  app.store.mutate(() => {
    for (const item of items) {
      const copy = structuredClone(item)
      copy.id = newId(item.kind)
      target.items.push(copy)
    }
  })
  app.editor.flash(`Copied ${items.length} item(s) to ${target.name} at the same position`)
}
