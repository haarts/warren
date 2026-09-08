import type { App } from '../app.ts'
import type { ToolId } from '../interact/controller.ts'
import {
  CATEGORY_LABELS, CATEGORIES, LEVELS, LEVEL_LABELS, MARKER_LABELS, MARKER_SYMBOLS,
  type Level, type MarkerSymbol,
} from '../model/types.ts'
import { clear, el } from './dom.ts'
import { openExportDialog, openPrintDialog } from './outputDialogs.ts'
import { openSystemsEditor } from './systemsEditor.ts'

const TOOLS: { id: ToolId; label: string; key: string; title: string }[] = [
  { id: 'select', label: 'Select', key: 'V', title: 'Select, move, edit corners (V)' },
  { id: 'run', label: 'Run', key: 'L', title: 'Draw a pipe / duct / circuit as one multi-corner run (L)' },
  { id: 'box', label: 'Box', key: 'R', title: 'Equipment box: HRV unit, manifold, distribution board (R)' },
  { id: 'marker', label: 'Marker', key: 'M', title: 'Point marker: riser, drain, penetration (M)' },
  { id: 'measure', label: 'Measure', key: 'D', title: 'Measure a distance (D)' },
  { id: 'calibrate', label: 'Calibrate', key: 'K', title: 'Set the sheet scale from a known dimension (K)' },
]

export function buildToolbar(app: App, host: HTMLElement): void {
  const { store, editor } = app
  clear(host)

  host.appendChild(el('div', { class: 'brand' }, 'Ductwork', el('small', {}, store.project.name + (store.dirty ? ' •' : ''))))
  host.appendChild(fileMenu(app))
  host.appendChild(el('div', { class: 'sep' }))

  for (const tool of TOOLS) {
    host.appendChild(el('button', {
      class: editor.tool === tool.id ? 'active' : '',
      title: tool.title,
      onclick: () => editor.setTool(tool.id),
    }, tool.label))
  }

  host.appendChild(el('div', { class: 'sep' }))

  // System picker - the thing that decides colour, dash, width and default size.
  const systemSelect = el('select', {
    title: 'System for new items',
    style: { maxWidth: '210px' },
    onchange: (e: Event) => { editor.activeSystemId = (e.target as HTMLSelectElement).value },
  }) as HTMLSelectElement
  for (const category of CATEGORIES) {
    const systems = store.project.systems.filter((s) => s.category === category)
    if (systems.length === 0) continue
    const group = el('optgroup', { label: CATEGORY_LABELS[category] })
    for (const sys of systems) {
      group.appendChild(el('option', { value: sys.id, selected: sys.id === editor.activeSystemId }, sys.name))
    }
    systemSelect.appendChild(group)
  }
  if (!store.project.systems.some((s) => s.id === editor.activeSystemId)) {
    const first = store.project.systems[0]
    if (first) {
      editor.activeSystemId = first.id
      systemSelect.value = first.id
    }
  }
  host.appendChild(systemSelect)

  const levelSelect = el('select', {
    title: 'Where this sits in the building fabric',
    onchange: (e: Event) => { editor.activeLevel = (e.target as HTMLSelectElement).value as Level },
  }) as HTMLSelectElement
  for (const level of LEVELS) {
    levelSelect.appendChild(el('option', { value: level, selected: level === editor.activeLevel }, LEVEL_LABELS[level]))
  }
  host.appendChild(levelSelect)

  if (editor.tool === 'marker') {
    const symbolSelect = el('select', {
      onchange: (e: Event) => { editor.activeMarkerSymbol = (e.target as HTMLSelectElement).value as MarkerSymbol },
    }) as HTMLSelectElement
    for (const symbol of MARKER_SYMBOLS) {
      symbolSelect.appendChild(el('option', { value: symbol, selected: symbol === editor.activeMarkerSymbol }, MARKER_LABELS[symbol]))
    }
    host.appendChild(symbolSelect)
  }

  host.appendChild(el('div', { class: 'sep' }))
  host.appendChild(el('button', { class: 'icon', title: 'Undo (Ctrl+Z)', disabled: !store.canUndo(), onclick: () => store.undo() }, '↶'))
  host.appendChild(el('button', { class: 'icon', title: 'Redo (Ctrl+Shift+Z)', disabled: !store.canRedo(), onclick: () => store.redo() }, '↷'))

  host.appendChild(el('div', { class: 'sep' }))
  host.appendChild(el('button', { class: 'icon', title: 'Zoom out (-)', onclick: () => editor.zoomBy(0.8) }, '−'))
  host.appendChild(el('button', { class: 'icon', title: 'Zoom in (+)', onclick: () => editor.zoomBy(1.25) }, '+'))
  host.appendChild(el('button', { title: 'Fit the sheet (F)', onclick: () => editor.zoomToFit() }, 'Fit'))

  const opacity = el('input', {
    type: 'range', min: '0', max: '1', step: '0.05',
    value: String(store.project.settings.backgroundOpacity),
    title: 'Plan background strength',
    oninput: (e: Event) => {
      store.project.settings.backgroundOpacity = Number((e.target as HTMLInputElement).value)
      store.dirty = true
      editor.requestRender()
    },
  })
  host.appendChild(el('label', { class: 'inline', title: 'Plan background strength' }, 'Plan', opacity))

  host.appendChild(toggle('Labels', store.project.settings.showLabels, (v) => {
    store.project.settings.showLabels = v
    store.touch()
    editor.requestRender()
  }))
  host.appendChild(toggle('Flow', store.project.settings.showFlow, (v) => {
    store.project.settings.showFlow = v
    store.touch()
    editor.requestRender()
  }))
  host.appendChild(toggle('Grid', store.project.settings.showGrid, (v) => {
    store.project.settings.showGrid = v
    store.touch()
    editor.requestRender()
  }))

  const levelFilter = el('select', {
    title: 'Show only one building level',
    onchange: (e: Event) => {
      store.project.settings.levelFilter = (e.target as HTMLSelectElement).value as Level | 'all'
      store.touch()
      editor.requestRender()
    },
  }) as HTMLSelectElement
  levelFilter.appendChild(el('option', { value: 'all', selected: store.project.settings.levelFilter === 'all' }, 'All levels'))
  for (const level of LEVELS) {
    levelFilter.appendChild(el('option', {
      value: level, selected: store.project.settings.levelFilter === level,
    }, `Only: ${LEVEL_LABELS[level]}`))
  }
  host.appendChild(levelFilter)

  host.appendChild(el('div', { class: 'sep' }))
  host.appendChild(el('button', { title: 'Edit the systems catalogue', onclick: () => openSystemsEditor(app) }, 'Systems…'))
}

function toggle(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  return el('button', {
    class: value ? 'active' : '',
    onclick: () => onChange(!value),
    title: `${value ? 'Hide' : 'Show'} ${label.toLowerCase()}`,
  }, label)
}

function fileMenu(app: App): HTMLElement {
  const wrap = el('div', { class: 'menu-wrap' })
  const button = el('button', {}, 'File ▾')
  let menu: HTMLElement | null = null

  const close = (): void => {
    menu?.remove()
    menu = null
    document.removeEventListener('pointerdown', onOutside, true)
  }
  const onOutside = (e: PointerEvent): void => {
    if (!wrap.contains(e.target as Node)) close()
  }
  const entry = (label: string, key: string, action: () => void): HTMLElement =>
    el('button', {
      onclick: () => { close(); action() },
    }, el('span', {}, label), el('kbd', {}, key))

  button.addEventListener('click', () => {
    if (menu) { close(); return }
    const sheet = app.store.sheet
    menu = el('div', { class: 'menu' },
      entry('New project', '', () => void app.newProject()),
      entry('Open…', 'Ctrl+O', () => void app.openProject()),
      entry('Save', 'Ctrl+S', () => void app.save()),
      entry('Save as…', 'Ctrl+Shift+S', () => void app.saveAs()),
      el('hr'),
      entry('Import PDF page → this sheet', '', () => void app.importPdf('current')),
      entry('Import PDF page → new sheet', '', () => void app.importPdf('new')),
      sheet.pdf ? entry('Rotate plan 90°', '', () => app.rotateSheet(90)) : null,
      sheet.pdf ? entry('Remove plan from sheet', '', () => app.detachPdf()) : null,
      el('hr'),
      entry('Export PNG…', '', () => openExportDialog(app)),
      entry('Print / PDF…', '', () => openPrintDialog(app)),
      el('hr'),
      entry('Rename sheet…', '', () => void app.renameSheet(app.store.sheet)),
      entry('Delete sheet…', '', () => void app.deleteSheet(app.store.sheet)),
    )
    wrap.appendChild(menu)
    document.addEventListener('pointerdown', onOutside, true)
  })

  wrap.appendChild(button)
  return wrap
}
