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
