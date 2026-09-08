import type { Store } from '../model/doc.ts'
import { Camera } from '../render/camera.ts'
import { drawScene } from '../render/scene.ts'
import { renderPage } from './pdf.ts'

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
  const sheet = store.sheet
  const scale = Math.max(0.25, opts.scale)
  let bg: HTMLCanvasElement | null = null
  let widthPt = sheet.pdf?.widthPt ?? 595
  let heightPt = sheet.pdf?.heightPt ?? 842

  if (opts.includeBackground && sheet.pdf) {
    const base64 = store.project.assets[sheet.pdf.assetId]
    if (base64) {
      const rendered = await renderPage(sheet.pdf.assetId, base64, sheet.pdf, scale)
      bg = rendered.canvas
      widthPt = rendered.widthPt
      heightPt = rendered.heightPt
    }
  }

  const out = document.createElement('canvas')
  out.width = Math.max(1, Math.round(widthPt * scale))
  out.height = Math.max(1, Math.round(heightPt * scale))
  const ctx = out.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D unavailable')

  const cam = new Camera()
  cam.x = 0
  cam.y = 0
  cam.zoom = scale

  const settings = store.project.settings
  const prevOpacity = settings.backgroundOpacity
  if (opts.backgroundOpacity !== undefined) settings.backgroundOpacity = opts.backgroundOpacity
  try {
    drawScene({
      ctx,
      store,
      cam,
      width: out.width,
      height: out.height,
      background: bg,
      backgroundSize: bg ? { w: widthPt, h: heightPt } : null,
      uiScale: scale * 0.65,
      interactive: false,
      paper: true,
    })
  } finally {
    settings.backgroundOpacity = prevOpacity
  }
  return out
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
