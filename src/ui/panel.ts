import type { App } from '../app.ts'
import { polygonArea } from '../geom.ts'
import { ROOM_USES, ROOM_USE_LABELS, type Item, type Level, type RoomUse, type System } from '../model/types.ts'
import {
  CATEGORIES, CATEGORY_LABELS, LEVELS, LEVEL_LABELS, MARKER_LABELS, MARKER_SYMBOLS,
  type MarkerSymbol,
} from '../model/types.ts'
import { computeTakeoff } from '../takeoff.ts'
import { countBySeverity, runChecks, type Finding, type Severity } from '../check.ts'
import { missingAssetIds } from '../model/assets.ts'
import { buildGraph, connectionsOf, networkOf } from '../topology.ts'
import { adopt, generatedBy } from '../generate.ts'
import { formatMetres } from '../units.ts'
import { clear, el, field, swatch } from './dom.ts'

type TabId = 'properties' | 'layers' | 'takeoff' | 'check'
let activeTab: TabId = 'properties'
let takeoffScope: 'sheet' | 'project' = 'sheet'

export function buildPanel(app: App, host: HTMLElement): void {
  const scrollTop = host.querySelector('.tab-body')?.scrollTop ?? 0
  clear(host)

  const tabs = el('div', { class: 'tabs' })
  const body = el('div', { class: 'tab-body' })
  const tabDefs: { id: TabId; label: string }[] = [
    { id: 'properties', label: 'Properties' },
    { id: 'layers', label: 'Layers' },
    { id: 'takeoff', label: 'Takeoff' },
    { id: 'check', label: 'Check' },
  ]
  for (const tab of tabDefs) {
    tabs.appendChild(el('button', {
      class: activeTab === tab.id ? 'active' : '',
      onclick: () => { activeTab = tab.id; buildPanel(app, host) },
    }, tab.label))
  }
  host.appendChild(tabs)
  host.appendChild(body)

  if (activeTab === 'properties') buildProperties(app, body)
  else if (activeTab === 'layers') buildLayers(app, body)
  else if (activeTab === 'takeoff') buildTakeoff(app, body)
  else buildCheck(app, body)

  body.scrollTop = scrollTop
}

// -------------------------------------------------------------------------- properties

function buildProperties(app: App, body: HTMLElement): void {
  const { store, editor } = app
  const items = store.selectedItems()

  body.appendChild(el('div', { class: 'section-title' }, 'Sheet'))
  const sheet = store.sheet
  body.appendChild(field('Scale', sheet.mmPerPoint
    ? el('div', {}, `1 pt = ${sheet.mmPerPoint.toFixed(3)} mm`)
    : el('button', { onclick: () => editor.setTool('calibrate') }, 'Calibrate this sheet…')))
  if (!sheet.mmPerPoint) {
    body.appendChild(el('div', { class: 'hint warn' },
      'Uncalibrated: lengths and the takeoff stay empty. Click Calibrate, then click the two ends of a dimension printed on the plan.'))
  }

  const lockedOnSheet = store.items().filter((i) => i.locked)
  if (lockedOnSheet.length) {
    body.appendChild(field('Locked', el('button', {
      title: 'Locked items cannot be clicked on the canvas — this is the way back',
      onclick: () => {
        store.mutate(() => {
          for (const item of store.items()) delete item.locked
        })
      },
    }, `Unlock all (${lockedOnSheet.length})`)))
  }

  const flowless = store.items().filter(
    (i) => i.kind === 'run' && i.flow === 'none' && store.system(i.systemId).assumeFlow,
  )
  if (flowless.length) {
    body.appendChild(field('Flow', el('button', {
      title: 'Sets each one along the order it was drawn in, marked as a guess until you confirm it',
      onclick: () => {
        store.mutate(() => {
          for (const item of store.items()) {
            if (item.kind !== 'run' || item.flow !== 'none') continue
            if (!store.system(item.systemId).assumeFlow) continue
            item.flow = 'forward'
            item.flowAssumed = true
          }
        })
      },
    }, `Assume direction for ${flowless.length} run${flowless.length === 1 ? '' : 's'}`)))
  }

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

  // System
  const systemSelect = el('select', {
    onchange: (e: Event) => {
      const value = (e.target as HTMLSelectElement).value
      applyToAll((item) => {
        item.systemId = value
        if (item.kind === 'run') {
          const sys = store.system(value)
          if (!item.size && sys.defaultSize) item.size = sys.defaultSize
        }
      })
    },
  }) as HTMLSelectElement
  for (const category of CATEGORIES) {
    const systems = store.project.systems.filter((s) => s.category === category)
    if (!systems.length) continue
    const group = el('optgroup', { label: CATEGORY_LABELS[category] })
    for (const sys of systems) {
      group.appendChild(el('option', {
        value: sys.id,
        selected: items.every((i) => i.systemId === sys.id),
      }, sys.name))
    }
    systemSelect.appendChild(group)
  }
  if (!items.every((i) => i.systemId === first.systemId)) systemSelect.value = ''
  body.appendChild(field('System', systemSelect))

  // Level
  const levelSelect = el('select', {
    onchange: (e: Event) => {
      const value = (e.target as HTMLSelectElement).value as Level
      applyToAll((item) => { item.level = value })
    },
  }) as HTMLSelectElement
  for (const level of LEVELS) {
    levelSelect.appendChild(el('option', {
      value: level, selected: items.every((i) => i.level === level),
    }, LEVEL_LABELS[level]))
  }
  body.appendChild(field('Level', levelSelect))

  if (!many && first.kind === 'room') {
    body.appendChild(field('Name', textInput(first.name, (v) => applyToAll((item) => {
      if (item.kind === 'room') item.name = v.trim() || item.name
    }))))
    const useSelect = el('select', {
      onchange: (e: Event) => {
        const value = (e.target as HTMLSelectElement).value as RoomUse
        applyToAll((item) => { if (item.kind === 'room') item.use = value })
      },
    }) as HTMLSelectElement
    for (const use of ROOM_USES) {
      useSelect.appendChild(el('option', { value: use, selected: first.use === use }, ROOM_USE_LABELS[use]))
    }
    body.appendChild(field('Used as', useSelect, 'What a room is for is what lets rules act on it — sockets, switches, detectors.'))
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
        onclick: () => applyToAll((item) => {
          if (item.kind === 'door') item.points = [...item.points].reverse()
        }),
      }, 'Swap jambs'),
      el('button', {
        onclick: () => applyToAll((item) => {
          if (item.kind === 'door') item.swing = item.swing === 1 ? -1 : 1
        }),
      }, 'Flip swing'),
    ), 'The hinge is the first jamb. A light switch belongs by the other one, not behind the door.'))
  }

  if (first.kind === 'run' && !many) {
    const sys = store.system(first.systemId)
    body.appendChild(field('Size / spec', sizeInput(first.size ?? '', sys.sizes ?? [], sys.defaultSize, sys.id, (v) =>
      applyToAll((item) => { if (item.kind === 'run') item.size = v }))))
  }

  if (items.every((i) => i.kind === 'run')) {
    const flowSelect = el('select', {
      onchange: (e: Event) => {
        const value = (e.target as HTMLSelectElement).value as 'none' | 'forward' | 'reverse'
        // Choosing a direction by hand is the confirmation, whichever direction you choose.
        applyToAll((item) => {
          if (item.kind !== 'run') return
          item.flow = value
          delete item.flowAssumed
        })
      },
    }) as HTMLSelectElement
    for (const [value, label] of [['none', 'No arrows'], ['forward', 'Along the run'], ['reverse', 'Against the run']] as const) {
      flowSelect.appendChild(el('option', {
        value, selected: items.every((i) => i.kind === 'run' && i.flow === value),
      }, label))
    }
    body.appendChild(field('Flow', flowSelect))

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
      body.appendChild(field('Joined to', el('div', {},
        joined.length === 0 ? 'nothing yet' : `${joined.length} item${joined.length === 1 ? '' : 's'}`,
        loose > 0 ? el('span', { style: { color: 'var(--ink-soft)' } }, `, ${loose} loose end${loose === 1 ? '' : 's'}`) : null,
      )))
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
    const commit = (): void => applyToAll((item) => {
      if (item.kind === 'note') item.text = text.value
    })
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
    const symbolSelect = el('select', {
      onchange: (e: Event) => {
        const value = (e.target as HTMLSelectElement).value as MarkerSymbol
        applyToAll((item) => { if (item.kind === 'marker') item.symbol = value })
      },
    }) as HTMLSelectElement
    for (const symbol of MARKER_SYMBOLS) {
      symbolSelect.appendChild(el('option', { value: symbol, selected: first.symbol === symbol }, MARKER_LABELS[symbol]))
    }
    body.appendChild(field('Symbol', symbolSelect))
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
    const copySelect = el('select', {}) as HTMLSelectElement
    copySelect.appendChild(el('option', { value: '' }, 'Copy to sheet…'))
    for (const s of otherSheets) copySelect.appendChild(el('option', { value: s.id }, s.name))
    copySelect.addEventListener('change', () => {
      if (copySelect.value) app.duplicateSelectionToSheet(copySelect.value)
      copySelect.value = ''
    })
    body.appendChild(el('div', { style: { marginTop: '8px' } }, copySelect))
    body.appendChild(el('div', { class: 'hint' },
      'Copies land at the same coordinates on the other floor — the quick way to line a riser up between storeys.'))
  }
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
 * A combo box: the system's suggested sizes in a dropdown, but still an ordinary text field
 * underneath. A closed list would be wrong - the one spec you need is always the one nobody
 * thought to list.
 */
function sizeInput(
  value: string, sizes: string[], placeholder: string | undefined, key: string,
  onChange: (v: string) => void,
): HTMLElement {
  const input = el('input', {
    type: 'text',
    value,
    placeholder: placeholder ?? '',
    title: sizes.length ? 'Pick a common size from the list, or type anything you like' : '',
  }) as HTMLInputElement
  input.addEventListener('change', () => onChange(input.value.trim()))
  if (sizes.length === 0) return input

  const listId = `sizes-${key.replace(/\W+/g, '-')}`
  input.setAttribute('list', listId)
  const datalist = el('datalist', { id: listId })
  for (const size of sizes) datalist.appendChild(el('option', { value: size }))
  return el('div', { style: { display: 'contents' } }, input, datalist)
}

function textInput(value: string, onChange: (v: string) => void, placeholder?: string): HTMLElement {
  const input = el('input', { type: 'text', value, placeholder: placeholder ?? '' }) as HTMLInputElement
  input.addEventListener('change', () => onChange(input.value))
  return input
}

function numberInput(value: number, onChange: (v: number) => void): HTMLElement {
  const input = el('input', { type: 'number', value: String(value), step: '0.1' }) as HTMLInputElement
  input.addEventListener('change', () => onChange(Number(input.value) || 0))
  return input
}

// ------------------------------------------------------------------------------ layers

function buildLayers(app: App, body: HTMLElement): void {
  const { store, editor } = app
  const counts = new Map<string, number>()
  for (const item of store.items()) counts.set(item.systemId, (counts.get(item.systemId) ?? 0) + 1)

  body.appendChild(el('div', { class: 'hint' },
    'Toggle a whole discipline or a single system. Hidden systems are also excluded from clicks, exports and prints.'))

  const buttons = el('div', { style: { display: 'flex', gap: '6px', margin: '6px 0 10px' } },
    el('button', {
      onclick: () => { for (const s of store.project.systems) s.visible = true; store.touch(); editor.requestRender(); app.refresh() },
    }, 'Show all'),
    el('button', {
      onclick: () => {
        for (const s of store.project.systems) s.visible = counts.has(s.id)
        store.touch(); editor.requestRender(); app.refresh()
      },
    }, 'Only used'),
  )
  body.appendChild(buttons)

  for (const category of CATEGORIES) {
    const systems = store.project.systems.filter((s) => s.category === category)
    if (!systems.length) continue
    const used = systems.reduce((n, s) => n + (counts.get(s.id) ?? 0), 0)
    const allVisible = systems.every((s) => s.visible)
    const group = el('div', { class: 'layer-cat' })
    group.appendChild(el('header', {
      onclick: () => {
        for (const s of systems) s.visible = !allVisible
        store.touch()
        editor.requestRender()
        app.refresh()
      },
    },
      el('span', { class: `eye ${allVisible ? 'on' : ''}` }, allVisible ? '👁' : '—'),
      el('span', {}, CATEGORY_LABELS[category]),
      el('span', { class: 'count' }, used ? `${used} item${used === 1 ? '' : 's'}` : ''),
    ))
    for (const sys of systems) {
      group.appendChild(systemRow(app, sys, counts.get(sys.id) ?? 0))
    }
    body.appendChild(group)
  }
}

function systemRow(app: App, sys: System, count: number): HTMLElement {
  const { store, editor } = app
  const refresh = (): void => { store.touch(); editor.requestRender(); app.refresh() }
  const soloed = store.project.systems.every((s) => (s.id === sys.id ? s.visible : !s.visible))
  return el('div', { class: `layer-row ${sys.visible ? '' : 'hidden'}` },
    el('button', {
      class: `eye ${sys.visible ? 'on' : ''}`,
      title: sys.visible ? 'Hide' : 'Show',
      onclick: () => { sys.visible = !sys.visible; refresh() },
    }, sys.visible ? '👁' : '—'),
    swatch(sys.color, sys.dash, sys.width),
    el('span', { class: 'name', title: sys.name }, sys.name),
    el('span', { class: 'n' }, count ? String(count) : ''),
    el('button', {
      class: `solo ${soloed ? 'on' : ''}`,
      title: 'Show only this system',
      onclick: () => {
        const wasSolo = soloed
        for (const s of store.project.systems) s.visible = wasSolo ? true : s.id === sys.id
        refresh()
      },
    }, 'S'),
    el('button', {
      class: `lock ${sys.locked ? 'on' : ''}`,
      title: sys.locked ? 'Unlock for editing' : 'Lock: visible but not selectable',
      onclick: () => { sys.locked = !sys.locked; refresh() },
    }, sys.locked ? '🔒' : '🔓'),
  )
}

// ----------------------------------------------------------------------------- takeoff

function buildTakeoff(app: App, body: HTMLElement): void {
  const { store } = app
  const result = computeTakeoff(store, takeoffScope)

  const scope = el('div', { style: { display: 'flex', gap: '6px', marginBottom: '8px' } },
    el('button', {
      class: takeoffScope === 'sheet' ? 'active' : '',
      onclick: () => { takeoffScope = 'sheet'; app.refresh() },
    }, 'This sheet'),
    el('button', {
      class: takeoffScope === 'project' ? 'active' : '',
      onclick: () => { takeoffScope = 'project'; app.refresh() },
    }, 'Whole project'),
  )
  body.appendChild(scope)

  const slack = el('input', {
    type: 'number', min: '0', max: '100', step: '1',
    value: String(store.project.settings.takeoffSlackPct),
    style: { width: '70px' },
  }) as HTMLInputElement
  slack.addEventListener('change', () => {
    store.project.settings.takeoffSlackPct = Math.max(0, Number(slack.value) || 0)
    store.touch()
    app.refresh()
  })
  body.appendChild(field('Slack %', slack))
  body.appendChild(el('div', { class: 'hint' },
    'A plan length is not a material length: drops down walls, rises into ceilings, bends and service loops are invisible from above. ' +
    'Order from the right-hand column, not the middle one.'))

  if (result.uncalibrated.length) {
    body.appendChild(el('div', { class: 'hint warn' },
      `Not calibrated: ${result.uncalibrated.join(', ')}. Lengths on those sheets are missing.`))
  }

  if (result.rows.length === 0) {
    body.appendChild(el('div', { class: 'hint' }, 'Nothing drawn yet.'))
    return
  }

  const table = el('table', { class: 'data' })
  table.appendChild(el('tr', {},
    el('th', {}, 'System'),
    el('th', { class: 'num' }, 'Plan'),
    el('th', { class: 'num' }, 'Order'),
    el('th', { class: 'num' }, '#'),
  ))
  for (const group of result.byCategory) {
    table.appendChild(el('tr', { class: 'cat' }, el('td', { colSpan: '4' }, CATEGORY_LABELS[group.category])))
    for (const row of group.rows) {
      table.appendChild(el('tr', {},
        el('td', {}, swatch(row.system.color, row.system.dash, row.system.width), ' ', row.system.name),
        el('td', { class: 'num' }, row.lengthMm ? formatMetres(row.lengthMm) : '—'),
        el('td', { class: 'num' }, row.orderMm ? el('b', {}, formatMetres(row.orderMm)) : '—'),
        el('td', { class: 'num' }, String(row.runs + row.boxes + row.markers)),
      ))
    }
  }
  body.appendChild(table)

  const totalPlan = result.rows.reduce((n, r) => n + r.lengthMm, 0)
  const totalOrder = result.rows.reduce((n, r) => n + r.orderMm, 0)
  body.appendChild(el('div', { class: 'hint', style: { marginTop: '8px' } },
    `Total: ${formatMetres(totalPlan)} on plan, ${formatMetres(totalOrder)} to order.`))

  body.appendChild(el('button', {
    style: { marginTop: '8px' },
    onclick: () => copyTakeoffCsv(app, result.rows),
  }, 'Copy as CSV'))
}

// ------------------------------------------------------------------------------- check

const SEVERITY_STYLE: Record<Severity, { label: string; color: string }> = {
  error: { label: 'worth fixing', color: 'var(--danger)' },
  warning: { label: 'worth a look', color: 'var(--warn)' },
  note: { label: 'just so you know', color: 'var(--ink-soft)' },
}

function buildCheck(app: App, body: HTMLElement): void {
  const { store, editor } = app
  body.appendChild(el('div', { class: 'hint' },
    'A second pair of eyes, not a set of rules. Nothing here runs unless you open this tab, '
    + 'nothing is stopping you drawing, and a half-finished drawing is allowed to look half-finished.'))

  const findings = runChecks(store, { missingAssets: missingAssetIds(store.project.assets) })
  const counts = countBySeverity(findings)
  if (findings.length === 0) {
    body.appendChild(el('div', { class: 'hint', style: { color: 'var(--ok)' } }, 'Nothing to report.'))
    return
  }

  body.appendChild(el('div', { class: 'hint' },
    `${counts.error} worth fixing · ${counts.warning} worth a look · ${counts.note} just so you know`))

  for (const severity of ['error', 'warning', 'note'] as Severity[]) {
    const group = findings.filter((f) => f.severity === severity)
    if (group.length === 0) continue
    body.appendChild(el('div', { class: 'section-title' }, SEVERITY_STYLE[severity].label))
    for (const finding of group) body.appendChild(findingRow(app, finding))
  }

  body.appendChild(el('div', { class: 'hint', style: { marginTop: '10px' } },
    'The same rules run from a terminal with ', el('code', {}, 'warren check'), '.'))
  void editor
}

function findingRow(app: App, finding: Finding): HTMLElement {
  const { store, editor } = app
  const canShow = finding.itemIds.length > 0
  const row = el('div', {
    class: 'layer-row',
    style: { alignItems: 'flex-start', cursor: canShow ? 'pointer' : 'default', padding: '5px 7px' },
    title: canShow ? 'Show me' : '',
    onclick: () => {
      if (!canShow) return
      if (finding.sheetId && finding.sheetId !== store.project.activeSheetId) {
        store.setActiveSheet(finding.sheetId)
        editor.invalidateBackground()
      }
      store.selection.clear()
      for (const id of finding.itemIds) if (store.item(id)) store.selection.add(id)
      store.touch(false)
      editor.zoomToSelection()
      app.refresh()
    },
  },
    el('div', { style: { flex: '1', lineHeight: '1.4' } },
      el('div', {}, finding.message),
      el('div', { style: { color: 'var(--ink-soft)', fontSize: '11px' } }, `${finding.rule} · ${finding.where}`),
    ),
  )
  return row
}

function copyTakeoffCsv(app: App, rows: ReturnType<typeof computeTakeoff>['rows']): void {
  const lines = ['system,category,runs,plan_m,order_m,boxes,markers']
  for (const r of rows) {
    lines.push([
      JSON.stringify(r.system.name), r.system.category, r.runs,
      (r.lengthMm / 1000).toFixed(2), (r.orderMm / 1000).toFixed(2), r.boxes, r.markers,
    ].join(','))
  }
  void navigator.clipboard.writeText(lines.join('\n')).then(
    () => app.editor.onStatus?.('Takeoff copied to the clipboard as CSV'),
    () => app.editor.onStatus?.('Clipboard blocked by the browser'),
  )
}
