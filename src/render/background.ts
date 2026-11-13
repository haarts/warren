import { renderPage } from '../io/pdf.ts'
import { assetData } from '../model/assets.ts'
import type { Sheet } from '../model/types.ts'

const SCALE_STEPS = [1, 1.5, 2, 3, 4, 6, 8, 12, 16]

/**
 * The whole page is rasterised at most this big. Past it a page costs seconds to render and
 * hundreds of megabytes to hold - an A1 plan at 8x is over 300 Mpx - and every frame paints it,
 * which is what made zooming in on a real plan crawl. Sharper than this, only the part on
 * screen is rendered: the detail patch.
 */
const BASE_MAX_PX = 16e6
/** The patch covers the screen plus this much of it again on every side, so a short pan stays sharp. */
const DETAIL_MARGIN = 0.25
const DETAIL_MAX_PX = 24e6
/** Wait for the zoom or pan to come to rest before rendering - each render is real work. */
const SETTLE_MS = 180

export interface Rect { x: number; y: number; w: number; h: number }

/** A sharp rendering of one part of the page, in page points. */
export interface DetailPatch extends Rect {
  canvas: HTMLCanvasElement
  scale: number
}

function pickScale(zoom: number, dpr: number): number {
  const wanted = zoom * dpr
  for (const s of SCALE_STEPS) if (s >= wanted) return s
  return SCALE_STEPS[SCALE_STEPS.length - 1]
}

/** The largest scale at which the whole page stays within BASE_MAX_PX. */
export function baseScaleCap(widthPt: number, heightPt: number): number {
  let cap = SCALE_STEPS[0]
  for (const s of SCALE_STEPS) if (widthPt * heightPt * s * s <= BASE_MAX_PX) cap = s
  return cap
}

/** The view grown by the margin and clipped to the page; shrunk back to the bare view if too big at `scale`. */
export function detailRegion(view: Rect, page: { w: number; h: number }, scale: number): Rect | null {
  const grow = (m: number): Rect | null => {
    const x0 = Math.max(0, view.x - view.w * m)
    const y0 = Math.max(0, view.y - view.h * m)
    const x1 = Math.min(page.w, view.x + view.w * (1 + m))
    const y1 = Math.min(page.h, view.y + view.h * (1 + m))
    if (x1 <= x0 || y1 <= y0) return null
    // Whole points, so the patch's pixels line up with the base raster's.
    return { x: Math.floor(x0), y: Math.floor(y0), w: Math.ceil(x1) - Math.floor(x0), h: Math.ceil(y1) - Math.floor(y0) }
  }
  const wide = grow(DETAIL_MARGIN)
  if (!wide) return null
  if (wide.w * wide.h * scale * scale <= DETAIL_MAX_PX) return wide
  return grow(0)
}

function covers(outer: Rect, inner: Rect): boolean {
  return outer.x <= inner.x && outer.y <= inner.y &&
    outer.x + outer.w >= inner.x + inner.w && outer.y + outer.h >= inner.y + inner.h
}

function clipToPage(view: Rect, page: { w: number; h: number }): Rect | null {
  const x0 = Math.max(0, view.x)
  const y0 = Math.max(0, view.y)
  const x1 = Math.min(page.w, view.x + view.w)
  const y1 = Math.min(page.h, view.y + view.h)
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null
}

/**
 * Keeps the page rasterised: the whole of it up to a sensible size, and past that a sharp patch
 * of just the part on screen, re-rendered once a zoom or pan comes to rest. The project always
 * holds the original PDF, so this is a cache and never the source of truth.
 */
export class Background {
  canvas: HTMLCanvasElement | null = null
  detail: DetailPatch | null = null
  widthPt = 0
  heightPt = 0
  private key = ''
  private scale = 0
  private pending: string | null = null
  private timer: number | null = null
  /** What the base timer will render; asked again for the same, it keeps waiting rather than restarting. */
  private queued = ''
  private detailTimer: number | null = null
  /** The view and scale the detail timer was set for: a frame that redraws without moving leaves it running. */
  private detailQueued = ''
  private detailInFlight: (Rect & { scale: number }) | null = null
  /** Bumped on every page change, so a render started for the old page is dropped. */
  private generation = 0

  constructor(private onReady: () => void) {}

  clear(): void {
    this.canvas = null
    this.detail = null
    this.key = ''
    this.scale = 0
    this.widthPt = 0
    this.heightPt = 0
    this.generation++
    this.cancelDetailTimer()
    this.detailInFlight = null
  }

  private cancelDetailTimer(): void {
    if (this.detailTimer !== null) clearTimeout(this.detailTimer)
    this.detailTimer = null
    this.detailQueued = ''
  }

  get size(): { w: number; h: number } | null {
    return this.canvas ? { w: this.widthPt, h: this.heightPt } : null
  }

  /**
   * Call every frame; cheap unless the sheet or the required resolution changed. `view` is the
   * part of the page on screen, in points; without it only the whole-page raster is kept.
   */
  sync(sheet: Sheet, zoom: number, dpr: number, view?: Rect): void {
    if (!sheet.pdf || !assetData(sheet.pdf.assetId)) {
      // No plan, or it has not been located yet; draw the overlay on its own.
      if (this.canvas) this.clear()
      return
    }
    const key = `${sheet.pdf.assetId}:${sheet.pdf.page}:${sheet.pdf.rotation}`
    const wantScale = pickScale(zoom, dpr)
    const page = { w: this.widthPt || sheet.pdf.widthPt, h: this.heightPt || sheet.pdf.heightPt }
    const cap = baseScaleCap(page.w, page.h)
    const baseScale = Math.min(wantScale, cap)

    if (key !== this.key) {
      if (this.pending !== `${key}@${baseScale}`) {
        // Different page: show it as soon as possible, sharpen later.
        this.clear()
        this.scheduleBase(sheet, key, baseScale, 0)
      }
      return
    }
    if (baseScale > this.scale && this.pending !== `${key}@${baseScale}`) this.scheduleBase(sheet, key, baseScale, SETTLE_MS)

    if (!view || wantScale <= this.scale) {
      // The whole-page raster is sharp enough here: drop the patch rather than hold it.
      this.detail = null
      this.cancelDetailTimer()
      return
    }
    const seen = clipToPage(view, page)
    if (!seen) return
    const enough = (p: (Rect & { scale: number }) | null): boolean => p !== null && p.scale >= wantScale && covers(p, seen)
    if (enough(this.detail) || enough(this.detailInFlight)) {
      this.cancelDetailTimer()
      return
    }
    // Wait for the view to come to rest, then render what is on screen then. A redraw that
    // did not move it - a hover, a selection - leaves the wait running.
    const target = `${view.x},${view.y},${view.w},${view.h}@${wantScale}`
    if (target === this.detailQueued) return
    this.cancelDetailTimer()
    this.detailQueued = target
    this.detailTimer = window.setTimeout(() => {
      this.detailTimer = null
      this.detailQueued = ''
      const region = detailRegion(view, page, wantScale)
      if (region) void this.renderDetail(sheet, region, wantScale)
    }, SETTLE_MS)
  }

  private scheduleBase(sheet: Sheet, key: string, scale: number, delay: number): void {
    if (this.timer !== null && this.queued === `${key}@${scale}`) return
    if (this.timer !== null) clearTimeout(this.timer)
    this.queued = `${key}@${scale}`
    const generation = this.generation
    this.timer = window.setTimeout(() => {
      this.timer = null
      this.queued = ''
      void this.renderBase(sheet, key, scale, generation)
    }, delay)
  }

  private async renderBase(sheet: Sheet, key: string, scale: number, generation: number): Promise<void> {
    if (!sheet.pdf) return
    const base64 = assetData(sheet.pdf.assetId)
    if (!base64) return
    this.pending = `${key}@${scale}`
    try {
      const result = await renderPage(sheet.pdf.assetId, base64, sheet.pdf, scale)
      if (generation !== this.generation) return
      this.canvas = result.canvas
      this.widthPt = result.widthPt
      this.heightPt = result.heightPt
      this.key = key
      this.scale = scale
      this.onReady()
    } catch (err) {
      console.error('PDF render failed', err)
    } finally {
      if (this.pending === `${key}@${scale}`) this.pending = null
    }
  }

  private async renderDetail(sheet: Sheet, region: Rect, scale: number): Promise<void> {
    if (!sheet.pdf) return
    const base64 = assetData(sheet.pdf.assetId)
    if (!base64) return
    const generation = this.generation
    const job = { ...region, scale }
    this.detailInFlight = job
    try {
      const result = await renderPage(sheet.pdf.assetId, base64, sheet.pdf, scale, region)
      if (generation !== this.generation) return
      this.detail = { ...region, scale, canvas: result.canvas }
      this.onReady()
    } catch (err) {
      console.error('PDF render failed', err)
    } finally {
      if (this.detailInFlight === job) this.detailInFlight = null
    }
  }
}
