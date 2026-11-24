import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SvgContext } from '../src/render/svgContext.ts'

const paths = (svg: string): string[] => [...svg.matchAll(/<path d="([^"]*)"/g)].map((m) => m[1])

test('points are transformed as they are added, as on a canvas', () => {
  const c = new SvgContext(100, 100)
  c.beginPath()
  c.moveTo(1, 1)
  c.translate(10, 0)
  c.lineTo(1, 1) // under the new transform
  c.stroke()
  assert.deepEqual(paths(c.toSvg()), ['M1 1L11 1'])
})

test('line width and dashes are scaled with the drawing, so a print matches the screen', () => {
  const c = new SvgContext(100, 100)
  c.scale(4, 4)
  c.lineWidth = 0.5
  c.setLineDash([2, 1])
  c.beginPath()
  c.moveTo(0, 0)
  c.lineTo(10, 0)
  c.stroke()
  const svg = c.toSvg()
  assert.match(svg, /stroke-width="2"/)
  assert.match(svg, /stroke-dasharray="8 4"/)
  assert.match(svg, /d="M0 0L40 0"/)
})

test('a full circle is four exact quarter curves, closed back on its start', () => {
  const c = new SvgContext(100, 100)
  c.beginPath()
  c.arc(50, 50, 10, 0, Math.PI * 2)
  c.fill()
  const [d] = paths(c.toSvg())
  assert.equal((d.match(/C/g) ?? []).length, 4)
  assert.ok(d.startsWith('M60 50'))
  assert.ok(d.endsWith('60 50'))
})

test('arcTo turns a corner on the given radius', () => {
  const c = new SvgContext(100, 100)
  c.beginPath()
  c.moveTo(0, 0)
  c.arcTo(10, 0, 10, 10, 2)
  c.stroke()
  const [d] = paths(c.toSvg())
  assert.match(d, /^M0 0L8 0(L8 0)?C9.105 0 10 0.895 10 2$/, 'tangent at (8,0), centre (8,2), out at (10,2)')
})

test('a clip lasts until the restore that matches its save', () => {
  const c = new SvgContext(100, 100)
  c.save()
  c.beginPath()
  c.rect(0, 0, 10, 10)
  c.clip()
  c.fillRect(0, 0, 50, 50)
  c.restore()
  c.fillRect(0, 0, 5, 5)
  const svg = c.toSvg()
  assert.match(svg, /<clipPath id="clip1"><path d="M0 0L10 0L10 10L0 10Z"\/><\/clipPath>/)
  assert.match(svg, /<g clip-path="url\(#clip1\)"><path[^>]*\/><\/g><path/)
})

test('text stays text, positioned and aligned like canvas text', () => {
  const c = new SvgContext(100, 100)
  c.font = '600 7px sans-serif'
  c.textAlign = 'center'
  c.textBaseline = 'middle'
  c.fillStyle = '#123456'
  c.globalAlpha = 0.5
  c.fillText('Ø16 <warm> & "koud"', 20, 30)
  const svg = c.toSvg()
  assert.match(svg, /<text transform="matrix\(1 0 0 1 20 30\)" style="font: 600 7px sans-serif; white-space: pre" text-anchor="middle" dominant-baseline="central" fill="#123456" opacity="0.5">Ø16 &lt;warm&gt; &amp; &quot;koud&quot;<\/text>/)
})
