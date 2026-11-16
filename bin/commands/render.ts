/**
 * A picture of part of a sheet: the plan with the drawing on top, optionally with a metre grid
 * numbered in the same metres `items` and `apply` use. It is how a model - or anyone at a
 * terminal - looks at what is drawn before deciding where the next thing goes.
 *
 * Node has no canvas, so this starts a throwaway server for the built app's render.html, opens
 * it in headless Chrome and lets the app's own painter do the drawing. A render is therefore
 * exactly what the window would show.
 */
import { createServer, type Server } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve, sep } from 'node:path'
import { boundsOf, type Rect } from '../../src/geom.ts'
import { assetData } from '../../src/model/assets.ts'
import { serialize } from '../../src/io/projectFile.ts'
import { base64ToBytes } from '../../src/io/base64.ts'
import { itemBounds } from '../../src/render/bounds.ts'
import type { Sheet } from '../../src/model/types.ts'
import { fail, type Args } from '../args.ts'
import { load } from '../project.ts'
import { defaultRoot } from '../serve.ts'
import { metres, pointsFromMetres, round, sheetOf } from '../units.ts'

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable', '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
}

/** Longest side of the picture when nothing else says how big. Readable, and cheap to look at. */
const DEFAULT_PX = 1600
const MAX_PX = 8000
const GRID_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10]

export async function cmdRender(args: Args): Promise<void> {
  const { project, path, missingAssets } = await load(args)
  const flags = args.flags

  const sheets = sheetOf(project, flags.sheet)
  if (sheets.length === 0) fail(`no sheet matching "${String(flags.sheet)}"`)
  const sheet = sheets[0]
  const page = { w: sheet.pdf?.widthPt ?? 842, h: sheet.pdf?.heightPt ?? 595 }

  const region = regionFor(sheet, page, flags)
  const longest = Math.max(region.w, region.h)
  let scale: number
  if (typeof flags['px-per-m'] === 'string') {
    const ppm = Number(flags['px-per-m'])
    if (!(ppm > 0)) fail('--px-per-m must be a positive number')
    if (!sheet.mmPerPoint) fail(`"${sheet.name}" has no scale, so --px-per-m means nothing; use --width`)
    scale = (ppm * sheet.mmPerPoint!) / 1000
  } else {
    const px = typeof flags.width === 'string' ? Number(flags.width) : DEFAULT_PX
    if (!(px > 0)) fail('--width must be a positive number of pixels')
    scale = px / longest
  }
  if (longest * scale > MAX_PX) scale = MAX_PX / longest

  let gridM: number | null = null
  if (flags.grid !== undefined) {
    if (!sheet.mmPerPoint) fail(`"${sheet.name}" has no scale, so a metre grid means nothing there`)
    if (typeof flags.grid === 'string') {
      gridM = Number(flags.grid)
      if (!(gridM > 0)) fail('--grid takes a spacing in metres, e.g. --grid 0.5')
    } else {
      // About a dozen lines across the longer side.
      const spanM = metres(sheet, longest)!
      gridM = GRID_STEPS.find((s) => spanM / s <= 14) ?? GRID_STEPS[GRID_STEPS.length - 1]
    }
  }

  const highlight = typeof flags.id === 'string' && flags['no-highlight'] !== true
    ? flags.id.split(',').map((s) => s.trim()).filter(Boolean)
    : []
  const plan = flags['no-plan'] !== true
  if (plan && sheet.pdf && missingAssets.includes(sheet.pdf.assetId)) {
    console.error(`note: the plan PDF for "${sheet.name}" was not found beside the project; drawing without it`)
  }

  const out = typeof flags.out === 'string' ? flags.out : `${basename(path, '.warren.json')}-render.png`
  const request = {
    project: serialize(project),
    sheetId: sheet.id,
    region,
    scale,
    plan,
    gridM,
    highlight,
    // Labels sized for reading the picture at its own size, a little larger when it is big.
    uiScale: Math.max(1, Math.round(longest * scale / DEFAULT_PX * 10) / 10),
  }

  const png = await drawInChrome(request, sheet)
  writeFileSync(out, png)

  const corner = [metres(sheet, region.x), metres(sheet, region.y)]
  const size = [metres(sheet, region.w), metres(sheet, region.h)]
  const report = {
    out: resolve(out),
    sheet: sheet.name,
    px: [Math.round(region.w * scale), Math.round(region.h * scale)],
    fromM: corner[0] === null ? null : [round(corner[0]!), round(corner[1]!)],
    sizeM: size[0] === null ? null : [round(size[0]!), round(size[1]!)],
    pxPerM: sheet.mmPerPoint ? round((scale * 1000) / sheet.mmPerPoint, 1) : null,
    gridM,
  }
  if (flags.json) return void console.log(JSON.stringify(report, null, 2))
  const where = report.fromM ? ` — ${report.sizeM!.join(' × ')} m from ${report.fromM.join(', ')} m` : ''
  console.log(`wrote ${out}: ${report.px.join('×')} px of ${sheet.name}${where}${gridM ? `, grid every ${gridM} m` : ''}`)
}

/** The part of the sheet asked for, in points: around a spot, around some items, or the whole page. */
function regionFor(sheet: Sheet, page: { w: number; h: number }, flags: Args['flags']): Rect {
  const m = (v: number, what: string): number => {
    const pt = pointsFromMetres(sheet, v)
    if (pt === null) fail(`"${sheet.name}" has no scale, so ${what} in metres means nothing there`)
    return pt!
  }
  const pair = (raw: unknown, what: string): [number, number] => {
    const parts = String(raw).split(',').map(Number)
    if (parts.length === 1 && isFinite(parts[0])) return [parts[0], parts[0]]
    if (parts.length !== 2 || !parts.every(isFinite)) fail(`${what} is "x,y" in metres`)
    return [parts[0], parts[1]]
  }

  if (flags.around !== undefined) {
    const [cx, cy] = pair(flags.around, '--around')
    const [w, h] = flags.sizeM !== undefined ? pair(flags.sizeM, '--sizeM') : [6, 6]
    if (!(w > 0 && h > 0)) fail('--sizeM must be positive')
    return { x: m(cx - w / 2, '--around'), y: m(cy - h / 2, '--around'), w: m(w, '--sizeM'), h: m(h, '--sizeM') }
  }
  if (typeof flags.id === 'string') {
    const ids = flags.id.split(',').map((s) => s.trim()).filter(Boolean)
    const items = sheet.items.filter((i) => ids.includes(i.id))
    const unknown = ids.filter((id) => !items.some((i) => i.id === id))
    if (unknown.length) fail(`not on "${sheet.name}": ${unknown.join(', ')} — pass --sheet if they are on another`)
    const corners = items.flatMap((i) => {
      const b = itemBounds(i)
      return [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y + b.h }]
    })
    const b = boundsOf(corners)
    // Enough around them to see what they sit in: a metre, or a quarter of their spread.
    const pad = Math.max(sheet.mmPerPoint ? 1000 / sheet.mmPerPoint : 30, Math.max(b.w, b.h) * 0.25)
    return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 }
  }
  return { x: 0, y: 0, w: page.w, h: page.h }
}

async function drawInChrome(request: object, sheet: Sheet): Promise<Buffer> {
  const root = defaultRoot()
  if (!existsSync(join(root, 'render.html'))) {
    fail(`no built render page at ${root}. Run: npm run build`)
  }
  const chrome = CHROME_CANDIDATES.find((p): p is string => !!p && existsSync(p))
  if (!chrome) fail('render needs Chrome or Chromium; none found. Set CHROME_PATH to its binary.')

  let puppeteer: typeof import('puppeteer-core').default
  try {
    puppeteer = (await import('puppeteer-core')).default
  } catch {
    fail('render needs the puppeteer-core package: npm install puppeteer-core')
  }

  const assetId = sheet.pdf?.assetId
  const server = await serveOnce(root, (route) => {
    if (route === '/__render/request') return { type: MIME['.json'], body: JSON.stringify(request) }
    if (assetId && route === `/__render/asset/${assetId}`) {
      const data = assetData(assetId)
      return { type: 'application/pdf', body: data ? Buffer.from(base64ToBytes(data)) : Buffer.alloc(0) }
    }
    return null
  })
  const port = (server.address() as { port: number }).port
  const browser = await puppeteer!.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  try {
    const tab = await browser.newPage()
    const errors: string[] = []
    tab.on('pageerror', (e) => errors.push(e instanceof Error ? e.message : String(e)))
    await tab.goto(`http://127.0.0.1:${port}/render.html`, { waitUntil: 'load' })
    await tab.waitForFunction(() => window.warrenReady === true, { timeout: 20_000 })
      .catch(() => fail(`the render page did not start${errors.length ? `: ${errors[0]}` : ''}`))
    const base64 = await tab.evaluate(() => window.warrenRender())
    return Buffer.from(base64, 'base64')
  } finally {
    await browser.close()
    server.close()
  }
}

type Extra = (route: string) => { type: string; body: string | Buffer } | null

/** The built app, plus whatever this one render needs, on a port nobody else is using. */
function serveOnce(root: string, extra: Extra): Promise<Server> {
  const server = createServer((req, res) => {
    const route = new URL(req.url ?? '/', 'http://x').pathname
    const special = extra(route)
    if (special) {
      res.writeHead(200, { 'content-type': special.type })
      return void res.end(special.body)
    }
    const file = resolve(join(root, route))
    if ((!file.startsWith(root + sep)) || !existsSync(file)) {
      res.writeHead(404)
      return void res.end()
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)))
}

declare global {
  interface Window {
    warrenRender: () => Promise<string>
    warrenReady: boolean
  }
}
