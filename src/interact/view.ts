/**
 * The viewport: the camera, resizing to the host element, and turning editor state into one
 * frame - the background PDF, the scene, an overlay of whatever gesture is in progress, and the
 * status line, which is just that same state read back out as words instead of pixels.
 */
import { boundsOf, normalizeRect, polylineLength, type Pt } from '../geom.ts'
import type { Item } from '../model/types.ts'
import { itemBounds } from '../render/bounds.ts'
import { drawScene, type Overlay } from '../render/scene.ts'
import { formatMetres } from '../units.ts'
import { tipBearing } from '../directions.ts'
import { compassPart } from './compass.ts'
import type { Editor } from './editor.ts'

export function attachView(ed: Editor): void {
  const ro = new ResizeObserver(() => resize(ed))
  ro.observe(ed.canvas.parentElement ?? ed.canvas)
  resize(ed)
}

function resize(ed: Editor): void {
  const host = ed.canvas.parentElement ?? ed.canvas
  const rect = host.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  ed.cssWidth = Math.max(1, Math.floor(rect.width))
  ed.cssHeight = Math.max(1, Math.floor(rect.height))
  ed.canvas.width = Math.floor(ed.cssWidth * dpr)
  ed.canvas.height = Math.floor(ed.cssHeight * dpr)
  ed.canvas.style.width = `${ed.cssWidth}px`
  ed.canvas.style.height = `${ed.cssHeight}px`
  ed.requestRender()
}

export function requestRender(ed: Editor): void {
  if (ed.frameQueued) return
  ed.frameQueued = true
  requestAnimationFrame(() => {
    ed.frameQueued = false
    render(ed)
  })
}

function render(ed: Editor): void {
  const dpr = window.devicePixelRatio || 1
  ed.bg.sync(ed.store.sheet, ed.cam.zoom, dpr)
  ed.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  drawScene({
    ctx: ed.ctx,
    store: ed.store,
    cam: ed.cam,
    width: ed.cssWidth,
    height: ed.cssHeight,
    background: ed.bg.canvas,
    backgroundSize: ed.bg.size,
    interactive: true,
    overlay: overlay(ed),
  })
  ed.canvas.style.cursor = cursorFor(ed)
  publishStatus(ed)
}

function overlay(ed: Editor): Overlay {
  return {
    draftPoints: ed.draft.length ? ed.draft : undefined,
    draftCursor: ed.draft.length ? ed.draftCursor : null,
    draftSystemId: ed.activeSystemId,
    boxDraft: ed.drag.mode === 'newBox' ? normalizeRect(ed.drag.start, ed.drag.current) : null,
    rubberBand: ed.drag.mode === 'rubber' ? normalizeRect(ed.drag.start, ed.drag.current) : null,
    snapPoint: ed.snap?.point ?? null,
    snapLabel: ed.snap?.label ?? null,
    measure: ed.measurePts.length === 2
      ? { a: ed.measurePts[0], b: ed.measurePts[1] }
      : ed.measurePts.length === 1 && ed.cursorWorld
        ? { a: ed.measurePts[0], b: ed.cursorWorld }
        : null,
    hoverId: ed.hover.id,
    hoverLockedId: ed.hover.locked,
    compass: compassPart(ed),
  }
}

function cursorFor(ed: Editor): string {
  if (ed.spaceHeld || ed.drag.mode === 'pan') return 'grab'
  const rose = compassPart(ed)
  if (rose) return rose.part === 'tip' ? 'grab' : 'move'
  if (ed.tool === 'select') return ed.hover.id ? 'move' : 'default'
  return 'crosshair'
}

export function zoomBy(ed: Editor, factor: number): void {
  ed.cam.zoomAt(ed.cssWidth / 2, ed.cssHeight / 2, factor)
  ed.requestRender()
}

export function zoomToFit(ed: Editor): void {
  const pdf = ed.store.sheet.pdf
  const { w, h } = ed.bg.size ?? (pdf ? { w: pdf.widthPt, h: pdf.heightPt } : { w: 595, h: 842 })
  ed.cam.fit({ x: 0, y: 0, w, h }, ed.cssWidth, ed.cssHeight)
  ed.requestRender()
}

export function zoomToSelection(ed: Editor): void {
  const items = ed.store.selectedItems()
  if (items.length === 0) return zoomToFit(ed)
  const corners = (it: Item): Pt[] => {
    if (it.kind === 'run') return it.points
    const b = itemBounds(it)
    return [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y + b.h }]
  }
  const b = boundsOf(items.flatMap(corners))
  const pad = Math.max(20, b.w * 0.15)
  ed.cam.fit({ x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 }, ed.cssWidth, ed.cssHeight)
  ed.requestRender()
}

// --- status line -------------------------------------------------------------------------

export function clearFlashIfStale(ed: Editor): void {
  if (ed.flashState && Date.now() > ed.flashState.hold) ed.flashState = null
}

/**
 * Rebuilt every frame from the cursor, the active tool and whatever is mid-gesture, except for
 * a `flash()` message, which stays put for a moment before this takes back over.
 */
function publishStatus(ed: Editor): void {
  if (!ed.onStatus) return
  if (ed.flashState && Date.now() < ed.flashState.until) {
    ed.onStatus(ed.flashState.text)
    return
  }
  ed.flashState = null
  const mmPerPoint = ed.store.sheet.mmPerPoint
  const parts: string[] = []
  if (ed.cursorWorld) {
    if (mmPerPoint) {
      parts.push(`x ${(ed.cursorWorld.x * mmPerPoint / 1000).toFixed(2)} m, y ${(ed.cursorWorld.y * mmPerPoint / 1000).toFixed(2)} m`)
    } else {
      parts.push(`x ${ed.cursorWorld.x.toFixed(0)} pt, y ${ed.cursorWorld.y.toFixed(0)} pt`)
    }
  }
  parts.push(`zoom ${(ed.cam.zoom * 100).toFixed(0)}%`)
  if (ed.trackpadSeen) parts.push('two fingers pan · pinch or ⌥scroll zooms')
  if (ed.snap?.label) parts.push(`snap: ${ed.snap.label}`)
  if (ed.hover.locked) {
    const item = ed.store.item(ed.hover.locked)
    if (item?.locked) parts.push('locked item — use "Unlock all" in the Properties tab')
    else if (item) parts.push(`"${ed.store.system(item.systemId).name}" is locked — unlock it in the Layers tab`)
  }
  if (ed.tool === 'run' && ed.draft.length) parts.push('Enter/double-click finishes · Backspace removes last point · Esc cancels')
  if (ed.tool === 'calibrate') parts.push(ed.measurePts.length === 0 ? 'Click the first end of a known dimension' : 'Click the second end')
  const rose = ed.store.project.compass
  const part = compassPart(ed)
  if (rose && part?.part === 'tip') {
    parts.push(`compass rose tip ${part.tip + 1} at ${Math.round(tipBearing(rose, part.tip))}° — drag to turn the rose, Shift for 45° steps`)
  } else if (rose && part?.part === 'hub') {
    parts.push('compass rose — drag the centre to move it; name the tips in Properties')
  }
  if (ed.tool === 'direction') parts.push(ed.measurePts.length === 0 ? 'Click a point, then click again toward the direction you mean' : 'Click again, in the direction this points to')
  ed.onStatus(parts.join('   ·   '))
}

/** Selection summary for the status bar. */
export function selectionSummary(ed: Editor): string {
  const items = ed.store.selectedItems()
  if (items.length === 0) return 'Nothing selected'
  if (items.length === 1) {
    const it = items[0]
    const sys = ed.store.system(it.systemId)
    if (it.kind === 'run') {
      const mmPerPoint = ed.store.sheet.mmPerPoint
      const len = mmPerPoint ? formatMetres(polylineLength(it.points) * mmPerPoint, 2) : '—'
      return `${sys.name} · ${it.points.length} points · ${len}`
    }
    if (it.kind === 'note') return `Note · ${sys.name}`
    return `${sys.name} · ${it.kind}`
  }
  return `${items.length} items selected`
}
