type Child = Node | string | null | undefined | false

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, unknown>> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = String(value)
    else if (key === 'style') Object.assign(node.style, value as object)
    else if (key === 'dataset') Object.assign(node.dataset, value as object)
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener)
    } else if (key in node) {
      ;(node as unknown as Record<string, unknown>)[key] = value
    } else {
      node.setAttribute(key, String(value))
    }
  }
  append(node, children)
  return node
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

export function field(label: string, control: Node, hint?: string): HTMLElement {
  const wrap = el('div', { class: 'field' }, el('label', {}, label), control as HTMLElement)
  if (hint) wrap.appendChild(el('div', { class: 'hint', style: { gridColumn: '2' } }, hint))
  return wrap
}

/**
 * A `<select>` built from `[value, label]` pairs. `value` is the value all selected items agree
 * on, or `''` for "they disagree" - which this shows as no option picked, the same way a mixed
 * text field would show blank rather than guess one answer.
 */
export function select(
  options: readonly (readonly [string, string])[], value: string, onChange: (v: string) => void,
): HTMLSelectElement {
  const node = el('select', {
    onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value),
  }) as HTMLSelectElement
  for (const [v, text] of options) node.appendChild(el('option', { value: v, selected: v === value }, text))
  if (!options.some(([v]) => v === value)) node.value = ''
  return node
}

/** Same as {@link select}, but grouped into `<optgroup>`s - for pickers organised by category,
 *  like the system list. */
export function groupedSelect(
  groups: readonly { heading: string; options: readonly (readonly [string, string])[] }[],
  value: string, onChange: (v: string) => void,
): HTMLSelectElement {
  const node = el('select', {
    onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value),
  }) as HTMLSelectElement
  for (const g of groups) {
    if (!g.options.length) continue
    const group = el('optgroup', { label: g.heading })
    for (const [v, text] of g.options) group.appendChild(el('option', { value: v, selected: v === value }, text))
    node.appendChild(group)
  }
  if (!groups.some((g) => g.options.some(([v]) => v === value))) node.value = ''
  return node
}

export function textInput(value: string, onChange: (v: string) => void, placeholder?: string): HTMLInputElement {
  const input = el('input', { type: 'text', value, placeholder: placeholder ?? '' }) as HTMLInputElement
  input.addEventListener('change', () => onChange(input.value))
  return input
}

export function numberInput(value: number, onChange: (v: number) => void): HTMLInputElement {
  const input = el('input', { type: 'number', value: String(value), step: '0.1' }) as HTMLInputElement
  input.addEventListener('change', () => onChange(Number(input.value) || 0))
  return input
}

/**
 * A text field with a suggestion list attached (`<datalist>`): pick a common value from the
 * dropdown, or type anything else. Used where a closed list would be wrong - a run's spec is
 * "usually one of these", never "only ever one of these".
 */
export function comboInput(
  value: string, options: string[], placeholder: string | undefined, key: string, onChange: (v: string) => void,
): HTMLElement {
  const input = el('input', {
    type: 'text', value, placeholder: placeholder ?? '',
    title: options.length ? 'Pick a common size from the list, or type anything you like' : '',
  }) as HTMLInputElement
  input.addEventListener('change', () => onChange(input.value.trim()))
  if (options.length === 0) return input

  const listId = `sizes-${key.replace(/\W+/g, '-')}`
  input.setAttribute('list', listId)
  const datalist = el('datalist', { id: listId })
  for (const o of options) datalist.appendChild(el('option', { value: o }))
  return el('div', { style: { display: 'contents' } }, input, datalist)
}

/** Little preview of a system's colour, dash pattern and width. */
export function swatch(color: string, dash: number[], width: number): HTMLElement {
  const canvas = document.createElement('canvas')
  const w = 26
  const h = 12
  const dpr = window.devicePixelRatio || 1
  canvas.width = w * dpr
  canvas.height = h * dpr
  canvas.style.width = `${w}px`
  canvas.style.height = `${h}px`
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.scale(dpr, dpr)
    ctx.strokeStyle = color
    ctx.lineWidth = Math.max(1.2, Math.min(4, width))
    ctx.lineCap = 'round'
    ctx.setLineDash(dash.map((d) => Math.max(1, d * 0.7)))
    ctx.beginPath()
    ctx.moveTo(1, h / 2)
    ctx.lineTo(w - 1, h / 2)
    ctx.stroke()
  }
  return el('span', { class: 'swatch' }, canvas)
}
