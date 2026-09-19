import type { App } from '../../app.ts'
import { countBySeverity, runChecks, type Finding, type Severity } from '../../check.ts'
import { missingAssetIds } from '../../model/assets.ts'
import { el } from '../dom.ts'

const SEVERITY_LABELS: Record<Severity, string> = {
  error: 'worth fixing',
  warning: 'worth a look',
  note: 'just so you know',
}

export function buildCheck(app: App, body: HTMLElement): void {
  const { store } = app
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
    body.appendChild(el('div', { class: 'section-title' }, SEVERITY_LABELS[severity]))
    for (const finding of group) body.appendChild(findingRow(app, finding))
  }

  body.appendChild(el('div', { class: 'hint', style: { marginTop: '10px' } },
    'The same rules run from a terminal with ', el('code', {}, 'warren check'), '.'))
}

function findingRow(app: App, finding: Finding): HTMLElement {
  const { store, editor } = app
  const canShow = finding.itemIds.length > 0
  return el('div', {
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
}
