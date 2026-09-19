import type { Store } from '../model/doc.ts'
import { CATEGORY_LABELS, type Category } from '../model/types.ts'
import { computeTakeoff, systemsInUse } from '../takeoff.ts'
import { formatMetres } from '../units.ts'
import { renderSheetImage } from './exportImage.ts'

export interface PrintOptions {
  scale: number
  categories: Category[] | null
  includeLegend: boolean
  includeTakeoff: boolean
  backgroundOpacity: number
}

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
  const previous = store.project.systems.map((s) => s.visible)
  if (opts.categories) {
    for (const sys of store.project.systems) sys.visible = opts.categories.includes(sys.category)
    store.invalidateSystems()
  }

  // Render before touching any window. pdf.js drives page rendering off requestAnimationFrame,
  // which Chrome stops in a backgrounded page - so opening a popup first and rendering second
  // deadlocks. Same reason we print from a hidden same-origin iframe rather than a new tab:
  // no popup blocker, no backgrounding, no stall.
  let canvas: HTMLCanvasElement
  try {
    canvas = await renderSheetImage(store, {
      scale: opts.scale,
      includeBackground: true,
      backgroundOpacity: opts.backgroundOpacity,
    })
  } finally {
    store.project.systems.forEach((s, i) => { s.visible = previous[i] })
    store.invalidateSystems()
  }

  const sheet = store.sheet
  const usedSystems = systemsInUse(store, 'sheet').filter(
    (s) => !opts.categories || opts.categories.includes(s.category),
  )
  const takeoff = computeTakeoff(store, 'sheet')
  const rows = takeoff.rows.filter((r) => !opts.categories || opts.categories.includes(r.system.category))

  const legendHtml = opts.includeLegend && usedSystems.length
    ? `<section><h2>Legend</h2><table class="legend">${usedSystems.map((s) => `
        <tr><td>${dashSvg(s.color, s.dash, s.width)}</td>
            <td>${escapeHtml(s.name)}${s.tag ? ` <b>${escapeHtml(s.tag)}</b>` : ''}</td>
            <td class="muted">${escapeHtml(s.defaultSize ?? '')}</td></tr>`).join('')}</table></section>`
    : ''

  const takeoffHtml = opts.includeTakeoff && rows.length
    ? `<section><h2>Material takeoff <span class="muted">(plan length + ${takeoff.slackPct}% slack)</span></h2>
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

  const assumedCount = sheet.items.filter((i) => i.kind === 'run' && i.flowAssumed).length
  const assumedNote = assumedCount
    ? `<p class="warn">${assumedCount} run${assumedCount === 1 ? ' has a' : 's have an'} <b>assumed</b> direction, drawn faintly: `
      + 'guessed from the order it was drawn and not confirmed. Do not set out falls from these.</p>'
    : ''

  const categoryNote = opts.categories
    ? `<span class="muted"> · showing ${opts.categories.map((c) => CATEGORY_LABELS[c]).join(', ')}</span>`
    : ''

  const dataUrl = canvas.toDataURL('image/png')
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(store.project.name)} — ${escapeHtml(sheet.name)}</title>
<style>
  @page { size: A3 landscape; margin: 10mm; }
  body { font: 12px/1.45 ui-sans-serif, system-ui, sans-serif; color: #16202e; margin: 0; padding: 4px; }
  h1 { font-size: 16px; margin: 0 0 2px; }
  h2 { font-size: 13px; margin: 14px 0 4px; }
  .meta { color: #5b6675; margin-bottom: 8px; font-size: 11px; }
  .plan { width: 100%; border: 1px solid #d9dde4; break-after: page; }
  table { border-collapse: collapse; font-size: 11px; }
  td, th { padding: 2px 8px 2px 0; vertical-align: middle; text-align: left; }
  th { border-bottom: 1px solid #d9dde4; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .muted { color: #5b6675; font-weight: 400; }
  .warn { color: #b45309; }
  .sheets { display: flex; gap: 40px; align-items: flex-start; flex-wrap: wrap; }
</style></head>
<body>
  <h1>${escapeHtml(store.project.name)} — ${escapeHtml(sheet.name)}</h1>
  <div class="meta">${new Date().toLocaleString()}${categoryNote}${
    sheet.mmPerPoint ? ` · calibrated (1 pt = ${sheet.mmPerPoint.toFixed(3)} mm)` : ' · <span class="warn">not calibrated</span>'
  }</div>
  <img class="plan" src="${dataUrl}" alt="plan">
  ${assumedNote}
  <div class="sheets">${legendHtml}${takeoffHtml}</div>
</body></html>`

  await printHtml(html)
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

    const cleanup = (): void => {
      window.setTimeout(() => frame.remove(), 1000)
    }

    frame.addEventListener('load', () => {
      const win = frame.contentWindow
      if (!win) {
        cleanup()
        reject(new Error('Could not create the print view'))
        return
      }
      const images = [...win.document.images]
      const ready = Promise.all(images.map((img) => (img.complete ? Promise.resolve() : img.decode().catch(() => undefined))))
      void ready.then(() => {
        win.addEventListener('afterprint', cleanup, { once: true })
        try {
          win.focus()
          win.print()
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
