import { assetData } from '../model/assets.ts'
import type { Store } from '../model/doc.ts'
import { Camera } from '../render/camera.ts'
import { drawScene } from '../render/scene.ts'
import { asCanvasContext, SvgContext } from '../render/svgContext.ts'
import { newCanvas, renderPage } from './pdf.ts'

export interface ExportOptions {
  /** Output pixels per PDF point. 4 ≈ 288 dpi. */
  scale: number
  includeBackground: boolean
  backgroundOpacity?: number
}

/**
 * Renders the active sheet standalone: no selection, no handles, white paper. Label sizes are
 * expressed in points (≈7pt) rather than screen pixels so a print looks like a drawing rather
 * than a screenshot.
 */
export async function renderSheetImage(store: Store, opts: ExportOptions): Promise<HTMLCanvasElement> {
  const page = await preparePage(store, opts)
  const out = newCanvas(page.width, page.height, 'Canvas 2D unavailable')
  drawPage(store, opts, page, out.getContext('2d')!)
  return out
}

/**
 * The same drawing as SVG: everything Warren draws stays vector - lines, symbols, every label -
 * so a PDF printed from it is sharp however far you zoom. The architect's plan underneath is
 * still a picture, at the resolution asked for: the browser cannot place a PDF page inside a
 * printed one as vectors.
 */
export async function renderSheetSvg(store: Store, opts: ExportOptions): Promise<{ svg: string; width: number; height: number }> {
  const page = await preparePage(store, opts)
  const ctx = new SvgContext(page.width, page.height)
  drawPage(store, opts, page, asCanvasContext(ctx))
  return { svg: ctx.toSvg(), width: page.width, height: page.height }
}

interface Page { bg: HTMLCanvasElement | null; widthPt: number; heightPt: number; width: number; height: number; scale: number }

async function preparePage(store: Store, opts: ExportOptions): Promise<Page> {
  const sheet = store.sheet
  const scale = Math.max(0.25, opts.scale)
  let bg: HTMLCanvasElement | null = null
  let widthPt = sheet.pdf?.widthPt ?? 595
  let heightPt = sheet.pdf?.heightPt ?? 842

  if (opts.includeBackground && sheet.pdf) {
    const base64 = assetData(sheet.pdf.assetId)
    if (base64) {
      const rendered = await renderPage(sheet.pdf.assetId, base64, sheet.pdf, scale)
      bg = rendered.canvas
      widthPt = rendered.widthPt
      heightPt = rendered.heightPt
    }
  }
  return { bg, widthPt, heightPt, width: Math.round(widthPt * scale), height: Math.round(heightPt * scale), scale }
}

function drawPage(store: Store, opts: ExportOptions, page: Page, ctx: CanvasRenderingContext2D): void {
  const cam = new Camera()
  cam.x = 0
  cam.y = 0
  cam.zoom = page.scale

  const settings = store.project.settings
  const prevOpacity = settings.backgroundOpacity
  if (opts.backgroundOpacity !== undefined) settings.backgroundOpacity = opts.backgroundOpacity
  try {
    drawScene({
      ctx,
      store,
      cam,
      width: page.width,
      height: page.height,
      background: page.bg,
      backgroundSize: page.bg ? { w: page.widthPt, h: page.heightPt } : null,
      uiScale: page.scale * 0.65,
      interactive: false,
      paper: true,
    })
  } finally {
    settings.backgroundOpacity = prevOpacity
  }
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png'): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode image'))), type)
  })
}

export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
