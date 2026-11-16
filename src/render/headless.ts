/**
 * The page behind `warren render`. The command line cannot draw - there is no canvas in node -
 * so it opens this in headless Chrome and asks for a picture. Everything is drawn by the same
 * code as the app's window, so a render shows exactly what a person would see there, and the
 * plan goes through the same pdf.js.
 *
 * The request and the plan's bytes come from the little server `warren render` runs for the
 * occasion; the PNG goes back as the return value of `window.warrenRender()`.
 */
import { newCanvas, renderPage } from '../io/pdf.ts'
import { bytesToBase64 } from '../io/base64.ts'
import { parseProject } from '../io/projectFile.ts'
import { registerAsset } from '../model/assets.ts'
import { Store } from '../model/doc.ts'
import { Camera } from './camera.ts'
import { drawScene } from './scene.ts'
import { drawItemOutline } from './selection.ts'

export interface RenderRequest {
  /** The project file's text. */
  project: string
  sheetId: string
  /** The part of the sheet to draw, in PDF points. */
  region: { x: number; y: number; w: number; h: number }
  /** Output pixels per PDF point. */
  scale: number
  plan: boolean
  /** Grid spacing in metres, or null for none. */
  gridM: number | null
  /** Items to outline, the way the app shows a selection. */
  highlight: string[]
  /** Label and line sizes, relative to the app's window. */
  uiScale: number
}

declare global {
  interface Window {
    warrenRender: () => Promise<string>
    warrenReady: boolean
  }
}

window.warrenRender = async (): Promise<string> => {
  const req = await (await fetch('/__render/request')).json() as RenderRequest
  const project = parseProject(req.project)
  const sheet = project.sheets.find((s) => s.id === req.sheetId)
  if (!sheet) throw new Error(`no sheet ${req.sheetId}`)

  const store = new Store()
  store.loadProject(project, null)
  store.setActiveSheet(sheet.id)

  const { region, scale } = req
  const out = newCanvas(Math.round(region.w * scale), Math.round(region.h * scale), 'Canvas 2D unavailable')
  const ctx = out.getContext('2d')!
  const cam = new Camera()
  cam.x = region.x
  cam.y = region.y
  cam.zoom = scale

  // The page, rendered for just this region: a whole A1 plan at a close zoom is hundreds of
  // megapixels, and only the part in the picture is wanted. It goes in as the "detail patch"
  // over a white page, exactly as the window draws a close zoom.
  let paper: HTMLCanvasElement | null = null
  let pageSize: { w: number; h: number } | null = null
  let detail = null
  if (req.plan && sheet.pdf) {
    const bytes = new Uint8Array(await (await fetch(`/__render/asset/${sheet.pdf.assetId}`)).arrayBuffer())
    if (bytes.length) {
      const base64 = bytesToBase64(bytes)
      registerAsset(sheet.pdf.assetId, base64)
      const clipped = clipToPage(region, sheet.pdf.widthPt, sheet.pdf.heightPt)
      if (clipped) {
        const page = await renderPage(sheet.pdf.assetId, base64, sheet.pdf, scale, clipped)
        detail = { ...clipped, scale, canvas: page.canvas }
        pageSize = { w: page.widthPt, h: page.heightPt }
        paper = newCanvas(1, 1, 'Canvas 2D unavailable')
        const p = paper.getContext('2d')!
        p.fillStyle = '#ffffff'
        p.fillRect(0, 0, 1, 1)
      }
    }
  }

  drawScene({
    ctx, store, cam, width: out.width, height: out.height,
    background: paper, backgroundSize: pageSize, backgroundDetail: detail,
    uiScale: req.uiScale, interactive: false, paper: true,
  })
  for (const id of req.highlight) {
    const item = store.item(id)
    if (item) drawItemOutline(ctx, cam, item, 'rgba(11,99,214,0.55)', 6 * req.uiScale)
  }
  if (req.gridM && sheet.mmPerPoint) drawMetreGrid(ctx, cam, out, sheet.mmPerPoint, req.gridM, req.uiScale)

  const url = out.toDataURL('image/png')
  return url.slice(url.indexOf(',') + 1)
}

function clipToPage(r: RenderRequest['region'], w: number, h: number): RenderRequest['region'] | null {
  const x0 = Math.max(0, Math.floor(r.x))
  const y0 = Math.max(0, Math.floor(r.y))
  const x1 = Math.min(w, Math.ceil(r.x + r.w))
  const y1 = Math.min(h, Math.ceil(r.y + r.h))
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null
}

/**
 * Lines every `stepM` metres, numbered along the top and left edge in the same metres that
 * `items --json` and `apply` speak - so a position read off the picture can go straight into
 * an op.
 */
function drawMetreGrid(
  ctx: CanvasRenderingContext2D, cam: Camera, out: HTMLCanvasElement, mmPerPoint: number, stepM: number, ui: number,
): void {
  const ptPerM = 1000 / mmPerPoint
  const toM = (pt: number): number => (pt * mmPerPoint) / 1000
  const left = toM(cam.x)
  const top = toM(cam.y)
  const right = toM(cam.x + out.width / cam.zoom)
  const bottom = toM(cam.y + out.height / cam.zoom)
  const decimals = stepM < 0.1 ? 2 : stepM < 1 ? 1 : 0
  const label = (m: number): string => m.toFixed(decimals)
  ctx.save()
  ctx.strokeStyle = 'rgba(220,38,38,0.35)'
  ctx.lineWidth = Math.max(1, ui)
  ctx.fillStyle = 'rgba(185,28,28,0.95)'
  ctx.font = `${Math.round(11 * ui)}px system-ui, sans-serif`
  ctx.textBaseline = 'top'
  for (let m = Math.ceil(left / stepM) * stepM; m <= right; m += stepM) {
    const x = Math.round(cam.toScreenX(m * ptPerM)) + 0.5
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, out.height); ctx.stroke()
    ctx.fillText(label(m), x + 3 * ui, 3 * ui)
  }
  for (let m = Math.ceil(top / stepM) * stepM; m <= bottom; m += stepM) {
    const y = Math.round(cam.toScreenY(m * ptPerM)) + 0.5
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(out.width, y); ctx.stroke()
    ctx.fillText(label(m), 3 * ui, y + 3 * ui)
  }
  ctx.restore()
}

window.warrenReady = true
