import type { App } from '../../app.ts'
import { CATEGORY_LABELS } from '../../model/types.ts'
import { computeTakeoff } from '../../takeoff.ts'
import { formatMetres } from '../../units.ts'
import { el, field, swatch } from '../dom.ts'

let takeoffScope: 'sheet' | 'project' = 'sheet'

export function buildTakeoff(app: App, body: HTMLElement): void {
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
      // What you order is a gauge, not a system, so split it once there is more than one.
      if (row.bySize.length > 1) {
        for (const tally of row.bySize) {
          table.appendChild(el('tr', { style: { color: 'var(--ink-soft)' } },
            el('td', { style: { paddingLeft: '34px' } }, tally.size),
            el('td', { class: 'num' }, tally.lengthMm ? formatMetres(tally.lengthMm) : '—'),
            el('td', { class: 'num' }, tally.orderMm ? formatMetres(tally.orderMm) : '—'),
            el('td', { class: 'num' }, String(tally.runs)),
          ))
        }
      }
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

function copyTakeoffCsv(app: App, rows: ReturnType<typeof computeTakeoff>['rows']): void {
  const lines = ['system,category,size,runs,plan_m,order_m']
  for (const r of rows) {
    for (const t of r.bySize) {
      lines.push([
        JSON.stringify(r.system.name), r.system.category, JSON.stringify(t.size), t.runs,
        (t.lengthMm / 1000).toFixed(2), (t.orderMm / 1000).toFixed(2),
      ].join(','))
    }
  }
  void navigator.clipboard.writeText(lines.join('\n')).then(
    () => app.editor.flash('Takeoff copied to the clipboard as CSV'),
    () => app.editor.flash('Clipboard blocked by the browser'),
  )
}
