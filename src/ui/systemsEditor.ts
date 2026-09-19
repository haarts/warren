import type { App } from '../app.ts'
import { DASH_PRESETS, missingDefaults, PALETTE } from '../model/systems.ts'
import { CATEGORIES, CATEGORY_LABELS, type System } from '../model/types.ts'
import { newId } from '../model/ids.ts'
import { el, select, swatch } from './dom.ts'
import { confirmDialog, openModal } from './modal.ts'

function dashIndex(dash: number[]): number {
  const key = dash.join(',')
  const found = DASH_PRESETS.findIndex((d) => d.dash.join(',') === key)
  return found >= 0 ? found : 0
}

/**
 * The catalogue is the whole point of the app: style is a property of the system, not of the
 * shape, so 200 runs drawn over two years still agree with each other and with the legend.
 */
export function openSystemsEditor(app: App): void {
  const { store } = app
  const rerender = (): void => { store.touch(); app.refresh() }

  openModal((close) => {
    const body = el('div', {})
    const build = (): void => {
      body.replaceChildren()
      body.appendChild(el('div', { class: 'hint' },
        'Colour alone cannot carry 40 systems — especially not on a greyscale print — so every system also has a ' +
        'dash pattern and a width. Changing a system restyles everything drawn with it.'))

      // A project carries its own catalogue, so one started before a system existed will not
      // have it. Offer the gap rather than merging it back in behind your back.
      const missing = missingDefaults(store.project.systems)
      if (missing.length) {
        body.appendChild(el('div', { style: { margin: '6px 0 2px' } },
          el('button', {
            title: missing.map((m) => m.name).join(', '),
            onclick: () => {
              store.mutate(() => { store.project.systems.push(...missingDefaults(store.project.systems)) })
              store.invalidateSystems()
              build()
              rerender()
            },
          }, `Add ${missing.length} missing default system${missing.length === 1 ? '' : 's'}`),
        ))
      }

      for (const category of CATEGORIES) {
        const systems = store.project.systems.filter((s) => s.category === category)
        body.appendChild(el('div', { class: 'section-title' }, CATEGORY_LABELS[category]))
        const table = el('table', { class: 'systems-table' })
        table.appendChild(el('tr', {},
          el('th', { style: { width: '34px' } }, ''),
          el('th', {}, 'Name'),
          el('th', { style: { width: '110px' } }, 'Line'),
          el('th', { style: { width: '58px' } }, 'Width'),
          el('th', { style: { width: '150px' } }, 'Sizes (first is default)'),
          el('th', { style: { width: '92px' } }, 'Tag'),
          el('th', { style: { width: '38px' }, title: 'Guess a direction for new runs from the order they are drawn' }, 'Dir'),
          el('th', { style: { width: '28px' } }, ''),
        ))
        for (const sys of systems) table.appendChild(systemRow(app, sys, build, rerender))
        body.appendChild(table)
        body.appendChild(el('button', {
          style: { marginTop: '4px' },
          onclick: () => {
            store.mutate(() => {
              store.project.systems.push({
                id: newId(category),
                category,
                name: 'New system',
                color: PALETTE[store.project.systems.length % PALETTE.length].hex,
                dash: [],
                width: 1.6,
                visible: true,
                locked: false,
              })
            })
            store.invalidateSystems()
            build()
            app.refresh()
          },
        }, `+ Add to ${CATEGORY_LABELS[category].toLowerCase()}`))
      }
    }
    build()

    return {
      title: 'Systems',
      width: '860px',
      body,
      footer: el('button', { class: 'primary', onclick: close }, 'Done'),
    }
  })
}

function systemRow(app: App, sys: System, rebuild: () => void, rerender: () => void): HTMLElement {
  const { store } = app
  const preview = el('span', {}, swatch(sys.color, sys.dash, sys.width))
  const refreshPreview = (): void => {
    preview.replaceChildren(swatch(sys.color, sys.dash, sys.width))
    store.invalidateSystems()
    rerender()
  }

  const colorInput = el('input', { type: 'color', value: sys.color }) as HTMLInputElement
  colorInput.addEventListener('input', () => {
    store.mutate(() => { sys.color = colorInput.value })
    refreshPreview()
  })

  const palette = el('div', { class: 'palette', style: { marginTop: '2px' } })
  for (const swatchDef of PALETTE) {
    palette.appendChild(el('button', {
      style: { background: swatchDef.hex },
      title: swatchDef.name,
      onclick: () => {
        store.mutate(() => { sys.color = swatchDef.hex })
        colorInput.value = swatchDef.hex
        refreshPreview()
      },
    }))
  }

  const nameInput = el('input', { type: 'text', value: sys.name }) as HTMLInputElement
  nameInput.addEventListener('change', () => {
    store.mutate(() => { sys.name = nameInput.value.trim() || sys.name })
    rerender()
  })

  const dashSelect = select(
    DASH_PRESETS.map((preset, i) => [String(i), preset.name] as const), String(dashIndex(sys.dash)),
    (v) => {
      store.mutate(() => { sys.dash = [...DASH_PRESETS[Number(v)].dash] })
      refreshPreview()
    },
  )

  const widthInput = el('input', { type: 'number', min: '0.4', max: '10', step: '0.1', value: String(sys.width) }) as HTMLInputElement
  widthInput.addEventListener('change', () => {
    store.mutate(() => { sys.width = Math.max(0.4, Number(widthInput.value) || 1.6) })
    refreshPreview()
  })

  const sizeInput = el('input', {
    type: 'text',
    value: (sys.sizes ?? (sys.defaultSize ? [sys.defaultSize] : [])).join(', '),
    placeholder: 'Ø16, Ø20, Ø25',
    title: 'Comma-separated. These appear in the size dropdown; the first is what new runs get.',
  }) as HTMLInputElement
  sizeInput.addEventListener('change', () => {
    const sizes = sizeInput.value.split(',').map((v) => v.trim()).filter(Boolean)
    store.mutate(() => {
      // An empty list is stored rather than deleted, so "no suggestions here" survives a
      // reload instead of being refilled from the seed catalogue on the next open.
      sys.sizes = sizes
      if (sizes.length) sys.defaultSize = sizes[0]
      else delete sys.defaultSize
    })
    sizeInput.value = sizes.join(', ')
  })

  const tagInput = el('input', { type: 'text', value: sys.tag ?? '', placeholder: '—', title: 'Always shown on the label, e.g. NON-POTABLE' }) as HTMLInputElement
  tagInput.addEventListener('change', () => {
    store.mutate(() => { sys.tag = tagInput.value.trim() || undefined })
    rerender()
  })

  const usage = (): number =>
    store.project.sheets.reduce((n, sheet) => n + sheet.items.filter((i) => i.systemId === sys.id).length, 0)

  const remove = el('button', {
    class: 'danger',
    title: 'Delete this system',
    onclick: async () => {
      const used = usage()
      const ok = used === 0 || await confirmDialog(
        'Delete system?',
        `${used} item(s) still use "${sys.name}". They will keep their colour but show as "Unknown system" until you reassign them.`,
        'Delete',
      )
      if (!ok) return
      store.mutate(() => {
        store.project.systems = store.project.systems.filter((s) => s.id !== sys.id)
      })
      store.invalidateSystems()
      rebuild()
      rerender()
    },
  }, '×')

  const flowBox = el('input', {
    type: 'checkbox',
    checked: sys.assumeFlow === true,
    title: 'New runs guess a direction from the order you drew them. For things that fall, are '
      + 'pumped or are blown — not for a socket circuit, where an arrow would be noise.',
  }) as HTMLInputElement
  flowBox.addEventListener('change', () => {
    // Written explicitly either way, so unticking is a decision rather than an absence that
    // gets refilled from the seed catalogue on the next open.
    store.mutate(() => { sys.assumeFlow = flowBox.checked })
  })

  return el('tr', {},
    el('td', {}, preview),
    el('td', {}, nameInput),
    el('td', {}, dashSelect, el('div', { style: { display: 'flex', gap: '4px', marginTop: '2px' } }, colorInput, palette)),
    el('td', {}, widthInput),
    el('td', {}, sizeInput),
    el('td', {}, tagInput),
    el('td', { style: { textAlign: 'center' } }, flowBox),
    el('td', {}, remove),
  )
}
