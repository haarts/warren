import type { NoteItem } from '../model/types.ts'
import { DIMMED, isDimmed, type DrawCtx } from './draw.ts'

/**
 * Note text is laid out in world units, so a note zooms with the drawing like everything else
 * and needs measuring only once per (width, text) pair rather than once per frame.
 */
export const NOTE_FONT = 7
export const NOTE_LINE_HEIGHT = NOTE_FONT * 1.35
export const NOTE_PAD = 4
export const NOTE_STRIPE = 3
export const NOTE_DEFAULT_WIDTH = 90
export const NOTE_MIN_WIDTH = 30

const NOTE_BODY = '#fef3c7'
const NOTE_EDGE = '#d4a72c'
const NOTE_FOLD = '#e8d08a'
const NOTE_INK = '#422006'
/** Below this on-screen width the text is unreadable, so collapse to a marker instead. */
const NOTE_COLLAPSE_PX = 46

export const noteFont = (scale: number): string =>
  `${NOTE_FONT * scale}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`

export interface NoteLayout {
  lines: string[]
  /** Total height in world units, including padding. */
  h: number
}

let measurer: CanvasRenderingContext2D | null = null
const cache = new Map<string, NoteLayout>()

function context(): CanvasRenderingContext2D | null {
  if (!measurer) {
    const canvas = document.createElement('canvas')
    measurer = canvas.getContext('2d')
    if (measurer) measurer.font = noteFont(1)
  }
  return measurer
}

export function measureNote(note: Pick<NoteItem, 'text' | 'w'>): NoteLayout {
  const width = Math.max(NOTE_MIN_WIDTH, note.w)
  const key = `${width.toFixed(2)}|${note.text}`
  const hit = cache.get(key)
  if (hit) return hit

  const ctx = context()
  const inner = width - NOTE_PAD * 2 - NOTE_STRIPE
  const lines: string[] = []

  for (const paragraph of (note.text || '').split('\n')) {
    if (paragraph.trim() === '') {
      lines.push('')
      continue
    }
    let line = ''
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word
      const fits = !ctx || ctx.measureText(candidate).width <= inner
      if (fits || !line) {
        line = candidate
      } else {
        lines.push(line)
        line = word
      }
    }
    lines.push(line)
  }
  if (lines.length === 0) lines.push('')

  const layout: NoteLayout = {
    lines,
    h: lines.length * NOTE_LINE_HEIGHT + NOTE_PAD * 2,
  }
  // Bounded so a long editing session cannot grow this without limit.
  if (cache.size > 500) cache.clear()
  cache.set(key, layout)
  return layout
}

export function noteHeight(note: Pick<NoteItem, 'text' | 'w'>): number {
  return measureNote(note).h
}

/**
 * A new note is sized from the sheet, not from the current zoom: two notes placed at different
 * magnifications should still come out the same size on the printed drawing.
 */
export function defaultNoteWidth(pageWidthPt: number): number {
  return Math.min(240, Math.max(60, pageWidthPt * 0.12))
}

/** A sticky note: a folded-corner card zoomed out to a tab, expanding to wrapped text up close. */
export function drawNote(dc: DrawCtx, note: NoteItem): void {
  const { ctx, cam, store, ui } = dc
  const accent = isDimmed(dc, note) ? DIMMED : note.colorOverride ?? store.system(note.systemId).color
  const x = cam.toScreenX(note.x)
  const y = cam.toScreenY(note.y)
  const w = note.w * cam.zoom

  ctx.save()
  ctx.setLineDash([])

  if (w < NOTE_COLLAPSE_PX) {
    // Zoomed out: show where the note is, not what it says.
    const s = 11 * ui
    ctx.fillStyle = NOTE_BODY
    ctx.strokeStyle = NOTE_EDGE
    ctx.lineWidth = 1 * ui
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + s, y)
    ctx.lineTo(x + s, y + s * 0.65)
    ctx.lineTo(x + s * 0.65, y + s)
    ctx.lineTo(x, y + s)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = accent
    ctx.fillRect(x, y, Math.max(1.5, s * 0.18), s)
    ctx.restore()
    return
  }

  const layout = measureNote(note)
  const h = layout.h * cam.zoom
  const fold = Math.min(10 * ui, w * 0.22, h * 0.4)

  ctx.fillStyle = NOTE_BODY
  ctx.strokeStyle = NOTE_EDGE
  ctx.lineWidth = 1 * ui
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x + w, y)
  ctx.lineTo(x + w, y + h - fold)
  ctx.lineTo(x + w - fold, y + h)
  ctx.lineTo(x, y + h)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()

  // The folded corner, and the stripe that says which layer this note belongs to.
  ctx.fillStyle = NOTE_FOLD
  ctx.beginPath()
  ctx.moveTo(x + w - fold, y + h)
  ctx.lineTo(x + w - fold, y + h - fold)
  ctx.lineTo(x + w, y + h - fold)
  ctx.closePath()
  ctx.fill()
  ctx.strokeStyle = NOTE_EDGE
  ctx.stroke()

  ctx.fillStyle = accent
  ctx.fillRect(x, y, NOTE_STRIPE * cam.zoom, h)

  ctx.fillStyle = NOTE_INK
  ctx.font = noteFont(cam.zoom)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()
  const left = x + (NOTE_STRIPE + NOTE_PAD) * cam.zoom
  layout.lines.forEach((line, i) => {
    ctx.fillText(line, left, y + (NOTE_PAD + i * NOTE_LINE_HEIGHT) * cam.zoom)
  })
  ctx.restore()
  ctx.restore()
}
