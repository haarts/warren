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

/** Cancel / primary-action footer, the shape every dialog in this app ends with. */
export function dialogFooter(onCancel: () => void, primaryLabel: string, onPrimary: () => void, disabled = false): HTMLElement {
  return el('div', { style: { display: 'flex', gap: '8px' } },
    el('button', { onclick: onCancel }, 'Cancel'),
    el('button', { class: 'primary', disabled, onclick: onPrimary }, primaryLabel),
  )
}

/**
 * One text/number field, Enter to submit. `askNumber` and `askText` are thin wrappers that
 * just say how to read and validate the field's value.
 */
function promptModal<T>(opts: {
  title: string
  width: string
  label: string
  hint?: string
  input: HTMLInputElement
  wrap?: Node
  read: () => T | null
}): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: T | null, close: () => void): void => {
      if (settled) return
      settled = true
      close()
      resolve(value)
    }
    openModal((close) => {
      const submit = (): void => finish(opts.read(), close)
      opts.input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit() }
      })
      // Select a prefilled value so typing replaces it - but never text already typed, or the
      // next keystroke would wipe it.
      const initial = opts.input.value
      setTimeout(() => {
        opts.input.focus()
        if (opts.input.value === initial) opts.input.select()
      }, 0)
      return {
        title: opts.title,
        width: opts.width,
        body: el('div', {},
          el('div', { class: 'field' }, el('label', {}, opts.label), opts.wrap ?? opts.input),
          opts.hint ? el('div', { class: 'hint' }, opts.hint) : null,
        ),
        footer: dialogFooter(() => finish(null, close), 'OK', submit),
      }
    })
  })
}

export function askNumber(opts: {
  title: string
  label: string
  value?: number
  unit?: string
  hint?: string
  min?: number
}): Promise<number | null> {
  const input = el('input', {
    type: 'number',
    value: opts.value !== undefined ? String(opts.value) : '',
    step: 'any',
    min: opts.min !== undefined ? String(opts.min) : undefined,
    style: { width: '160px' },
  }) as HTMLInputElement
  return promptModal({
    title: opts.title, width: '380px', label: opts.label, hint: opts.hint, input,
    wrap: el('div', {}, input, opts.unit ? ` ${opts.unit}` : ''),
    read: () => {
      const n = Number(input.value)
      return isFinite(n) && (opts.min === undefined || n >= opts.min) ? n : null
    },
  })
}

export function askText(opts: {
  title: string
  label: string
  placeholder?: string
  hint?: string
}): Promise<string | null> {
  const input = el('input', { type: 'text', placeholder: opts.placeholder ?? '', style: { width: '100%' } }) as HTMLInputElement
  return promptModal({
    title: opts.title, width: '420px', label: opts.label, hint: opts.hint, input,
    read: () => input.value.trim() || null,
  })
}

const messageBody = (message: string): HTMLElement =>
  el('div', { class: 'hint', style: { fontSize: '13px', color: 'var(--ink)' } }, message)

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
      body: messageBody(message),
      footer: dialogFooter(() => finish(false, close), confirmLabel, () => finish(true, close)),
    }))
  })
}

export function alertDialog(title: string, message: string): void {
  openModal((close) => ({
    title,
    width: '420px',
    body: messageBody(message),
    footer: el('button', { class: 'primary', onclick: close }, 'Close'),
  }))
}

/** Runs `fn`; anything it throws becomes an alert dialog instead of an unhandled rejection - the
 *  shape every "try to do a file thing" in this app ends with. */
export async function guarded(title: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    alertDialog(title, String(err instanceof Error ? err.message : err))
  }
}
