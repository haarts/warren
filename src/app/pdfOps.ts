/**
 * The plan underneath the drawing: importing a PDF page onto a sheet, rotating or removing it,
 * and reframing the camera once the sheet's shape has changed.
 */
import { assetData, describeAsset } from '../model/assets.ts'
import { forgetDocument, pageSizePt } from '../io/pdf.ts'
import { emptySheet } from '../model/doc.ts'
import type { Project, Sheet } from '../model/types.ts'
import { base64ToBytes, bytesToBase64, sha256Hex } from '../io/base64.ts'
import { cacheAsset } from '../io/assetCache.ts'
import { downloadBlob } from '../io/exportImage.ts'
import { promptForFile } from '../io/projectFile.ts'
import { alertDialog, confirmDialog, guarded } from '../ui/modal.ts'
import { openPdfImportDialog } from '../ui/pdfImport.ts'
import { zoomToFit } from '../interact/view.ts'
import type { App } from '../app.ts'

/** The plan under the drawing changed shape - redraw it and reframe on the new sheet. */
export function refit(app: App): void { app.editor.invalidateBackground(); zoomToFit(app.editor) }

export async function importPdf(app: App, target: 'current' | 'new'): Promise<void> {
  const file = await promptForFile('application/pdf,.pdf')
  if (!file) return
  await guarded('Could not read that PDF', async () => {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const assetId = await sha256Hex(bytes)
    await cacheAsset(assetId, bytesToBase64(bytes))
    app.store.project.assets[assetId] = { name: file.name, bytes: bytes.length }
    await openPdfImportDialog(app, assetId, file.name, target)
  })
}

export async function attachPage(
  app: App, assetId: string, page: number, target: 'current' | 'new', sourceName: string,
): Promise<void> {
  const base64 = assetData(assetId)
  if (!base64) return
  const size = await pageSizePt(assetId, base64, page, 0)
  const name = `${sourceName.replace(/\.pdf$/i, '')} p${page}`
  app.store.mutate(() => {
    let sheet: Sheet
    if (target === 'new') {
      sheet = emptySheet(name)
      app.store.project.sheets.push(sheet)
      app.store.project.activeSheetId = sheet.id
    } else {
      sheet = app.store.sheet
      if (sheet.name === 'Ground floor' && sheet.items.length === 0) sheet.name = name
    }
    sheet.pdf = { assetId, page, rotation: 0, widthPt: size.widthPt, heightPt: size.heightPt }
  })
  app.store.selection.clear()
  refit(app)
}

/**
 * The project points at a plan this browser has never seen. Ask for it by name and check the
 * hash, so there is no way to attach the wrong file by accident.
 */
export async function locateMissingAssets(app: App, project: Project, missing: string[]): Promise<void> {
  const names = missing.map((id) => describeAsset(project.assets, id)).join(', ')
  const ok = await confirmDialog(
    'The plan PDF is stored separately',
    `This project refers to ${names}, which this browser does not have a copy of. ` +
    'Locate it now? The drawing opens either way — only the plan underneath is missing.',
    'Locate…',
  )
  if (!ok) return
  const file = await promptForFile('application/pdf,.pdf')
  if (!file) return
  const bytes = new Uint8Array(await file.arrayBuffer())
  const id = await sha256Hex(bytes)
  if (!missing.includes(id)) {
    alertDialog('That is a different PDF', `"${file.name}" does not match the plan this project was drawn on.`)
    return
  }
  await cacheAsset(id, bytesToBase64(bytes))
  app.exportedAssets.add(id)
  refit(app)
  app.editor.flash(`Found ${file.name}`)
}

export function rotateSheet(app: App, delta: 90 | -90): void {
  const sheet = app.store.sheet
  if (!sheet.pdf) return
  const base64 = assetData(sheet.pdf.assetId)
  if (!base64) return
  const next = ((sheet.pdf.rotation + delta + 360) % 360) as 0 | 90 | 180 | 270
  void pageSizePt(sheet.pdf.assetId, base64, sheet.pdf.page, next).then((size) => {
    app.store.mutate(() => {
      const s = app.store.sheet
      if (!s.pdf) return
      s.pdf.rotation = next
      s.pdf.widthPt = size.widthPt
      s.pdf.heightPt = size.heightPt
    })
    refit(app)
  })
}

export function detachPdf(app: App): void {
  const sheet = app.store.sheet
  if (!sheet.pdf) return
  const assetId = sheet.pdf.assetId
  app.store.mutate(() => { app.store.sheet.pdf = null })
  forgetDocument(assetId)
  app.editor.invalidateBackground()
}

/** Writes one plan PDF out. Returns false when its bytes are not available. */
export function exportPlanPdf(app: App, assetId?: string): boolean {
  const id = assetId ?? app.store.sheet.pdf?.assetId
  if (!id) return false
  const data = assetData(id)
  if (!data) return false
  const ref = app.store.project.assets[id]
  const bytes = base64ToBytes(data)
  const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: 'application/pdf' })
  downloadBlob(ref?.name || `${id.slice(0, 12)}.pdf`, blob)
  app.exportedAssets.add(id)
  return true
}

/**
 * The project file now points at the PDF instead of containing it, so the PDF has to exist
 * beside it. Written once per asset per session rather than on every save.
 */
export async function ensurePlanPdfOnDisk(app: App): Promise<void> {
  for (const id of Object.keys(app.store.project.assets)) {
    if (app.exportedAssets.has(id)) continue
    if (!app.store.project.sheets.some((s) => s.pdf?.assetId === id)) continue
    if (exportPlanPdf(app, id)) app.exportedAssets.add(id)
  }
}
