import type { App } from '../../app.ts'
import { CATEGORIES, CATEGORY_LABELS, type System } from '../../model/types.ts'
import { el, field, swatch } from '../dom.ts'

export function buildLayers(app: App, body: HTMLElement): void {
  const { store, editor } = app
  const counts = new Map<string, number>()
  for (const item of store.items()) counts.set(item.systemId, (counts.get(item.systemId) ?? 0) + 1)
  const hidden = store.project.systems.filter((s) => !s.visible).length

  body.appendChild(el('div', { class: 'hint' },
    'Toggle a whole discipline or a single system. ',
    el('b', {}, 'Only'),
    ' hides everything else, so you can look at one thing on its own; press it again to bring the '
    + 'rest back. Hidden systems are also excluded from clicks, exports and prints.'))

  // Isolating one circuit by what it says about itself, which is where a group number lives.
  const filterInput = el('input', {
    type: 'text',
    value: store.project.settings.labelFilter,
    placeholder: 'label contains…  e.g. g7',
    title: 'Show only items whose label, size or note contains this. Rooms and doors always stay.',
  }) as HTMLInputElement
  const commitFilter = (): void => {
    if (filterInput.value === store.project.settings.labelFilter) return
    store.project.settings.labelFilter = filterInput.value
    store.touch()
    editor.requestRender()
    app.refresh()
  }
  filterInput.addEventListener('change', commitFilter)
  filterInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commitFilter()
    if (e.key === 'Escape') { filterInput.value = ''; commitFilter() }
  })
  const active = store.project.settings.labelFilter.trim() !== ''
  const filtered = active ? store.items().filter((i) => !store.isVisible(i)).length : 0
  body.appendChild(field('Filter', el('div', { style: { display: 'flex', gap: '4px' } },
    filterInput,
    active ? el('button', { onclick: () => { filterInput.value = ''; commitFilter() } }, '×') : null,
  ), active ? `${filtered} item(s) hidden by the filter. Rooms and doors are exempt.` : undefined))

  const buttons = el('div', { style: { display: 'flex', gap: '6px', margin: '6px 0 10px' } },
    el('button', {
      // Says how much is hidden, so a forgotten solo cannot masquerade as an empty drawing.
      class: hidden ? 'active' : '',
      onclick: () => { showOnly(app, null) },
    }, hidden ? `Show all (${hidden} hidden)` : 'Show all'),
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
    const soloed = isOnly(store, systems.map((s) => s.id))
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
      el('button', {
        class: `solo ${soloed ? 'on' : ''}`,
        title: `Show only ${CATEGORY_LABELS[category].toLowerCase()}`,
        onclick: (e: MouseEvent) => {
          e.stopPropagation()
          showOnly(app, soloed ? null : systems.map((s) => s.id))
        },
      }, 'only'),
    ))
    for (const sys of systems) {
      group.appendChild(systemRow(app, sys, counts.get(sys.id) ?? 0))
    }
    body.appendChild(group)
  }
}

/** Is exactly this set visible and nothing else? */
function isOnly(store: App['store'], ids: string[]): boolean {
  const want = new Set(ids)
  return store.project.systems.every((s) => s.visible === want.has(s.id))
}

/** Show only these systems, or everything when given null. */
function showOnly(app: App, ids: string[] | null): void {
  const want = ids === null ? null : new Set(ids)
  for (const s of app.store.project.systems) s.visible = want === null ? true : want.has(s.id)
  app.store.touch()
  app.editor.requestRender()
  app.refresh()
}

function systemRow(app: App, sys: System, count: number): HTMLElement {
  const { store, editor } = app
  const refresh = (): void => { store.touch(); editor.requestRender(); app.refresh() }
  const soloed = isOnly(store, [sys.id])
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
      title: `Show only ${sys.name}, and nothing else`,
      onclick: () => showOnly(app, soloed ? null : [sys.id]),
    }, 'only'),
    el('button', {
      class: `lock ${sys.locked ? 'on' : ''}`,
      title: sys.locked ? 'Unlock for editing' : 'Lock: visible but not selectable',
      onclick: () => { sys.locked = !sys.locked; refresh() },
    }, sys.locked ? '🔒' : '🔓'),
  )
}
