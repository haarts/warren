/**
 * A stand-in for a canvas 2D context that writes SVG instead of pixels, so the renderer that
 * draws the screen can also draw a print in vectors: lines stay lines and text stays text, sharp
 * at any zoom of the PDF a browser makes from it.
 *
 * It covers what the renderer uses - paths, arcs, text, images, clipping, transforms, dashes,
 * alpha - and nothing else. Coordinates are transformed into the output frame as they are
 * added, exactly as a canvas does it, so a path built across a transform change comes out the
 * same. Text is measured by a real canvas, in the same browser that will lay out the SVG, so
 * labels sized to fit their text still fit.
 */

type Matrix = [number, number, number, number, number, number]

interface State {
  m: Matrix
  fillStyle: string
  strokeStyle: string
  lineWidth: number
  dash: number[]
  lineDashOffset: number
  globalAlpha: number
  font: string
  textAlign: CanvasTextAlign
  textBaseline: CanvasTextBaseline
  lineCap: CanvasLineCap
  lineJoin: CanvasLineJoin
  miterLimit: number
  /** Clip groups opened since the matching save(), closed again by restore(). */
  groups: number
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

const multiply = (p: Matrix, q: Matrix): Matrix => [
  p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1],
  p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3],
  p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5],
]

const num = (n: number): string => (Math.abs(n) < 1e-9 ? '0' : String(Math.round(n * 1000) / 1000))

function xml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

const BASELINE: Record<CanvasTextBaseline, string> = {
  top: 'text-before-edge', hanging: 'hanging', middle: 'central',
  alphabetic: 'alphabetic', ideographic: 'ideographic', bottom: 'text-after-edge',
}
const ANCHOR: Record<CanvasTextAlign, string> = { left: 'start', start: 'start', center: 'middle', right: 'end', end: 'end' }

let measurer: CanvasRenderingContext2D | null = null

export class SvgContext {
  private state: State = {
    m: [...IDENTITY], fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, dash: [],
    lineDashOffset: 0, globalAlpha: 1, font: '10px sans-serif', textAlign: 'start',
    textBaseline: 'alphabetic', lineCap: 'butt', lineJoin: 'miter', miterLimit: 10, groups: 0,
  }
  private stack: State[] = []
  private body: string[] = []
  private defs: string[] = []
  private d = ''
  /** The current point in user space, for arcTo; null when the path has none. */
  private last: { x: number; y: number } | null = null
  private images = new WeakMap<object, string>()
  private clips = 0

  // Accepted and ignored: they only change how pixels are blended or filtered.
  globalCompositeOperation: GlobalCompositeOperation = 'source-over'
  imageSmoothingEnabled = true
  imageSmoothingQuality: ImageSmoothingQuality = 'high'

  readonly width: number
  readonly height: number

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
  }

  // --- state -----------------------------------------------------------------------------
  get fillStyle(): string { return this.state.fillStyle }
  set fillStyle(v: string) { this.state.fillStyle = String(v) }
  get strokeStyle(): string { return this.state.strokeStyle }
  set strokeStyle(v: string) { this.state.strokeStyle = String(v) }
  get lineWidth(): number { return this.state.lineWidth }
  set lineWidth(v: number) { if (Number.isFinite(v) && v > 0) this.state.lineWidth = v }
  get lineDashOffset(): number { return this.state.lineDashOffset }
  set lineDashOffset(v: number) { this.state.lineDashOffset = v }
  get globalAlpha(): number { return this.state.globalAlpha }
  set globalAlpha(v: number) { if (Number.isFinite(v) && v >= 0 && v <= 1) this.state.globalAlpha = v }
  get font(): string { return this.state.font }
  set font(v: string) { this.state.font = v }
  get textAlign(): CanvasTextAlign { return this.state.textAlign }
  set textAlign(v: CanvasTextAlign) { this.state.textAlign = v }
  get textBaseline(): CanvasTextBaseline { return this.state.textBaseline }
  set textBaseline(v: CanvasTextBaseline) { this.state.textBaseline = v }
  get lineCap(): CanvasLineCap { return this.state.lineCap }
  set lineCap(v: CanvasLineCap) { this.state.lineCap = v }
  get lineJoin(): CanvasLineJoin { return this.state.lineJoin }
  set lineJoin(v: CanvasLineJoin) { this.state.lineJoin = v }
  get miterLimit(): number { return this.state.miterLimit }
  set miterLimit(v: number) { this.state.miterLimit = v }

  setLineDash(dash: number[]): void { this.state.dash = dash.every((n) => Number.isFinite(n) && n >= 0) ? [...dash] : this.state.dash }
  getLineDash(): number[] { return [...this.state.dash] }

  save(): void {
    this.stack.push(this.state)
    this.state = { ...this.state, m: [...this.state.m] as Matrix, dash: [...this.state.dash], groups: 0 }
  }

  restore(): void {
    const prev = this.stack.pop()
    if (!prev) return
    for (let i = 0; i < this.state.groups; i++) this.body.push('</g>')
    this.state = prev
  }

  // --- transforms ------------------------------------------------------------------------
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.state.m = multiply(this.state.m, [a, b, c, d, e, f])
  }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void { this.state.m = [a, b, c, d, e, f] }
  resetTransform(): void { this.state.m = [...IDENTITY] }
  translate(x: number, y: number): void { this.transform(1, 0, 0, 1, x, y) }
  scale(x: number, y: number): void { this.transform(x, 0, 0, y, 0, 0) }
  rotate(a: number): void {
    const c = Math.cos(a), s = Math.sin(a)
    this.transform(c, s, -s, c, 0, 0)
  }

  private pt(x: number, y: number): string {
    const m = this.state.m
    return `${num(m[0] * x + m[2] * y + m[4])} ${num(m[1] * x + m[3] * y + m[5])}`
  }

  /** How much the current transform stretches a length - for line widths and dashes. */
  private stretch(): number {
    const m = this.state.m
    return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1
  }

  // --- paths -----------------------------------------------------------------------------
  beginPath(): void { this.d = ''; this.last = null }

  moveTo(x: number, y: number): void {
    this.d += `M${this.pt(x, y)}`
    this.last = { x, y }
  }

  lineTo(x: number, y: number): void {
    if (!this.last) return this.moveTo(x, y)
    this.d += `L${this.pt(x, y)}`
    this.last = { x, y }
  }

  closePath(): void { if (this.d) this.d += 'Z' }

  rect(x: number, y: number, w: number, h: number): void {
    this.moveTo(x, y)
    this.lineTo(x + w, y)
    this.lineTo(x + w, y + h)
    this.lineTo(x, y + h)
    this.closePath()
    this.last = { x, y }
  }

  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
    if (!this.last) this.moveTo(c1x, c1y)
    this.d += `C${this.pt(c1x, c1y)} ${this.pt(c2x, c2y)} ${this.pt(x, y)}`
    this.last = { x, y }
  }

  /** As cubic Béziers of at most a quarter turn each, so any transform maps it exactly. */
  arc(cx: number, cy: number, r: number, a0: number, a1: number, ccw = false): void {
    const TAU = Math.PI * 2
    let sweep: number
    if (!ccw) sweep = a1 - a0 >= TAU ? TAU : ((((a1 - a0) % TAU) + TAU) % TAU)
    else sweep = a0 - a1 >= TAU ? -TAU : -((((a0 - a1) % TAU) + TAU) % TAU)
    const start = { x: cx + r * Math.cos(a0), y: cy + r * Math.sin(a0) }
    if (this.last) this.lineTo(start.x, start.y)
    else this.moveTo(start.x, start.y)
    const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9))
    const step = sweep / n
    const k = (4 / 3) * Math.tan(step / 4)
    let a = a0
    for (let i = 0; i < n; i++) {
      const b = a + step
      const [ca, sa, cb, sb] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b)]
      this.bezierCurveTo(
        cx + r * (ca - k * sa), cy + r * (sa + k * ca),
        cx + r * (cb + k * sb), cy + r * (sb - k * cb),
        cx + r * cb, cy + r * sb,
      )
      a = b
    }
  }

  /** The canvas arcTo: a line towards (x1,y1), turning on a circle of radius r towards (x2,y2). */
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void {
    const p0 = this.last
    if (!p0) return this.moveTo(x1, y1)
    const v1 = { x: p0.x - x1, y: p0.y - y1 }
    const v2 = { x: x2 - x1, y: y2 - y1 }
    const l1 = Math.hypot(v1.x, v1.y)
    const l2 = Math.hypot(v2.x, v2.y)
    const cross = v1.x * v2.y - v1.y * v2.x
    if (r === 0 || l1 === 0 || l2 === 0 || Math.abs(cross) < 1e-9) return this.lineTo(x1, y1)
    const cos = (v1.x * v2.x + v1.y * v2.y) / (l1 * l2)
    const half = Math.acos(Math.max(-1, Math.min(1, cos))) / 2
    const t = r / Math.tan(half)
    const t1 = { x: x1 + (v1.x / l1) * t, y: y1 + (v1.y / l1) * t }
    const t2 = { x: x1 + (v2.x / l2) * t, y: y1 + (v2.y / l2) * t }
    // The centre sits on the bisector, r / sin(half) from the corner.
    const bis = { x: v1.x / l1 + v2.x / l2, y: v1.y / l1 + v2.y / l2 }
    const bl = Math.hypot(bis.x, bis.y)
    const dc = r / Math.sin(half)
    const c = { x: x1 + (bis.x / bl) * dc, y: y1 + (bis.y / bl) * dc }
    this.lineTo(t1.x, t1.y)
    this.arc(c.x, c.y, r, Math.atan2(t1.y - c.y, t1.x - c.x), Math.atan2(t2.y - c.y, t2.x - c.x), cross > 0)
  }

  // --- painting --------------------------------------------------------------------------
  private alphaAttr(): string {
    return this.state.globalAlpha < 1 ? ` opacity="${num(this.state.globalAlpha)}"` : ''
  }

  private strokeAttrs(): string {
    const s = this.state
    const k = this.stretch()
    const dash = s.dash.length ? ` stroke-dasharray="${(s.dash.length % 2 ? [...s.dash, ...s.dash] : s.dash).map((n) => num(n * k)).join(' ')}"` : ''
    const offset = s.dash.length && s.lineDashOffset ? ` stroke-dashoffset="${num(s.lineDashOffset * k)}"` : ''
    return ` stroke="${xml(s.strokeStyle)}" stroke-width="${num(s.lineWidth * k)}" stroke-linecap="${s.lineCap}"`
      + ` stroke-linejoin="${s.lineJoin}" stroke-miterlimit="${num(s.miterLimit)}"${dash}${offset}`
  }

  fill(rule: CanvasFillRule = 'nonzero'): void {
    if (!this.d) return
    const fr = rule === 'evenodd' ? ' fill-rule="evenodd"' : ''
    this.body.push(`<path d="${this.d}" fill="${xml(this.state.fillStyle)}"${fr}${this.alphaAttr()}/>`)
  }

  stroke(): void {
    if (!this.d) return
    this.body.push(`<path d="${this.d}" fill="none"${this.strokeAttrs()}${this.alphaAttr()}/>`)
  }

  clip(rule: CanvasFillRule = 'nonzero'): void {
    const id = `clip${++this.clips}`
    const fr = rule === 'evenodd' ? ' clip-rule="evenodd"' : ''
    this.defs.push(`<clipPath id="${id}"><path d="${this.d || 'M0 0'}"${fr}/></clipPath>`)
    this.body.push(`<g clip-path="url(#${id})">`)
    this.state.groups += 1
  }

  /** Paints a rectangle without touching the path being built. */
  private rectPath(x: number, y: number, w: number, h: number): string {
    return `M${this.pt(x, y)}L${this.pt(x + w, y)}L${this.pt(x + w, y + h)}L${this.pt(x, y + h)}Z`
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.body.push(`<path d="${this.rectPath(x, y, w, h)}" fill="${xml(this.state.fillStyle)}"${this.alphaAttr()}/>`)
  }

  strokeRect(x: number, y: number, w: number, h: number): void {
    this.body.push(`<path d="${this.rectPath(x, y, w, h)}" fill="none"${this.strokeAttrs()}${this.alphaAttr()}/>`)
  }

  /** Paper is painted over it straight after; an SVG starts out empty anyway. */
  clearRect(): void {}

  // --- text ------------------------------------------------------------------------------
  measureText(text: string): TextMetrics {
    if (!measurer) measurer = document.createElement('canvas').getContext('2d')
    measurer!.font = this.state.font
    return measurer!.measureText(text)
  }

  private text(text: string, x: number, y: number, paint: string): void {
    const s = this.state
    const m = multiply(s.m, [1, 0, 0, 1, x, y])
    this.body.push(`<text transform="matrix(${m.map(num).join(' ')})" style="font: ${xml(s.font)}; white-space: pre"`
      + ` text-anchor="${ANCHOR[s.textAlign]}" dominant-baseline="${BASELINE[s.textBaseline]}"${paint}${this.alphaAttr()}>${xml(text)}</text>`)
  }

  fillText(text: string, x: number, y: number): void {
    this.text(text, x, y, ` fill="${xml(this.state.fillStyle)}"`)
  }

  strokeText(text: string, x: number, y: number): void {
    // Matrix already scales the glyphs, so the width is the canvas one, unstretched.
    const s = this.state
    this.text(text, x, y, ` fill="none" stroke="${xml(s.strokeStyle)}" stroke-width="${num(s.lineWidth)}" stroke-linejoin="${s.lineJoin}"`)
  }

  // --- images ----------------------------------------------------------------------------
  private href(src: CanvasImageSource): string {
    const cached = this.images.get(src as object)
    if (cached) return cached
    let url: string
    if (src instanceof HTMLCanvasElement) url = src.toDataURL('image/png')
    else if (src instanceof HTMLImageElement) url = src.src
    else {
      const c = document.createElement('canvas')
      const w = (src as { width: number }).width
      const h = (src as { height: number }).height
      c.width = w
      c.height = h
      c.getContext('2d')!.drawImage(src, 0, 0)
      url = c.toDataURL('image/png')
    }
    this.images.set(src as object, url)
    return url
  }

  drawImage(src: CanvasImageSource, ...a: number[]): void {
    const iw = (src as { width: number }).width
    const ih = (src as { height: number }).height
    let [sx, sy, sw, sh, dx, dy, dw, dh] = [0, 0, iw, ih, 0, 0, iw, ih]
    if (a.length === 2) [dx, dy] = a
    else if (a.length === 4) [dx, dy, dw, dh] = a
    else if (a.length === 8) [sx, sy, sw, sh, dx, dy, dw, dh] = a
    else return
    if (!sw || !sh || !dw || !dh) return
    // The destination box in user space, with the source window mapped onto it.
    const m = multiply(this.state.m, [dw / sw, 0, 0, dh / sh, dx - (sx * dw) / sw, dy - (sy * dh) / sh])
    const crop = a.length === 8
    if (crop) {
      const id = `clip${++this.clips}`
      this.defs.push(`<clipPath id="${id}"><path d="${this.rectPath(dx, dy, dw, dh)}"/></clipPath>`)
      this.body.push(`<g clip-path="url(#${id})">`)
    }
    this.body.push(`<image href="${this.href(src)}" width="${iw}" height="${ih}" preserveAspectRatio="none"`
      + ` transform="matrix(${m.map(num).join(' ')})"${this.alphaAttr()}/>`)
    if (crop) this.body.push('</g>')
  }

  // --- out -------------------------------------------------------------------------------
  /** The drawing so far, as a standalone SVG document of the given size. */
  toSvg(): string {
    const open = this.stack.reduce((n, s) => n + s.groups, this.state.groups)
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(this.width)} ${num(this.height)}" preserveAspectRatio="xMidYMin meet"`
      + ` width="${num(this.width)}" height="${num(this.height)}">`
      + `<defs>${this.defs.join('')}</defs>${this.body.join('')}${'</g>'.repeat(open)}</svg>`
  }
}

/** For handing to a renderer that expects the real thing; it touches only what is above. */
export const asCanvasContext = (c: SvgContext): CanvasRenderingContext2D => c as unknown as CanvasRenderingContext2D
