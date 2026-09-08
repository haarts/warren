import { clear, el } from './dom.ts'

const root = (): HTMLElement => {
  const node = document.getElementById('modal-root')
  if (!node) throw new Error('#modal-root missing')
  return node
}

export interface ModalHandle {
  close(): void
  element: HTMLElement
}

export function openModal(build: (close: () => void) => { title: string; body: Node; footer?: Node; width?: string }): ModalHandle {
  const host = root()
  clear(host)
  let backdrop: HTMLElement
  const close = (): void => {
    backdrop.remove()
    document.removeEventListener('keydown', onKey, true)
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      close()
    }
  }
  const { title, body, footer, width } = build(close)
  const dialog = el('div', { class: 'dialog', style: width ? { width } : {} },
    el('header', {}, title),
    el('div', { class: 'body' }, body as HTMLElement),
    footer ? el('footer', {}, footer as HTMLElement) : null,
  )
  backdrop = el('div', {
    class: 'backdrop',
    onclick: (e: MouseEvent) => { if (e.target === backdrop) close() },
  }, dialog)
  host.appendChild(backdrop)
  document.addEventListener('keydown', onKey, true)
  return { close, element: dialog }
}

export function askNumber(opts: {
  title: string
  label: string
  value?: number
  unit?: string
  hint?: string
  min?: number
}): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: number | null, close: () => void): void => {
      if (settled) return
      settled = true
      close()
      resolve(value)
    }
    openModal((close) => {
      const input = el('input', {
        type: 'number',
        value: opts.value !== undefined ? String(opts.value) : '',
        step: 'any',
        min: opts.min !== undefined ? String(opts.min) : undefined,
        style: { width: '160px' },
      }) as HTMLInputElement
      const submit = (): void => {
        const n = Number(input.value)
        finish(isFinite(n) && (opts.min === undefined || n >= opts.min) ? n : null, close)
      }
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit() }
      })
      setTimeout(() => { input.focus(); input.select() }, 0)
      return {
        title: opts.title,
        width: '380px',
        body: el('div', {},
          el('div', { class: 'field' }, el('label', {}, opts.label), el('div', {}, input, opts.unit ? ` ${opts.unit}` : '')),
          opts.hint ? el('div', { class: 'hint' }, opts.hint) : null,
        ),
        footer: el('div', { style: { display: 'flex', gap: '8px' } },
          el('button', { onclick: () => finish(null, close) }, 'Cancel'),
          el('button', { class: 'primary', onclick: submit }, 'OK'),
        ),
      }
    })
  })
}

export function confirmDialog(title: string, message: string, confirmLabel = 'OK'): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (v: boolean, close: () => void): void => {
      if (settled) return
      settled = true
      close()
      resolve(v)
    }
    openModal((close) => ({
      title,
      width: '420px',
      body: el('div', { class: 'hint', style: { fontSize: '13px', color: 'var(--ink)' } }, message),
      footer: el('div', { style: { display: 'flex', gap: '8px' } },
        el('button', { onclick: () => finish(false, close) }, 'Cancel'),
        el('button', { class: 'primary', onclick: () => finish(true, close) }, confirmLabel),
      ),
    }))
  })
}

export function alertDialog(title: string, message: string): void {
  openModal((close) => ({
    title,
    width: '420px',
    body: el('div', { class: 'hint', style: { fontSize: '13px', color: 'var(--ink)' } }, message),
    footer: el('button', { class: 'primary', onclick: close }, 'Close'),
  }))
}
