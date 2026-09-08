import type { NoteItem } from '../model/types.ts'

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
