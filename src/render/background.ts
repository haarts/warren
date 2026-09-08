import { renderPage } from '../io/pdf.ts'
import type { Project, Sheet } from '../model/types.ts'

const SCALE_STEPS = [1, 1.5, 2, 3, 4, 6, 8]

function pickScale(zoom: number, dpr: number): number {
  const wanted = zoom * dpr
  for (const s of SCALE_STEPS) if (s >= wanted) return s
  return SCALE_STEPS[SCALE_STEPS.length - 1]
}

/**
 * Keeps one rasterised page around, re-rendering at a higher scale as you zoom in. The
 * project always holds the original PDF, so this is a cache and never the source of truth.
 */
export class Background {
  canvas: HTMLCanvasElement | null = null
  widthPt = 0
  heightPt = 0
  private key = ''
  private scale = 0
  private pending: string | null = null
  private timer: number | null = null

  constructor(private onReady: () => void) {}

  clear(): void {
    this.canvas = null
    this.key = ''
    this.scale = 0
    this.widthPt = 0
    this.heightPt = 0
  }

  get size(): { w: number; h: number } | null {
    return this.canvas ? { w: this.widthPt, h: this.heightPt } : null
  }

  /** Call every frame; cheap unless the sheet or the required resolution changed. */
  sync(project: Project, sheet: Sheet, zoom: number, dpr: number): void {
    if (!sheet.pdf) {
      if (this.canvas) this.clear()
      return
    }
    const base64 = project.assets[sheet.pdf.assetId]
    if (!base64) {
      if (this.canvas) this.clear()
      return
    }
    const key = `${sheet.pdf.assetId}:${sheet.pdf.page}:${sheet.pdf.rotation}`
    const wantScale = pickScale(zoom, dpr)
    if (key === this.key && wantScale <= this.scale) return
    if (this.pending === `${key}@${wantScale}`) return

    if (key !== this.key) {
      // Different page: show it as soon as possible at a modest scale, sharpen later.
      this.clear()
    }
    this.schedule(project, sheet, key, wantScale, key !== this.key ? 0 : 180)
  }

  private schedule(project: Project, sheet: Sheet, key: string, scale: number, delay: number): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      this.timer = null
      void this.run(project, sheet, key, scale)
    }, delay)
  }

  private async run(project: Project, sheet: Sheet, key: string, scale: number): Promise<void> {
    if (!sheet.pdf) return
    const base64 = project.assets[sheet.pdf.assetId]
    if (!base64) return
    this.pending = `${key}@${scale}`
    try {
      const result = await renderPage(sheet.pdf.assetId, base64, sheet.pdf, scale)
      this.canvas = result.canvas
      this.widthPt = result.widthPt
      this.heightPt = result.heightPt
      this.key = key
      this.scale = scale
      this.onReady()
    } catch (err) {
      console.error('PDF render failed', err)
    } finally {
      this.pending = null
    }
  }
}
