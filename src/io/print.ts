import type { Store } from '../model/doc.ts'
import { CATEGORY_LABELS, type Category, type Sheet } from '../model/types.ts'
import { computeTakeoff, systemsInUse } from '../takeoff.ts'
import { formatMetres } from '../units.ts'
import { renderSheetSvg } from './exportImage.ts'

export type Paper = 'A3' | 'A4'

export interface PrintOptions {
  scale: number
  categories: Category[] | null
  includeLegend: boolean
  includeTakeoff: boolean
  backgroundOpacity: number
  /** Every sheet, one to a page, or just the one on screen. */
  sheets: 'all' | 'current'
  paper: Paper
}

/** Paper in millimetres, short side first. */
const PAPER_MM: Record<Paper, [number, number]> = { A3: [297, 420], A4: [210, 297] }
const MARGIN_MM = 10

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)
}

/** A takeoff length, or an em-dash for nothing to show - never "0 m". */
const fmtLen = (mm: number): string => (mm ? formatMetres(mm) : '—')

function dashSvg(color: string, dash: number[], width: number): string {
  const d = dash.length ? dash.map((n) => Math.max(1, n * 0.8)).join(' ') : ''
  return `<svg width="42" height="12" viewBox="0 0 42 12">
    <line x1="1" y1="6" x2="41" y2="6" stroke="${color}" stroke-width="${Math.max(1.2, Math.min(4, width))}"
      stroke-linecap="round" ${d ? `stroke-dasharray="${d}"` : ''}/></svg>`
}

/**
 * A print is the artifact an installer actually holds, so it carries the legend and the
 * takeoff with it. Filtering by category is what makes "here is the sheet for the
 * electrician" a one-click thing.
 */
export async function openPrintView(store: Store, opts: PrintOptions): Promise<void> {
  await printHtml(await printDocument(store, opts))
}

/** The print view as a document: one page per floor, then the legend and takeoff. */
export async function printDocument(store: Store, opts: PrintOptions): Promise<string> {
  const previous = store.project.systems.map((s) => s.visible)
  const active = store.project.activeSheetId
  const sheets = opts.sheets === 'all' ? store.project.sheets : [store.sheet]
  if (opts.categories) {
    for (const sys of store.project.systems) sys.visible = opts.categories.includes(sys.category)
    store.invalidateSystems()
  }

  // Render before touching any window. pdf.js drives page rendering off requestAnimationFrame,
  // which Chrome stops in a backgrounded page - so opening a popup first and rendering second
  // deadlocks. Same reason we print from a hidden same-origin iframe rather than a new tab:
  // no popup blocker, no backgrounding, no stall.
  const pages: { sheet: Sheet; svg: string; portrait: boolean }[] = []
  try {
    for (const sheet of sheets) {
      // The renderer draws the active sheet; switch quietly, without the selection reset and
      // redraw a person switching tabs gets, and switch back below whatever happens.
      store.project.activeSheetId = sheet.id
      // Vectors, not a picture of them: the labels on a busy plan are only readable when the
      // PDF can be zoomed into, and a PNG turns to blocks first.
      const { svg, width, height } = await renderSheetSvg(store, {
        scale: opts.scale,
        includeBackground: true,
        backgroundOpacity: opts.backgroundOpacity,
      })
      pages.push({ sheet, svg, portrait: height > width })
    }
  } finally {
    store.project.activeSheetId = active
    store.project.systems.forEach((s, i) => { s.visible = previous[i] })
    store.invalidateSystems()
  }

  const scope = opts.sheets === 'all' ? 'project' : 'sheet'
  const usedSystems = systemsInUse(store, scope).filter(
    (s) => !opts.categories || opts.categories.includes(s.category),
  )
  const takeoff = computeTakeoff(store, scope)
  const rows = takeoff.rows.filter((r) => !opts.categories || opts.categories.includes(r.system.category))

  const legendHtml = opts.includeLegend && usedSystems.length
    ? `<section><h2>Legend</h2><table class="legend">${usedSystems.map((s) => `
        <tr><td>${dashSvg(s.color, s.dash, s.width)}</td>
            <td>${escapeHtml(s.name)}${s.tag ? ` <b>${escapeHtml(s.tag)}</b>` : ''}</td>
            <td class="muted">${escapeHtml(s.defaultSize ?? '')}</td></tr>`).join('')}</table></section>`
    : ''

  const takeoffHtml = opts.includeTakeoff && rows.length
    ? `<section><h2>Material takeoff <span class="muted">(${pages.length > 1 ? 'all sheets, ' : ''}plan length + ${takeoff.slackPct}% slack)</span></h2>
       <table class="takeoff">
         <tr><th>System</th><th class="num">Runs</th><th class="num">Plan length</th><th class="num">Order</th><th class="num">Items</th></tr>
         ${rows.map((r) => `<tr>
            <td>${dashSvg(r.system.color, r.system.dash, r.system.width)} ${escapeHtml(r.system.name)}</td>
            <td class="num">${r.runs}</td>
            <td class="num">${fmtLen(r.lengthMm)}</td>
            <td class="num"><b>${fmtLen(r.orderMm)}</b></td>
            <td class="num">${r.boxes + r.markers || ''}</td></tr>${
              r.bySize.length > 1
                ? r.bySize.map((t) => `<tr class="muted"><td style="padding-left:52px">${escapeHtml(t.size)}</td>
                    <td class="num">${t.runs}</td>
                    <td class="num">${fmtLen(t.lengthMm)}</td>
                    <td class="num">${fmtLen(t.orderMm)}</td><td></td></tr>`).join('')
                : ''
            }`).join('')}
       </table>
       ${takeoff.uncalibrated.length ? `<p class="warn">Not calibrated: ${takeoff.uncalibrated.map(escapeHtml).join(', ')} — lengths unavailable.</p>` : ''}
       </section>`
    : ''

  const categoryNote = opts.categories
    ? `<span class="muted"> · showing ${opts.categories.map((c) => CATEGORY_LABELS[c]).join(', ')}</span>`
    : ''
  const when = new Date().toLocaleString()

  // One floor to a page, turned whichever way the plan is, and shrunk to fit inside it: a
  // plan that runs off the bottom onto a second sheet of paper is no use to anybody holding it.
  const [short, long] = PAPER_MM[opts.paper]
  const pageHtml = pages.map(({ sheet, svg, portrait }) => {
    const assumed = sheet.items.filter((i) => i.kind === 'run' && i.flowAssumed).length
    const assumedNote = assumed
      ? `<p class="warn">${assumed} run${assumed === 1 ? ' has an' : 's have an'} <b>assumed</b> direction, drawn faintly: `
        + 'guessed from the order it was drawn and not confirmed. Do not set out falls from these.</p>'
      : ''
    return `<section class="page ${portrait ? 'portrait' : 'landscape'}">
      <h1>${escapeHtml(store.project.name)} — ${escapeHtml(sheet.name)}</h1>
      <div class="meta">${when}${categoryNote}${
        sheet.mmPerPoint ? ` · calibrated (1 pt = ${sheet.mmPerPoint.toFixed(3)} mm)` : ' · <span class="warn">not calibrated</span>'
      }</div>
      <div class="plan" role="img" aria-label="${escapeHtml(sheet.name)}">${svg}</div>
      ${assumedNote}
    </section>`
  }).join('')
  const extras = legendHtml || takeoffHtml ? `<section class="page landscape extras"><div class="sheets">${legendHtml}${takeoffHtml}</div></section>` : ''

  const title = pages.length === 1 ? `${store.project.name} — ${pages[0].sheet.name}` : store.project.name
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  @page { size: ${opts.paper} landscape; margin: ${MARGIN_MM}mm; }
  @page portrait { size: ${opts.paper} portrait; margin: ${MARGIN_MM}mm; }
  html, body { margin: 0; padding: 0; }
  body { font: 12px/1.45 ui-sans-serif, system-ui, sans-serif; color: #16202e; }
  .page { display: flex; flex-direction: column; overflow: hidden; break-after: page; }
  .page:last-child { break-after: auto; }
  /* The printable height of the page, a little under so rounding never spills a sliver over. */
  .page.landscape { height: ${short - 2 * MARGIN_MM - 3}mm; }
  .page.portrait { page: portrait; height: ${long - 2 * MARGIN_MM - 3}mm; }
  .page.extras { height: auto; }
  h1 { font-size: 16px; margin: 0 0 2px; }
  h2 { font-size: 13px; margin: 14px 0 4px; }
  .meta { color: #5b6675; margin-bottom: 6px; font-size: 11px; }
  .plan { flex: 1 1 auto; min-height: 0; width: 100%; }
  /* Shrunk to fit, centred, against the top - what object-fit did for the picture it used to be. */
  .plan svg { display: block; width: 100%; height: 100%; }
  .page p { margin: 4px 0 0; }
  table { border-collapse: collapse; font-size: 11px; }
  td, th { padding: 2px 8px 2px 0; vertical-align: middle; text-align: left; }
  th { border-bottom: 1px solid #d9dde4; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .muted { color: #5b6675; font-weight: 400; }
  .warn { color: #b45309; }
  .sheets { display: flex; gap: 40px; align-items: flex-start; flex-wrap: wrap; }
</style></head>
<body>${pageHtml}${extras}</body></html>`
  return html
}

/** Writes a document into an off-screen same-origin iframe and prints just that. */
function printHtml(html: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe')
    frame.setAttribute('aria-hidden', 'true')
    Object.assign(frame.style, {
      position: 'fixed', right: '0', bottom: '0', width: '1px', height: '1px',
      opacity: '0', border: '0', pointerEvents: 'none',
    })
    document.body.appendChild(frame)

    // The frame took the keyboard to print; give it back, or every shortcut in the app goes to
    // an invisible document until somebody happens to click the drawing.
    let done = false
    const cleanup = (): void => {
      if (done) return
      done = true
      frame.blur()
      window.focus()
      window.setTimeout(() => frame.remove(), 1000)
    }

    frame.addEventListener('load', () => {
      const win = frame.contentWindow
      if (!win) {
        cleanup()
        reject(new Error('Could not create the print view'))
        return
      }
      // The plan underneath is an <image> inside the drawing's SVG, which document.images does
      // not list: decode those too, or the first print can come out with no plan under it.
      const images = [...win.document.images]
      const inSvg = [...win.document.querySelectorAll('svg image')].map((el) => {
        const img = win.document.createElement('img')
        img.src = el.getAttribute('href') ?? ''
        return img
      })
      const ready = Promise.all([...images, ...inSvg].map((img) => (img.complete ? Promise.resolve() : img.decode().catch(() => undefined))))
      void ready.then(() => {
        win.addEventListener('afterprint', cleanup, { once: true })
        try {
          win.focus()
          // Blocks until the print dialog closes, so by the next line the printing is done.
          win.print()
          cleanup()
        } catch (err) {
          cleanup()
          reject(err instanceof Error ? err : new Error(String(err)))
          return
        }
        // Some browsers never fire afterprint; sweep up regardless.
        window.setTimeout(cleanup, 60_000)
        resolve()
      })
    }, { once: true })

    frame.srcdoc = html
  })
}
