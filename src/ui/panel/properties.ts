import type { App } from '../../app.ts'
import { polygonArea, polylineLength } from '../../geom.ts'
import {
  CATEGORIES, CATEGORY_LABELS, LEVELS, LEVEL_LABELS, MARKER_LABELS, ROOM_USES, ROOM_USE_LABELS, WALL_STATUSES,
  type Item, type Level, type MarkerSymbol, type RoomUse, type WallStatus,
} from '../../model/types.ts'
import { buildGraph, connectionsOf, networkOf, type Contact } from '../../topology.ts'
import { adopt, generatedBy } from '../../generate.ts'
import { symbolsFor } from '../../model/systems.ts'
import { formatMetres } from '../../units.ts'
import { tipBearing } from '../../directions.ts'
import { nameCompassTip, placeCompass, removeCompass, removeDirection, renameDirection, turnCompass } from '../../interact/compass.ts'
import { acrossAxis, alignItems, distributeItems, runAxis, setBoxRotation, type AlignEdge } from '../../interact/arrange.ts'
import { alignedOthers, alignPointNames, startAlign } from '../../app/alignOps.ts'
import { CALIBRATION_TOLERANCE, calibrationAgreement, nudgeAlignment, type Nudge } from '../../align.ts'
import { comboInput, el, field, groupedSelect, numberInput, select, swatch, textInput } from '../dom.ts'

const CONTACT_LABELS: Record<Contact, string> = { 'end-to-end': 'end', tee: 'tee', equipment: 'at' }

/**
 * What is selected comes first: it is what this tab is open for nearly every time. The sheet's
 * setup and the project's directions are set once and then left, so they fold away at the
 * bottom. Only an uncalibrated sheet interrupts, because nothing measures until it is fixed.
 */
export function buildProperties(app: App, body: HTMLElement): void {
  const { store, editor } = app
  if (!store.sheet.mmPerPoint) {
    body.appendChild(el('div', { class: 'hint warn', style: { marginBottom: '8px' } },
      'This sheet is not calibrated: lengths and the takeoff stay empty. ',
      el('button', { onclick: () => editor.setTool('calibrate') }, 'Calibrate…')))
  }
  buildSelection(app, body)
  fold(body, 'sheet', 'Sheet', (inner) => buildSheet(app, inner))
  fold(body, 'directions', 'Directions — every sheet', (inner) => buildOrientation(app, inner))
}

/** Which folds are open, kept across the rebuild every change sets off, and across visits. */
const openFolds: Record<string, boolean> = (() => {
  try { return JSON.parse(localStorage.getItem('warren.panel.folds') ?? '{}') as Record<string, boolean> } catch { return {} }
})()

function fold(body: HTMLElement, key: string, title: string, build: (inner: HTMLElement) => void): void {
  const details = el('details', { class: 'fold' }) as HTMLDetailsElement
  details.open = openFolds[key] ?? false
  // Recorded on the click, not on 'toggle': that event comes a task later, and by then a
  // rebuild may already have replaced this element with one built from the old state.
  details.appendChild(el('summary', {
    class: 'section-title',
    onclick: () => {
      openFolds[key] = !details.open
      try { localStorage.setItem('warren.panel.folds', JSON.stringify(openFolds)) } catch { /* private window */ }
    },
  }, title))
  const inner = el('div', { class: 'fold-body' })
  build(inner)
  details.appendChild(inner)
  body.appendChild(details)
}

/** This sheet's setup: its scale, how it lines up with the other floors, and drawing aids. */
function buildSheet(app: App, body: HTMLElement): void {
  const { store, editor } = app
  const sheet = store.sheet
  body.appendChild(field('Scale', el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
    sheet.mmPerPoint ? el('span', {}, `1 pt = ${sheet.mmPerPoint.toFixed(3)} mm`) : null,
    el('button', { onclick: () => editor.setTool('calibrate') }, sheet.mmPerPoint ? 'Recalibrate…' : 'Calibrate this sheet…'),
  )))
  if (!sheet.mmPerPoint) {
    body.appendChild(el('div', { class: 'hint' },
      'Click Calibrate, then the two ends of a dimension printed on the plan, and type its length.'))
  }

  buildFloorAlignment(app, body)

  body.appendChild(field('Run spacing', el('div', { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
    numberInput(store.project.settings.runSpacingMm, (v) => {
      store.project.settings.runSpacingMm = Math.max(0, v)
      store.touch()
    }), 'mm'),
  'A run drawn alongside another snaps to this gap from it, once you are zoomed in far enough to see it. 0 turns it off.'))

  const lockedOnSheet = store.items().filter((i) => i.locked)
  if (lockedOnSheet.length) {
    body.appendChild(field('Locked', el('button', {
      title: 'Locked items cannot be clicked on the canvas — this is the way back',
      onclick: () => store.mutate(() => { for (const item of store.items()) delete item.locked }),
    }, `Unlock all (${lockedOnSheet.length})`)))
  }

  const flowless = store.items().filter(
    (i) => i.kind === 'run' && i.flow === 'none' && store.system(i.systemId).assumeFlow,
  )
  if (flowless.length) {
    body.appendChild(field('Flow', el('button', {
      title: 'Sets each one along the order it was drawn in, marked as a guess until you confirm it',
      onclick: () => store.mutate(() => {
        for (const item of store.items()) {
          if (item.kind !== 'run' || item.flow !== 'none') continue
          if (!store.system(item.systemId).assumeFlow) continue
          item.flow = 'forward'
          item.flowAssumed = true
        }
      }),
    }, `Assume direction for ${flowless.length} run${flowless.length === 1 ? '' : 's'}`)))
  }
}

/** The selected items: everything they have in common, and what can be done to them. */
function buildSelection(app: App, body: HTMLElement): void {
  const { store, editor } = app
  const items = store.selectedItems()
  const sheet = store.sheet

  if (items.length === 0) {
    body.appendChild(el('div', { class: 'section-title' }, 'Nothing selected'))
    body.appendChild(el('div', { class: 'hint' },
      'Draw a run with L, then click it to select the whole thing — corners and all. ' +
      'Drag a corner handle to fix one corner; Alt+click a segment adds a corner; Alt+click a corner removes it. ' +
      'Start a new run on the loose end of one to carry it on. Ctrl+drag copies whatever you drag.'))
    return
  }

  const first = items[0]
  const many = items.length > 1
  body.appendChild(el('div', { class: 'section-title' }, many ? `${items.length} items selected` : labelForKind(first)))

  const applyToAll = (fn: (item: Item) => void): void => {
    store.mutate(() => {
      for (const id of store.selection) {
        const live = store.item(id)
        if (!live || !store.isEditable(live)) continue
        fn(live)
        adopt(live)
      }
    })
  }
  // What every selected item agrees on for this field, or '' when they disagree - the value a
  // <select> shows as "mixed" by matching none of its options.
  const common = <T,>(value: (i: Item) => T, fallback: T): T => {
    const v = value(first)
    return items.every((i) => value(i) === v) ? v : fallback
  }

  const systemGroups = CATEGORIES.map((c) => ({
    heading: CATEGORY_LABELS[c],
    options: store.project.systems.filter((s) => s.category === c).map((s) => [s.id, s.name] as const),
  }))
  body.appendChild(field('System', groupedSelect(systemGroups, common((i) => i.systemId, ''), (value) => {
    applyToAll((item) => {
      item.systemId = value
      if (item.kind === 'run') {
        const sys = store.system(value)
        if (!item.size && sys.defaultSize) item.size = sys.defaultSize
      }
    })
  })))

  body.appendChild(field('Level', select(
    LEVELS.map((l) => [l, LEVEL_LABELS[l]] as const), common((i) => i.level, ''),
    (v) => applyToAll((item) => { item.level = v as Level }),
  )))

  if (!many && first.kind === 'room') {
    body.appendChild(field('Name', textInput(first.name, (v) => applyToAll((item) => {
      if (item.kind === 'room') item.name = v.trim() || item.name
    }))))
    body.appendChild(field('Used as', select(
      ROOM_USES.map((u) => [u, ROOM_USE_LABELS[u]] as const), first.use,
      (v) => applyToAll((item) => { if (item.kind === 'room') item.use = v as RoomUse }),
    ), 'What a room is for is what lets rules act on it — sockets, switches, detectors.'))
    body.appendChild(field('Plan ref', textInput(first.ref ?? '', (v) => applyToAll((item) => {
      if (item.kind === 'room') item.ref = v.trim() || undefined
    }), 'e.g. 0.04')))
    const mmPerPoint = sheet.mmPerPoint
    if (mmPerPoint) {
      const m2 = Math.abs(polygonArea(first.points)) * (mmPerPoint / 1000) ** 2
      body.appendChild(field('Floor area', el('div', {}, `${m2.toFixed(1)} m²`)))
    }
  } else if (!many && first.kind !== 'note') {
    const labelled = first as Exclude<Item, { kind: 'note' } | { kind: 'room' }>
    body.appendChild(field('Label', textInput(labelled.label ?? '', (v) => applyToAll((item) => {
      if (item.kind !== 'note' && item.kind !== 'room') item.label = v
    }))))
  }

  if (!many && first.kind === 'door') {
    body.appendChild(field('Hinge', el('div', { style: { display: 'flex', gap: '6px' } },
      el('button', {
        onclick: () => applyToAll((item) => { if (item.kind === 'door') item.points = [...item.points].reverse() }),
      }, 'Swap jambs'),
      el('button', {
        onclick: () => applyToAll((item) => { if (item.kind === 'door') item.swing = item.swing === 1 ? -1 : 1 }),
      }, 'Flip swing'),
    ), 'The hinge is the first jamb. A light switch belongs by the other one, not behind the door.'))
  }

  if (!many && first.kind === 'box') {
    const turn = el('input', {
      type: 'number', step: '15', value: String(Number((first.rotationDeg ?? 0).toFixed(1))), style: { width: '70px' },
      title: 'Degrees clockwise. Or drag the round handle above the box; Shift turns it in 15° steps.',
      dataset: { focusKey: 'box-rotation' },
    }) as HTMLInputElement
    turn.addEventListener('change', () => applyToAll((item) => { if (item.kind === 'box') setBoxRotation(item, Number(turn.value) || 0) }))
    body.appendChild(field('Rotation', el('div', { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
      turn, '°',
      el('button', {
        title: 'Turn a quarter clockwise',
        onclick: () => applyToAll((item) => { if (item.kind === 'box') setBoxRotation(item, (item.rotationDeg ?? 0) + 90) }),
      }, '↻ 90°'),
    ), 'Or drag the round handle above the box. Shift turns it in 15° steps.'))
  }

  if (items.every((i) => i.kind === 'wall')) {
    const mmPerPoint = sheet.mmPerPoint
    if (!many && first.kind === 'wall' && mmPerPoint) {
      body.appendChild(field('Thickness', el('div', { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
        numberInput(Math.round(first.thickness * mmPerPoint), (v) => applyToAll((item) => {
          if (item.kind === 'wall' && v > 0) item.thickness = v / mmPerPoint
        })), 'mm'), 'Centred on the line: half each side.'))
    }
    body.appendChild(field('Status', select(
      WALL_STATUSES.map((s) => [s, s === 'new' ? 'New' : 'Existing'] as const),
      common((i) => (i.kind === 'wall' ? i.status : 'existing'), ''),
      (v) => applyToAll((item) => { if (item.kind === 'wall') item.status = v as WallStatus }),
    )))
  }

  if (!many && first.kind === 'window' && sheet.mmPerPoint) {
    const mmPerPoint = sheet.mmPerPoint
    body.appendChild(field('Depth', el('div', { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
      numberInput(Math.round(first.depth * mmPerPoint), (v) => applyToAll((item) => {
        if (item.kind === 'window' && v > 0) item.depth = v / mmPerPoint
      })), 'mm'), 'The frame across the wall. Its width is the distance between the two jambs.'))
  }

  if (first.kind === 'run' && !many) {
    const sys = store.system(first.systemId)
    body.appendChild(field('Size / spec', comboInput(first.size ?? '', sys.sizes ?? [], sys.defaultSize, sys.id, (v) =>
      applyToAll((item) => { if (item.kind === 'run') item.size = v }))))
  }

  if (items.every((i) => i.kind === 'run')) {
    body.appendChild(field('Flow', select(
      [['none', 'No arrows'], ['forward', 'Along the run'], ['reverse', 'Against the run']] as const,
      common((i) => (i.kind === 'run' ? i.flow : 'none'), ''),
      (v) => applyToAll((item) => {
        if (item.kind !== 'run') return
        item.flow = v as 'none' | 'forward' | 'reverse'
        delete item.flowAssumed
      }),
    )))

    if (items.some((i) => i.kind === 'run' && i.flowAssumed)) {
      body.appendChild(el('div', { class: 'hint warn', style: { gridColumn: '1 / -1' } },
        'Direction guessed from the order this was drawn in — about half of those come out backwards. ',
        el('button', {
          style: { marginTop: '4px' },
          onclick: () => applyToAll((item) => { if (item.kind === 'run') delete item.flowAssumed }),
        }, 'It is right'),
        ' ',
        el('button', {
          onclick: () => applyToAll((item) => {
            if (item.kind !== 'run') return
            item.flow = item.flow === 'reverse' ? 'forward' : 'reverse'
            delete item.flowAssumed
          }),
        }, 'Flip it'),
      ))
    }

    if (!many && first.kind === 'run') {
      body.appendChild(field('Fall / slope', textInput(first.slope ?? '', (v) => applyToAll((item) => {
        if (item.kind === 'run') item.slope = v
      }), 'e.g. 1:60')))
      body.appendChild(field('Extra length', numberInput(first.extraM ?? 0, (v) => applyToAll((item) => {
        if (item.kind === 'run') item.extraM = v || undefined
      })), 'Metres to add in the takeoff for drops and slack this run needs beyond the plan length.'))

      const mmPerPoint = sheet.mmPerPoint
      if (mmPerPoint) {
        body.appendChild(field('Plan length', el('div', {}, formatMetres(polylineLength(first.points) * mmPerPoint, 2))))
      }
      body.appendChild(field('Corners', el('div', {}, String(first.points.length))))

      // What this is joined to, derived from where the ends actually land. Stated as fact,
      // not as a complaint - plenty of drawings are half-finished on purpose.
      const graph = buildGraph(sheet)
      const joined = connectionsOf(graph, first.id)
      const network = networkOf(graph, first.id)
      const loose = graph.freeEnds.filter((f) => f.itemId === first.id).length

      // Naming them, not counting them: a run that says "3 items" when you expected 2 is only
      // useful if you can see which three.
      const list = el('div', {})
      if (joined.length === 0) {
        list.appendChild(el('div', { style: { color: 'var(--ink-soft)' } }, 'nothing yet'))
      }
      for (const c of joined) {
        const other = store.item(c.otherId)
        if (!other) continue
        const name = describeItem(store, other)
        list.appendChild(el('div', {
          class: 'joined-row',
          title: `Show ${name}`,
          onclick: () => {
            store.selection.clear()
            store.selection.add(other.id)
            store.activeVertex = null
            editor.zoomToSelection()
            app.refresh()
          },
        },
          el('span', { class: 'how' }, CONTACT_LABELS[c.how]),
          swatch(store.system(other.systemId).color, store.system(other.systemId).dash, store.system(other.systemId).width),
          el('span', { class: 'what' }, name),
        ))
      }
      if (loose > 0) {
        list.appendChild(el('div', { style: { color: 'var(--ink-soft)', marginTop: '2px' } },
          `${loose} loose end${loose === 1 ? '' : 's'}`))
      }
      body.appendChild(field(`Joined to`, list))
      if (network && network.items.length > 1) {
        body.appendChild(field('Network', el('button', {
          onclick: () => {
            store.selection.clear()
            for (const id of network.items) store.selection.add(id)
            store.touch(false)
            editor.zoomToSelection()
            app.refresh()
          },
        }, `Select all ${network.items.length} joined`)))
      }
    }
  }

  if (first.kind === 'note' && !many) {
    const text = el('textarea', {
      value: first.text,
      placeholder: 'Sticky note text…',
      style: { minHeight: '92px' },
    }) as HTMLTextAreaElement
    const commit = (): void => applyToAll((item) => { if (item.kind === 'note') item.text = text.value })
    text.addEventListener('change', commit)
    // Live preview while typing, without pushing an undo step per keystroke.
    text.addEventListener('input', () => {
      const live = store.item(first.id)
      if (live && live.kind === 'note') {
        live.text = text.value
        app.editor.requestRender()
      }
    })
    body.appendChild(field('Text', text))
    // A note placed a moment ago is empty and wants typing into.
    if (first.text === '') setTimeout(() => text.focus(), 0)

    const width = el('input', {
      type: 'number', min: '30', step: '5', value: String(Math.round(first.w)),
    }) as HTMLInputElement
    width.addEventListener('change', () => applyToAll((item) => {
      if (item.kind === 'note') item.w = Math.max(30, Number(width.value) || 90)
    }))
    body.appendChild(field('Width', width, 'Or drag the handle at the bottom-right corner. The height follows the text.'))
  }

  if (first.kind === 'marker' && !many) {
    body.appendChild(field('Symbol', select(
      symbolsFor(store.system(first.systemId), first.symbol).map((s) => [s, MARKER_LABELS[s]] as const),
      first.symbol,
      (v) => applyToAll((item) => { if (item.kind === 'marker') item.symbol = v as MarkerSymbol }),
    )))
  }

  if (!many && first.kind !== 'note') {
    const note = el('textarea', {
      value: first.note ?? '',
      onchange: (e: Event) => applyToAll((item) => {
        if (item.kind !== 'note') item.note = (e.target as HTMLTextAreaElement).value
      }),
    })
    body.appendChild(field('Note', note))
  }

  // Colour override: the escape hatch. Normally the system decides.
  const colorRow = el('div', { class: 'palette' })
  colorRow.appendChild(el('button', {
    title: 'Use the system colour',
    style: { width: 'auto', padding: '0 6px', height: '18px', fontSize: '11px' },
    onclick: () => applyToAll((item) => { item.colorOverride = undefined }),
  }, 'system'))
  for (const swatchColor of ['#2563eb', '#dc2626', '#16a34a', '#ea580c', '#7c3aed', '#0891b2', '#ca8a04', '#171717']) {
    colorRow.appendChild(el('button', {
      style: { background: swatchColor },
      title: swatchColor,
      onclick: () => applyToAll((item) => { item.colorOverride = swatchColor }),
    }))
  }
  body.appendChild(field('Colour', colorRow))

  if (items.some((i) => generatedBy(i))) {
    body.appendChild(el('div', { class: 'hint' },
      'Placed by the ', el('b', {}, generatedBy(first)?.rule ?? 'rules'),
      ' rule, and drawn faintly until you touch it. Move or change it and it becomes yours — '
      + 'regenerating will leave it alone after that.'))
  }

  const actions = el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '10px' } },
    el('button', { onclick: () => editor.zoomToSelection() }, 'Zoom to'),
    el('button', {
      title: 'Locked items stay visible but cannot be clicked, dragged or deleted',
      onclick: () => {
        const lock = !items.every((i) => i.locked)
        store.mutate(() => {
          for (const id of store.selection) {
            const live = store.item(id)
            if (!live) continue
            if (lock) live.locked = true
            else delete live.locked
          }
        })
      },
    }, items.every((i) => i.locked) ? 'Unlock' : 'Lock'),
    el('button', { class: 'danger', onclick: () => editor.deleteSelectionOrVertex() }, 'Delete'),
  )
  body.appendChild(actions)

  buildArrange(app, body)
  buildBetweenFloors(app, body)
}

const ALIGN_BUTTONS: [AlignEdge, string, string][] = [
  ['left', '⇤', 'Align left edges'], ['centre', '↔', 'Align centres, left to right'], ['right', '⇥', 'Align right edges'],
  ['top', '⤒', 'Align top edges'], ['middle', '↕', 'Align middles, top to bottom'], ['bottom', '⤓', 'Align bottom edges'],
]

/** Whether Arrange measures square to the selected runs or to the page; kept for the session. */
let arrangeSquareTo: 'runs' | 'page' = 'runs'

/**
 * Align and distribute, as in Slides or Illustrator - only once there is more than one thing to
 * line up. When the selected runs all run the same way at an angle, it measures along and across
 * them instead of along the page edges, which is what lining up diagonal runs actually needs.
 */
function buildArrange(app: App, body: HTMLElement): void {
  const { store } = app
  const movable = store.selectedItems().filter((i) => store.isEditable(i))
  if (movable.length < 2) return
  const axis = runAxis(movable)
  const turned = axis !== null && Math.abs(axis) > (0.5 * Math.PI) / 180
  const angle = turned && arrangeSquareTo === 'runs' ? axis : 0
  const deg = (angle * 180) / Math.PI
  const run = (fn: (items: Item[]) => void): void => store.mutate(() => fn(store.selectedItems().filter((i) => store.isEditable(i))))
  // The glyphs turn with the frame, so each button shows the direction it will actually act in.
  const glyph = (text: string): HTMLElement =>
    el('span', { style: { display: 'inline-block', transform: angle ? `rotate(${deg}deg)` : '' } }, text)
  const row = el('div', { class: 'arrange' },
    ...ALIGN_BUTTONS.map(([edge, g, title]) => el('button', { title, onclick: () => run((it) => alignItems(it, edge, angle)) }, glyph(g))),
  )
  if (movable.length >= 3) {
    row.appendChild(el('button', {
      title: 'Distribute: equal gaps left to right, the outer two stay put',
      onclick: () => run((it) => distributeItems(it, 'horizontal', angle)),
    }, glyph('⇹'), ' Even'))
    row.appendChild(el('button', {
      title: 'Distribute: equal gaps top to bottom, the outer two stay put',
      onclick: () => run((it) => distributeItems(it, 'vertical', angle)),
    }, glyph('⇳'), ' Even'))
  }
  const spacingMm = store.project.settings.runSpacingMm
  const mmPerPoint = store.sheet.mmPerPoint
  if (axis !== null && spacingMm > 0 && mmPerPoint && movable.filter((i) => i.kind === 'run').length >= 2) {
    // Runs are lines: their gap across is centreline to centreline, which is the clearance.
    const across = acrossAxis(movable, axis)
    row.appendChild(el('button', {
      title: `Space the runs ${spacingMm} mm apart, side by side; the first stays put`,
      onclick: () => run((it) => distributeItems(it, across, axis, spacingMm / mmPerPoint)),
    }, `${spacingMm} mm`))
  }
  const hint = turned
    ? 'Measured along and across the selected runs, not the page — the arrows show which way each button acts.'
    : movable.length < 3 ? 'Select three or more to space them evenly.' : undefined
  body.appendChild(field('Arrange', row, hint))
  if (turned) {
    body.appendChild(field('Square to', select(
      [['runs', `the runs (turned ${Math.round((axis * 180) / Math.PI)}°)`], ['page', 'the page']] as const,
      arrangeSquareTo,
      (v) => { arrangeSquareTo = v as 'runs' | 'page'; app.refresh() },
    )))
  }
}

/**
 * Other sheets are other floors, and a pipe gets there through a riser. That is what this
 * section is for, so it says so in those words, ahead of the plain copy.
 */
function buildBetweenFloors(app: App, body: HTMLElement): void {
  const { store } = app
  const otherSheets = store.project.sheets.filter((s) => s.id !== store.project.activeSheetId)
  const items = store.selectedItems()
  body.appendChild(el('div', { class: 'section-title' }, 'Other floors'))
  if (!otherSheets.length) {
    body.appendChild(el('div', { class: 'hint' },
      'Add a sheet per floor (the + by the sheet tabs) and a run can rise or drop to it from here.'))
    return
  }
  const here = store.sheet
  const options = otherSheets.map((s) => [s.id, s.align && here.align ? s.name : `${s.name} (not aligned)`] as const)
  const sheetPicker = (prompt: string, onPick: (id: string) => void): HTMLSelectElement => {
    const picker: HTMLSelectElement = select([['', prompt] as const, ...options], '', (v) => {
      picker.value = ''
      if (v) onPick(v)
    })
    return picker
  }
  const only = items.length === 1 ? items[0] : null
  if (only && (only.kind === 'run' || only.kind === 'marker')) {
    body.appendChild(field('Riser', el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
      sheetPicker('↑ Rise to…', (id) => app.riseToSheet(id, 'up')),
      sheetPicker('↓ Drop to…', (id) => app.riseToSheet(id, 'down')),
    ), only.kind === 'run'
      ? 'Through the floor at the end of this run (or the end corner you picked): a riser here, its partner at the same spot in the building on the other floor, and you follow it there. Floors in between get one that passes through.'
      : 'A riser at this spot, its partner at the same spot in the building on the other floor, and you follow it there. Floors in between get one that passes through.'))
  }
  body.appendChild(field('Copy', sheetPicker('Copy to sheet…', (id) => app.duplicateSelectionToSheet(id)),
    'Copies land at the same spot in the building - or, until both floors are aligned, at the same page position.'))
}

/** Enough to recognise an item by, in as few words as possible. */
function describeItem(store: App['store'], item: Item): string {
  const sys = store.system(item.systemId).name
  if (item.kind === 'room') return `${item.name} (room)`
  if (item.kind === 'door') return `${item.ref ?? 'door'}`
  if (item.kind === 'wall') return `${item.label || item.ref || `${item.status} wall`} (wall)`
  if (item.kind === 'window') return `${item.label || item.ref || 'window'} (window)`
  const own = item.kind === 'note' ? item.text.slice(0, 24) : (item.label ?? '').trim()
  const size = item.kind === 'run' ? (item.size ?? '').trim() : ''
  const detail = [own, size].filter(Boolean).join(' ')
  return detail ? `${detail} — ${sys}` : `${sys} ${item.kind}`
}

function labelForKind(item: Item): string {
  switch (item.kind) {
    case 'run': return 'Run'
    case 'box': return 'Equipment box'
    case 'marker': return 'Marker'
    case 'note': return 'Note'
    case 'room': return 'Room'
    case 'door': return 'Door'
    case 'wall': return 'Wall'
    case 'window': return 'Window'
  }
}

/**
 * Which way is which: the compass rose and its four tip names, plus any one-off bearing the rose
 * does not cover. One set for the whole project, so it gets its own heading rather than sitting
 * under Sheet. All of it optional - nothing else depends on it.
 */
function buildOrientation(app: App, body: HTMLElement): void {
  const { store, editor } = app
  const rose = store.project.compass

  if (!rose) {
    body.appendChild(field('Compass',
      el('button', { onclick: () => placeCompass(editor) }, 'Place compass rose'),
      'Optional. Drops a rose on the plan — one for all sheets. Drag a tip to turn it, then name each tip here.'))
  } else {
    const turned = el('input', {
      type: 'number', step: '0.5', value: String(Number(rose.rotationDeg.toFixed(1))), style: { width: '70px' },
      title: 'Where tip 1 points, in degrees clockwise from straight up. Or drag tip 1 on the plan.',
      dataset: { focusKey: 'compass-rotation' },
    }) as HTMLInputElement
    turned.addEventListener('change', () => turnCompass(editor, Number(turned.value)))
    body.appendChild(field('Compass', el('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px' } },
      turned, '°',
      el('button', { title: 'Bring the compass rose into view', onclick: () => placeCompass(editor) }, 'Show'),
      el('button', { title: 'Take the compass rose off this sheet (undo brings it back)', onclick: () => removeCompass(editor) }, 'Remove'),
    )))
    for (let tip = 0; tip < 4; tip++) {
      const bearing = tipBearing(rose, tip)
      const input = el('input', {
        type: 'text',
        value: rose.tips[tip],
        placeholder: tip === 0 ? 'e.g. north, straatzijde' : 'comma-separated names',
        dataset: { focusKey: `compass-tip-${tip}` },
      }) as HTMLInputElement
      // Committed after the focus has moved on, so Tab lands in the next tip rather than
      // being lost to the rebuild this change sets off.
      input.addEventListener('change', () => { const v = input.value; setTimeout(() => nameCompassTip(editor, tip, v), 0) })
      body.appendChild(field(`Tip ${tip + 1} · ${Math.round(bearing)}°`, input))
    }
  }

  // Off-axis directions read and edit exactly like a tip: bearing in the label, names in the
  // box. Only the ✕ is extra, because unlike a tip one of these can be gone entirely.
  const others = store.project.directions ?? []
  others.forEach((d, i) => {
    const input = el('input', {
      type: 'text',
      value: d.aliases.join(', ') || d.id,
      placeholder: 'comma-separated names',
      style: { flex: '1', minWidth: '0' },
      dataset: { focusKey: `direction-${i}` },
    }) as HTMLInputElement
    input.addEventListener('change', () => { const v = input.value; setTimeout(() => renameDirection(editor, d.id, v), 0) })
    body.appendChild(field(`${rose ? 'Other' : 'Off-axis'} · ${Math.round(d.bearingDeg)}°`,
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
        input,
        el('button', {
          title: `Remove "${d.id}"`,
          style: { padding: '0 6px', lineHeight: '1.4' },
          onclick: () => removeDirection(editor, d.id),
        }, '✕'),
      )))
  })
  body.appendChild(field(others.length ? '' : (rose ? 'Others' : 'Off-axis'),
    el('button', {
      title: 'A bearing the compass rose does not cover: click two points on the plan, then name it',
      onclick: () => editor.setTool('direction'),
    }, others.length ? 'Add another…' : 'Add an off-axis direction…')))
}

/**
 * Lining this floor up with the others: two clicks at spots every floor shares. Then the other
 * floor can be shown underneath, which is both the proof that it worked and the reason to do it.
 */
function buildFloorAlignment(app: App, body: HTMLElement): void {
  const { store, editor } = app
  const sheet = store.sheet
  if (store.project.sheets.length < 2) return
  const [a, b] = alignPointNames(app)
  const others = alignedOthers(app)
  body.appendChild(field('Floors', el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
    sheet.align ? el('span', {}, `aligned on ${a} and ${b}`) : null,
    el('button', { onclick: () => startAlign(app) }, sheet.align ? 'Realign…' : 'Align with other floors…'),
  ), sheet.align ? undefined
    : 'Click two spots every floor shares - grid-line crossings are ideal. Risers and copies then land in the same place in the building on every floor.'))

  if (sheet.align && others.length) {
    const picker = select(
      [['', 'nothing'] as const, ...others.map((s) => [s.id, s.name] as const)],
      editor.ghostSheetId && others.some((s) => s.id === editor.ghostSheetId) ? editor.ghostSheetId : '',
      (v) => { editor.ghostSheetId = v || null; editor.requestRender() },
    )
    body.appendChild(field('Underneath', picker, 'Another floor, drawn faintly through the alignment - walls landing on walls means it is right.'))
    if (editor.ghostSheetId && others.some((s) => s.id === editor.ghostSheetId)) buildNudgePad(app, body)
    const off = others.map((o) => ({ o, agree: calibrationAgreement(sheet, o) }))
      .find((x) => x.agree && x.agree.off > CALIBRATION_TOLERANCE)
    if (off) {
      body.appendChild(el('div', { class: 'hint warn' },
        `This floor's scale and ${off.o.name}'s disagree by ${(off.agree!.off * 100).toFixed(1)}% about the distance from ${a} to ${b}. ` +
        'One of the two calibrations is off - Realign to choose which one to trust.'))
    }
  }
}

/** Fine or coarse, kept for the session. Steps are in screen pixels, so they mean the same at any zoom. */
let nudgeCoarse = false
const NUDGE_STEP = {
  fine: { px: 1, deg: 0.02, pct: 0.02 },
  coarse: { px: 10, deg: 0.2, pct: 0.2 },
}

/**
 * Lining the floor underneath up by eye: shift it, turn it, size it, a step at a time, watching
 * walls land on walls. Two clicked spots get it close; this gets it exact. Each step moves this
 * sheet's reference pair, which is all the see-through floor is placed by. Holding a button
 * repeats it, and one hold is one undo step.
 */
function buildNudgePad(app: App, body: HTMLElement): void {
  const { store, editor } = app
  const sheet = store.sheet
  const step = (): typeof NUDGE_STEP.fine => (nudgeCoarse ? NUDGE_STEP.coarse : NUDGE_STEP.fine)
  // Turning and sizing go about the middle of the screen: put a spot that already matches there.
  const pivot = (): { x: number; y: number } => ({
    x: editor.cam.x + editor.cssWidth / 2 / editor.cam.zoom,
    y: editor.cam.y + editor.cssHeight / 2 / editor.cam.zoom,
  })
  const apply = (n: Omit<Nudge, 'pivot'>): void => {
    if (!sheet.align) return
    sheet.align = nudgeAlignment(sheet.align, { ...n, pivot: pivot() })
    editor.requestRender()
  }
  const pad = (label: string, title: string, nudge: () => Omit<Nudge, 'pivot'>): HTMLElement => {
    let timer: number | null = null
    const stop = (): void => {
      if (timer === null) return
      clearTimeout(timer)
      timer = null
      // One hold, one undo step; the commit is also what saves it and redraws the panel.
      store.commit()
    }
    const button = el('button', { title, class: 'nudge' }, label)
    button.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      store.begin()
      apply(nudge())
      const repeat = (delay: number): void => {
        timer = window.setTimeout(() => { apply(nudge()); repeat(60) }, delay)
      }
      repeat(350)
    })
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel'] as const) button.addEventListener(ev, stop)
    return button
  }
  const move = (dx: number, dy: number) => () => {
    const d = step().px / editor.cam.zoom
    return { dx: dx * d, dy: dy * d }
  }
  const turn = (sign: number) => () => ({ turnDeg: sign * step().deg })
  const size = (sign: number) => () => ({ factor: 1 + (sign * step().pct) / 100 })

  const grid = el('div', { class: 'nudge-pad' },
    pad('↺', 'Turn it anticlockwise, about the middle of the screen', turn(-1)),
    pad('↑', 'Move it up', move(0, -1)),
    pad('↻', 'Turn it clockwise, about the middle of the screen', turn(1)),
    pad('←', 'Move it left', move(-1, 0)),
    el('button', {
      class: `nudge${nudgeCoarse ? ' active' : ''}`,
      title: nudgeCoarse ? 'Coarse steps: 10 px, 0.2°, 0.2% - click for fine' : 'Fine steps: 1 px, 0.02°, 0.02% - click for coarse',
      onclick: () => { nudgeCoarse = !nudgeCoarse; app.refresh() },
    }, nudgeCoarse ? '×10' : '×1'),
    pad('→', 'Move it right', move(1, 0)),
    pad('−', 'Make it smaller, about the middle of the screen', size(-1)),
    pad('↓', 'Move it down', move(0, 1)),
    pad('+', 'Make it bigger, about the middle of the screen', size(1)),
  )
  body.appendChild(field('By eye', grid,
    'Shifts, turns and sizes the floor underneath until walls land on walls. ' +
    'Turning and sizing go about the middle of the screen, so put a spot that already lines up there. ' +
    'Hold a button to keep going; the middle one switches fine and coarse steps.'))
}
