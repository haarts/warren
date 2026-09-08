import type { App } from '../app.ts'
import { canvasToBlob, downloadBlob, renderSheetImage } from '../io/exportImage.ts'
import { openPrintView } from '../io/print.ts'
import { CATEGORIES, CATEGORY_LABELS, type Category } from '../model/types.ts'
import { el } from './dom.ts'
import { alertDialog, openModal } from './modal.ts'

const SCALES: { value: number; label: string }[] = [
  { value: 2, label: '2× (≈144 dpi) — screen' },
  { value: 3, label: '3× (≈216 dpi)' },
  { value: 4, label: '4× (≈288 dpi) — print' },
  { value: 6, label: '6× (≈432 dpi) — large format' },
]

function scaleSelect(initial = 4): HTMLSelectElement {
  const select = el('select', {}) as HTMLSelectElement
  for (const s of SCALES) select.appendChild(el('option', { value: String(s.value), selected: s.value === initial }, s.label))
  return select
}

function checkbox(label: string, checked: boolean): { row: HTMLElement; input: HTMLInputElement } {
  const input = el('input', { type: 'checkbox', checked }) as HTMLInputElement
  return { row: el('label', { class: 'inline', style: { display: 'flex', margin: '3px 0' } }, input, label), input }
}

export function openExportDialog(app: App): void {
  openModal((close) => {
    const scale = scaleSelect(4)
    const bg = checkbox('Include the architect plan underneath', true)
    const strong = checkbox('Print the plan at full strength (ignore the on-screen fade)', true)

    const run = async (): Promise<void> => {
      close()
      try {
        const canvas = await renderSheetImage(app.store, {
          scale: Number(scale.value),
          includeBackground: bg.input.checked,
          backgroundOpacity: strong.input.checked ? 1 : undefined,
        })
        const blob = await canvasToBlob(canvas)
        const name = `${app.store.project.name}-${app.store.sheet.name}.png`.replace(/[^\w\-. ]+/g, '_')
        downloadBlob(name, blob)
        app.editor.onStatus?.(`Exported ${canvas.width}×${canvas.height} px`)
      } catch (err) {
        alertDialog('Export failed', String(err instanceof Error ? err.message : err))
      }
    }

    return {
      title: `Export "${app.store.sheet.name}" as PNG`,
      width: '460px',
      body: el('div', {},
        el('div', { class: 'field' }, el('label', {}, 'Resolution'), scale),
        bg.row, strong.row,
        el('div', { class: 'hint' }, 'Only visible layers are exported — hide what the recipient does not need first.'),
      ),
      footer: el('div', { style: { display: 'flex', gap: '8px' } },
        el('button', { onclick: close }, 'Cancel'),
        el('button', { class: 'primary', onclick: () => void run() }, 'Export'),
      ),
    }
  })
}

export function openPrintDialog(app: App): void {
  openModal((close) => {
    const scale = scaleSelect(4)
    const legend = checkbox('Legend (only the systems actually drawn)', true)
    const takeoff = checkbox('Material takeoff table', true)
    const strong = checkbox('Plan at full strength', true)

    const boxes = new Map<Category, HTMLInputElement>()
    const catList = el('div', { style: { margin: '4px 0 8px' } })
    for (const category of CATEGORIES) {
      const has = app.store.project.systems.some(
        (s) => s.category === category && app.store.sheet.items.some((i) => i.systemId === s.id),
      )
      const cb = checkbox(CATEGORY_LABELS[category] + (has ? '' : ' (nothing drawn)'), true)
      boxes.set(category, cb.input)
      catList.appendChild(cb.row)
    }

    const run = async (): Promise<void> => {
      const chosen = CATEGORIES.filter((c) => boxes.get(c)?.checked)
      close()
      try {
        await openPrintView(app.store, {
          scale: Number(scale.value),
          categories: chosen.length === CATEGORIES.length ? null : chosen,
          includeLegend: legend.input.checked,
          includeTakeoff: takeoff.input.checked,
          backgroundOpacity: strong.input.checked ? 1 : app.store.project.settings.backgroundOpacity,
        })
      } catch (err) {
        alertDialog('Could not open the print view', String(err instanceof Error ? err.message : err))
      }
    }

    return {
      title: 'Print / save as PDF',
      width: '520px',
      body: el('div', {},
        el('div', { class: 'hint' },
          'Untick disciplines to produce a sheet for one trade — the electrician does not need your drain falls.'),
        catList,
        el('div', { class: 'field' }, el('label', {}, 'Resolution'), scale),
        legend.row, takeoff.row, strong.row,
        el('div', { class: 'hint' },
          'Renders the sheet, then opens your browser print dialog — choose "Save as PDF" there. A3 landscape suits most plans.'),
      ),
      footer: el('div', { style: { display: 'flex', gap: '8px' } },
        el('button', { onclick: close }, 'Cancel'),
        el('button', { class: 'primary', onclick: () => void run() }, 'Print'),
      ),
    }
  })
}
