import type { App } from '../app.ts'
import type { ToolId } from '../interact/editor.ts'
import { zoomBy, zoomToFit } from '../interact/view.ts'
import { exportBundle, newProject, openProject, renameProject, save, saveAs } from '../app/fileOps.ts'
import { detachPdf, exportPlanPdf, importPdf, rotateSheet } from '../app/pdfOps.ts'
import { deleteSheet, renameSheet } from '../app/sheetOps.ts'
import {
  CATEGORY_LABELS, CATEGORIES, LEVELS, LEVEL_LABELS, MARKER_LABELS,
  type Level, type MarkerSymbol, type RoomItem,
} from '../model/types.ts'
import { symbolsFor } from '../model/systems.ts'
import { saveCapabilityNote } from '../io/projectFile.ts'
import { alertDialog } from './modal.ts'
import { clear, el, groupedSelect, select } from './dom.ts'
import { openExportDialog, openGenerateDialog, openPrintDialog } from './outputDialogs.ts'
import { openSystemsEditor } from './systemsEditor.ts'

const TOOLS: { id: ToolId; label: string; key: string; title: string }[] = [
  { id: 'select', label: 'Select', key: 'V', title: 'Select, move, edit corners (V)' },
  { id: 'run', label: 'Run', key: 'L', title: 'Draw a pipe / duct / circuit as one multi-corner run (L)' },
  { id: 'box', label: 'Box', key: 'R', title: 'Equipment box: HRV unit, manifold, distribution board (R)' },
  { id: 'marker', label: 'Marker', key: 'M', title: 'Point marker: riser, drain, penetration (M)' },
  { id: 'note', label: 'Note', key: 'N', title: 'Sticky note, tied to the selected system so it hides with that layer (N)' },
  { id: 'measure', label: 'Measure', key: 'D', title: 'Measure a distance (D)' },
  // Calibrate and Direction live in the Properties tab (Sheet section) instead of here: both
  // are set-once-and-forget, not tools reached for repeatedly, so they do not earn a permanent
  // slot in the bar everything else lives in. `K` and `B` still work as shortcuts.
]

export function buildToolbar(app: App, host: HTMLElement): void {
  const { store, editor } = app
  clear(host)

  host.appendChild(brand(app))
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
  if (!store.project.systems.some((s) => s.id === editor.activeSystemId)) {
    const first = store.project.systems[0]
    if (first) editor.activeSystemId = first.id
  }
  const systemGroups = CATEGORIES.map((c) => ({
    heading: CATEGORY_LABELS[c],
    options: store.project.systems.filter((s) => s.category === c).map((s) => [s.id, s.name] as const),
  }))
  const systemSelect = groupedSelect(systemGroups, editor.activeSystemId, (v) => {
    editor.activeSystemId = v
    app.refresh()
  })
  systemSelect.title = 'System for new items'
  systemSelect.style.maxWidth = '210px'
  host.appendChild(el('label', { class: 'inline', title: 'System for new items' }, 'System', systemSelect))

  const levelSelect = select(LEVELS.map((l) => [l, LEVEL_LABELS[l]] as const), editor.activeLevel, (v) => {
    editor.activeLevel = v as Level
  })
  levelSelect.title = 'Where new items sit in the building fabric'
  host.appendChild(el('label', { class: 'inline', title: 'Where new items sit in the building fabric' }, 'Level', levelSelect))

  if (editor.tool === 'marker') {
    const offered = symbolsFor(store.system(editor.activeSystemId))
    // Picking a lighting group and being offered a gully is noise, so the list follows the
    // system - and the active symbol follows it too rather than staying somewhere absurd.
    if (!offered.includes(editor.activeMarkerSymbol)) editor.activeMarkerSymbol = offered[0]
    host.appendChild(select(offered.map((s) => [s, MARKER_LABELS[s]] as const), editor.activeMarkerSymbol, (v) => {
      editor.activeMarkerSymbol = v as MarkerSymbol
    }))
  }

  host.appendChild(el('div', { class: 'sep' }))
  host.appendChild(el('button', { class: 'icon', title: 'Undo (Ctrl+Z)', disabled: !store.canUndo(), onclick: () => store.undo() }, '↶'))
  host.appendChild(el('button', { class: 'icon', title: 'Redo (Ctrl+Shift+Z)', disabled: !store.canRedo(), onclick: () => store.redo() }, '↷'))

  host.appendChild(el('div', { class: 'sep' }))
  host.appendChild(el('button', { class: 'icon', title: 'Zoom out (-)', onclick: () => zoomBy(editor, 0.8) }, '−'))
  host.appendChild(el('button', { class: 'icon', title: 'Zoom in (+)', onclick: () => zoomBy(editor, 1.25) }, '+'))
  host.appendChild(el('button', { title: 'Fit the sheet (F)', onclick: () => zoomToFit(editor) }, 'Fit'))

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

  for (const [key, label] of [
    ['showLabels', 'Labels'], ['showFlow', 'Flow'], ['showNotes', 'Notes'], ['showGrid', 'Grid'],
  ] as const) {
    host.appendChild(toggle(label, store.project.settings[key], (v) => {
      store.project.settings[key] = v
      store.touch()
      editor.requestRender()
    }))
  }

  // Named "Show" rather than "Level" because the dropdown two along also says Level, and sets a
  // different thing entirely - what you are about to draw, not what you can see.
  const levelFilterTitle = 'Show only one building level'
  const levelFilter = select(
    [['all', 'all levels'] as const, ...LEVELS.map((l) => [l, LEVEL_LABELS[l]] as const)],
    store.project.settings.levelFilter,
    (v) => {
      store.project.settings.levelFilter = v as Level | 'all'
      store.touch()
      editor.requestRender()
    },
  )
  levelFilter.title = levelFilterTitle
  host.appendChild(el('label', { class: 'inline', title: levelFilterTitle }, 'Show', levelFilter))

  // Work on one room. Everything else greys out but stays reachable — hiding it would break
  // the one thing every circuit must do, which is arrive at a panel somewhere else.
  const roomsHere = store.items().filter((i): i is RoomItem => i.kind === 'room')
  if (roomsHere.length) {
    const rooms = [...roomsHere].sort((a, b) => a.name.localeCompare(b.name))
    const roomFocusTitle = 'Work on one room: everything else greys out, but stays selectable and snappable'
    const roomFocus = select(
      [['', 'all rooms'] as const, ...rooms.map((r) => [r.id, r.name] as const)],
      store.project.settings.roomFocus ?? '',
      (v) => {
        store.project.settings.roomFocus = v === '' ? null : v
        store.touch()
        editor.requestRender()
        app.refresh()
      },
    )
    roomFocus.title = roomFocusTitle
    host.appendChild(el('label', { class: 'inline', title: roomFocusTitle }, 'Focus', roomFocus))
  }

  host.appendChild(el('div', { class: 'sep' }))
  host.appendChild(el('button', { title: 'Edit the systems catalogue', onclick: () => openSystemsEditor(app) }, 'Systems…'))
}

// Survives the toolbar being rebuilt mid-edit, which happens on any store change.
let renamingProject = false

function brand(app: App): HTMLElement {
  const { store } = app
  if (renamingProject) {
    const input = el('input', {
      type: 'text',
      value: store.project.name,
      style: { width: '170px' },
    }) as HTMLInputElement
    const commit = (): void => {
      if (!renamingProject) return
      renamingProject = false
      renameProject(app, input.value)
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit() }
      if (e.key === 'Escape') { renamingProject = false; app.refresh() }
    })
    input.addEventListener('blur', commit)
    setTimeout(() => { input.focus(); input.select() }, 0)
    return el('div', { class: 'brand' }, 'Warren', input)
  }
  return el('div', { class: 'brand' },
    'Warren',
    el('small', {
      title: 'Click to rename the project — this also becomes the file name',
      style: { cursor: 'text', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: '3px' },
      onclick: () => { renamingProject = true; app.refresh() },
    }, store.project.name + (store.dirty ? ' •' : '')),
  )
}

export function startProjectRename(app: App): void {
  renamingProject = true
  app.refresh()
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
    const note = saveCapabilityNote()
    menu = el('div', { class: 'menu' },
      entry('New project', '', () => void newProject(app)),
      entry('Open…', 'Ctrl+O', () => void openProject(app)),
      entry('Save', 'Ctrl+S', () => void save(app)),
      entry('Save as…', 'Ctrl+Shift+S', () => void saveAs(app)),
      el('hr'),
      sheet.pdf ? entry('Save plan PDF beside it', '', () => {
        if (!exportPlanPdf(app)) alertDialog('Nothing to write', 'This browser does not have the plan PDF yet.')
      }) : null,
      entry('Export self-contained bundle…', '', () => void exportBundle(app)),
      el('hr'),
      entry('Import PDF page → this sheet', '', () => void importPdf(app, 'current')),
      entry('Import PDF page → new sheet', '', () => void importPdf(app, 'new')),
      sheet.pdf ? entry('Rotate plan 90°', '', () => rotateSheet(app, 90)) : null,
      sheet.pdf ? entry('Remove plan from sheet', '', () => detachPdf(app)) : null,
      el('hr'),
      entry('Generate from rooms…', '', () => openGenerateDialog(app)),
      el('hr'),
      entry('Export PNG…', '', () => openExportDialog(app)),
      entry('Print / PDF…', '', () => openPrintDialog(app)),
      el('hr'),
      entry('Rename project…', '', () => startProjectRename(app)),
      entry('Rename sheet…', '', () => void renameSheet(app, app.store.sheet)),
      entry('Delete sheet…', '', () => void deleteSheet(app, app.store.sheet)),
      note ? el('hr') : null,
      note ? el('div', { class: 'hint', style: { padding: '2px 8px 4px', maxWidth: '250px' } }, note) : null,
    )
    wrap.appendChild(menu)
    document.addEventListener('pointerdown', onOutside, true)
  })

  wrap.appendChild(button)
  return wrap
}
