import type { App } from '../../app.ts'
import { polygonArea } from '../../geom.ts'
import {
  CATEGORIES, CATEGORY_LABELS, LEVELS, LEVEL_LABELS, MARKER_LABELS, ROOM_USES, ROOM_USE_LABELS,
  type Item, type Level, type MarkerSymbol, type RoomUse,
} from '../../model/types.ts'
import { buildGraph, connectionsOf, networkOf, type Contact } from '../../topology.ts'
import { adopt, generatedBy } from '../../generate.ts'
import { symbolsFor } from '../../model/systems.ts'
import { formatMetres } from '../../units.ts'
import { tipBearing } from '../../directions.ts'
import { comboInput, el, field, groupedSelect, numberInput, select, swatch, textInput } from '../dom.ts'

const CONTACT_LABELS: Record<Contact, string> = { 'end-to-end': 'end', tee: 'tee', equipment: 'at' }

export function buildProperties(app: App, body: HTMLElement): void {
  const { store, editor } = app
  const items = store.selectedItems()

  body.appendChild(el('div', { class: 'section-title' }, 'Sheet'))
  const sheet = store.sheet
  body.appendChild(field('Scale', el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
    sheet.mmPerPoint ? el('span', {}, `1 pt = ${sheet.mmPerPoint.toFixed(3)} mm`) : null,
    el('button', { onclick: () => editor.setTool('calibrate') }, sheet.mmPerPoint ? 'Recalibrate…' : 'Calibrate this sheet…'),
  )))
  if (!sheet.mmPerPoint) {
    body.appendChild(el('div', { class: 'hint warn' },
      'Uncalibrated: lengths and the takeoff stay empty. Click Calibrate, then click the two ends of a dimension printed on the plan.'))
  }

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

  buildOrientation(app, body)

  if (items.length === 0) {
    body.appendChild(el('div', { class: 'section-title' }, 'Nothing selected'))
    body.appendChild(el('div', { class: 'hint' },
      'Draw a run with L, then click it to select the whole thing — corners and all. ' +
      'Drag a corner handle to fix one corner; Alt+click a segment adds a corner; Alt+click a corner removes it.'))
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
        const length = first.points.reduce((acc, p, i) => i === 0 ? 0 : acc + Math.hypot(p.x - first.points[i - 1].x, p.y - first.points[i - 1].y), 0)
        body.appendChild(field('Plan length', el('div', {}, formatMetres(length * mmPerPoint, 2))))
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

  const otherSheets = store.project.sheets.filter((s) => s.id !== store.project.activeSheetId)
  if (otherSheets.length) {
    const copySelect: HTMLSelectElement = select(
      [['', 'Copy to sheet…'] as const, ...otherSheets.map((s) => [s.id, s.name] as const)], '',
      (v) => {
        if (v) app.duplicateSelectionToSheet(v)
        copySelect.value = ''
      },
    )
    body.appendChild(el('div', { style: { marginTop: '8px' } }, copySelect))
    body.appendChild(el('div', { class: 'hint' },
      'Copies land at the same coordinates on the other floor — the quick way to line a riser up between storeys.'))
  }
}

/** Enough to recognise an item by, in as few words as possible. */
function describeItem(store: App['store'], item: Item): string {
  const sys = store.system(item.systemId).name
  if (item.kind === 'room') return `${item.name} (room)`
  if (item.kind === 'door') return `${item.ref ?? 'door'}`
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
  body.appendChild(el('div', { class: 'section-title' }, 'Directions — every sheet'))

  if (!rose) {
    body.appendChild(field('Compass',
      el('button', { onclick: () => editor.placeCompass() }, 'Place compass rose'),
      'Optional. Drops a rose on the plan — one for all sheets. Drag a tip to turn it, then name each tip here.'))
  } else {
    const turned = el('input', {
      type: 'number', step: '0.5', value: String(Number(rose.rotationDeg.toFixed(1))), style: { width: '70px' },
      title: 'Where tip 1 points, in degrees clockwise from straight up. Or drag tip 1 on the plan.',
      dataset: { focusKey: 'compass-rotation' },
    }) as HTMLInputElement
    turned.addEventListener('change', () => editor.turnCompass(Number(turned.value)))
    body.appendChild(field('Compass', el('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px' } },
      turned, '°',
      el('button', { title: 'Bring the compass rose into view', onclick: () => editor.placeCompass() }, 'Show'),
      el('button', { title: 'Take the compass rose off this sheet (undo brings it back)', onclick: () => editor.removeCompass() }, 'Remove'),
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
      input.addEventListener('change', () => { const v = input.value; setTimeout(() => editor.nameCompassTip(tip, v), 0) })
      body.appendChild(field(`Tip ${tip + 1} · ${Math.round(bearing)}°`, input))
    }
  }

  const others = store.project.directions ?? []
  body.appendChild(field(rose ? 'Others' : 'Off-axis', el('div', {},
    ...others.map((d) => el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' } },
      el('span', {}, `${d.aliases.join(', ') || d.id} · ${Math.round(d.bearingDeg)}°`),
      el('button', {
        title: `Remove "${d.id}"`,
        style: { padding: '0 6px', lineHeight: '1.4' },
        onclick: () => editor.removeDirection(d.id),
      }, '✕'),
    )),
    el('button', {
      title: 'A bearing the compass rose does not cover: click two points on the plan, then name it',
      onclick: () => editor.setTool('direction'),
    }, others.length ? 'Add another…' : 'Add an off-axis direction…'),
  )))
}
