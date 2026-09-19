import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { base64ToBytes } from './base64.ts'
import type { SheetPdf } from '../model/types.ts'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export interface PageRender {
  canvas: HTMLCanvasElement
  /** Page size in PDF points at the requested rotation - this is our world size. */
  widthPt: number
  heightPt: number
  scale: number
}

const docs = new Map<string, Promise<PDFDocumentProxy>>()

export function loadDocument(assetId: string, base64: string): Promise<PDFDocumentProxy> {
  let existing = docs.get(assetId)
  if (!existing) {
    // pdf.js detaches the buffer it is handed, so decode a fresh copy per document.
    existing = pdfjs.getDocument({ data: base64ToBytes(base64) }).promise
    docs.set(assetId, existing)
  }
  return existing
}

export function forgetDocument(assetId: string): void {
  docs.delete(assetId)
}

export async function pageCount(assetId: string, base64: string): Promise<number> {
  const doc = await loadDocument(assetId, base64)
  return doc.numPages
}

export async function pageSizePt(
  assetId: string, base64: string, page: number, rotation: number,
): Promise<{ widthPt: number; heightPt: number }> {
  const doc = await loadDocument(assetId, base64)
  const pg = await doc.getPage(page)
  const vp = pg.getViewport({ scale: 1, rotation: normalizeRotation(pg.rotate + rotation) })
  return { widthPt: vp.width, heightPt: vp.height }
}

function normalizeRotation(deg: number): number {
  return ((deg % 360) + 360) % 360
}

/** A canvas of `width` x `height` px (at least 1 either way), with a 2D context guaranteed to exist. */
export function newCanvas(width: number, height: number, errorMessage: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, width)
  canvas.height = Math.max(1, height)
  if (!canvas.getContext('2d')) throw new Error(errorMessage)
  return canvas
}

const viewportCanvas = (viewport: { width: number; height: number }): HTMLCanvasElement =>
  newCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height), 'Could not get a 2D context for PDF rendering')

/**
 * Rasterise one page. We keep the source PDF in the project and re-render on demand rather
 * than storing a flattened image, so zooming in stays sharp and the plan can be re-exported
 * at any resolution years from now.
 */
export async function renderPage(
  assetId: string, base64: string, spec: Pick<SheetPdf, 'page' | 'rotation'>, scale: number,
): Promise<PageRender> {
  const doc = await loadDocument(assetId, base64)
  const pg = await doc.getPage(spec.page)
  const rotation = normalizeRotation(pg.rotate + spec.rotation)
  const base = pg.getViewport({ scale: 1, rotation })
  const viewport = pg.getViewport({ scale, rotation })
  const canvas = viewportCanvas(viewport)
  await pg.render({ canvas, viewport, background: '#ffffff' }).promise
  return { canvas, widthPt: base.width, heightPt: base.height, scale }
}

export async function renderThumbnail(
  assetId: string, base64: string, page: number, maxPx: number,
): Promise<HTMLCanvasElement> {
  const doc = await loadDocument(assetId, base64)
  const pg = await doc.getPage(page)
  const base = pg.getViewport({ scale: 1, rotation: pg.rotate })
  const scale = maxPx / Math.max(base.width, base.height)
  const viewport = pg.getViewport({ scale, rotation: pg.rotate })
  const canvas = viewportCanvas(viewport)
  await pg.render({ canvas, viewport, background: '#ffffff' }).promise
  return canvas
}
