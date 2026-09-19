import type { App } from '../app.ts'
import { clear, el } from './dom.ts'
import { buildCheck } from './panel/check.ts'
import { buildLayers } from './panel/layers.ts'
import { buildProperties } from './panel/properties.ts'
import { buildTakeoff } from './panel/takeoff.ts'

type TabId = 'properties' | 'layers' | 'takeoff' | 'check'
let activeTab: TabId = 'properties'

const TABS: { id: TabId; label: string; build: (app: App, body: HTMLElement) => void }[] = [
  { id: 'properties', label: 'Properties', build: buildProperties },
  { id: 'layers', label: 'Layers', build: buildLayers },
  { id: 'takeoff', label: 'Takeoff', build: buildTakeoff },
  { id: 'check', label: 'Check', build: buildCheck },
]

export function buildPanel(app: App, host: HTMLElement): void {
  const scrollTop = host.querySelector('.tab-body')?.scrollTop ?? 0
  // The panel is rebuilt from scratch on every change. An input that carries a focus key keeps
  // the focus (and the caret) across that, so filling in a row of fields is not a fight.
  const active = document.activeElement
  const focusKey = active instanceof HTMLInputElement && host.contains(active) ? active.dataset.focusKey : undefined
  const caret = focusKey && active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] as const : null
  clear(host)

  const tabs = el('div', { class: 'tabs' })
  const body = el('div', { class: 'tab-body' })
  for (const tab of TABS) {
    tabs.appendChild(el('button', {
      class: activeTab === tab.id ? 'active' : '',
      onclick: () => { activeTab = tab.id; buildPanel(app, host) },
    }, tab.label))
  }
  host.appendChild(tabs)
  host.appendChild(body)

  TABS.find((t) => t.id === activeTab)?.build(app, body)

  body.scrollTop = scrollTop
  if (focusKey) {
    const again = body.querySelector<HTMLInputElement>(`input[data-focus-key="${focusKey}"]`)
    if (again) {
      again.focus()
      if (caret && again.type === 'text') again.setSelectionRange(caret[0], caret[1])
    }
  }
}
