/**
 * End-to-end smoke test: drives the real app in a real browser.
 *
 * Starts `vite dev`, then exercises the paths that unit tests cannot reach - pdf.js rendering,
 * canvas hit-testing, pointer drags, IndexedDB autosave, PNG export and the print view.
 *
 *   npm run test:browser
 *
 * Needs a Chromium binary (set CHROME_PATH to override detection) and puppeteer-core.
 */
import puppeteer from 'puppeteer-core'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PORT = Number(process.env.PORT || 5179)
const BASE = `http://127.0.0.1:${PORT}/`

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable', '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)
const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p))
if (!chromePath) {
  console.error('No Chromium found. Set CHROME_PATH to a Chrome or Chromium binary.')
  process.exit(2)
}

const checks = []
const check = (name, ok, extra = '') => {
  checks.push({ name, ok })
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`)
}

// --- dev server -----------------------------------------------------------------------
const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
})
const stopServer = () => { try { server.kill('SIGTERM') } catch { /* already gone */ } }
process.on('exit', stopServer)

await new Promise((ready, fail) => {
  const timer = setTimeout(() => fail(new Error('vite did not start in 30s')), 30_000)
  const onData = (buf) => {
    if (/Local:|ready in/i.test(String(buf))) { clearTimeout(timer); ready() }
  }
  server.stdout.on('data', onData)
  server.stderr.on('data', onData)
})
await new Promise((r) => setTimeout(r, 500))

const PDF = readFileSync(resolve(ROOT, 'samples/sample-floorplan.pdf')).toString('base64')

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1500, height: 950 })

const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))

try {
  await page.goto(BASE, { waitUntil: 'networkidle0' })
  await page.waitForFunction(() => !!window.warren, { timeout: 15_000 })
  check('app boots', true)

  // --- import a PDF page --------------------------------------------------------------
  await page.evaluate(async (b64) => {
    // Mirrors what File > Import PDF does: cache the bytes by hash, reference them in the
    // project. The bytes never go into the project file.
    const { cacheAsset } = await import('/src/io/assetCache.ts')
    const app = window.warren
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const digest = await crypto.subtle.digest('SHA-256', bytes.buffer)
    const id = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
    await cacheAsset(id, b64)
    app.store.project.assets[id] = { name: 'sample-floorplan.pdf', bytes: bytes.length }
    await app.attachPage(id, 1, 'current', 'sample-floorplan.pdf')
  }, PDF)
  await page.waitForFunction(() => window.warren.store.sheet.pdf?.widthPt > 100, { timeout: 15_000 })
  const size = await page.evaluate(() => {
    const p = window.warren.store.sheet.pdf
    return `${p.widthPt}×${p.heightPt}`
  })
  check('PDF page attached at its true point size', size === '842×595', size)

  await new Promise((r) => setTimeout(r, 1500))
  const darkSamples = await page.evaluate(() => {
    const c = document.getElementById('canvas')
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    let dark = 0
    for (let i = 0; i < data.length; i += 4 * 97) if (data[i] < 200) dark++
    return dark
  })
  check('the plan is painted on the canvas', darkSamples > 20, `${darkSamples} dark samples`)

  const rect = await page.evaluate(() => {
    const r = document.getElementById('canvas').getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  const at = (fx, fy) => ({ x: rect.x + rect.w * fx, y: rect.y + rect.h * fy })
  const items = () => page.evaluate(() => window.warren.store.items().map((i) => ({ ...i })))
  const selectionSizeOf = () => page.evaluate(() => window.warren.store.selection.size)

  // --- draw a three-corner run ----------------------------------------------------------
  await page.keyboard.press('l')
  for (const [fx, fy] of [[0.25, 0.30], [0.55, 0.30], [0.55, 0.62]]) {
    const p = at(fx, fy)
    await page.mouse.move(p.x, p.y)
    await page.mouse.click(p.x, p.y)
  }
  await page.keyboard.press('Enter')
  let list = await items()
  check('run drawn with three corners', list.length === 1 && list[0].points.length === 3, `${list.length} item(s)`)
  check('the run inherits the system default size', list[0]?.size === 'Ø16', String(list[0]?.size))

  // --- clicking one segment selects the whole run, and dragging moves all of it ----------
  await page.keyboard.press('v')
  const onSegment = at(0.40, 0.30)
  await page.mouse.click(onSegment.x, onSegment.y)
  check('clicking one segment selects the whole run',
    (await page.evaluate(() => window.warren.store.selection.size)) === 1)

  const before = (await items())[0].points
  await page.mouse.move(onSegment.x, onSegment.y)
  await page.mouse.down()
  await page.mouse.move(onSegment.x + 60, onSegment.y + 40, { steps: 8 })
  await page.mouse.up()
  const after = (await items())[0].points
  const d = after.map((p, i) => ({ dx: p.x - before[i].x, dy: p.y - before[i].y }))
  check('dragging a segment moves every corner together',
    d.every((v) => Math.abs(v.dx - d[0].dx) < 1e-6 && Math.abs(v.dy - d[0].dy) < 1e-6) && Math.abs(d[0].dx) > 1,
    `Δ ${d[0].dx.toFixed(1)}, ${d[0].dy.toFixed(1)}`)

  // --- dragging one corner handle moves only that corner ---------------------------------
  const handle = await page.evaluate(() => {
    const app = window.warren
    const p = app.store.items()[0].points[1]
    const r = document.getElementById('canvas').getBoundingClientRect()
    return { x: r.x + app.editor.cam.toScreenX(p.x), y: r.y + app.editor.cam.toScreenY(p.y) }
  })
  const beforeV = (await items())[0].points
  await page.mouse.move(handle.x, handle.y)
  await page.mouse.down()
  await page.mouse.move(handle.x + 45, handle.y - 35, { steps: 6 })
  await page.mouse.up()
  const afterV = (await items())[0].points
  const moved = afterV.map((p, i) => (Math.hypot(p.x - beforeV[i].x, p.y - beforeV[i].y) > 0.5 ? i : -1)).filter((i) => i >= 0)
  check('dragging a corner handle moves only that corner', moved.length === 1 && moved[0] === 1, `moved ${moved}`)

  // --- undo / redo -------------------------------------------------------------------------
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
  check('undo restores the corner',
    Math.hypot((await items())[0].points[1].x - beforeV[1].x, (await items())[0].points[1].y - beforeV[1].y) < 1e-6)
  await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.keyboard.press('z')
  await page.keyboard.up('Shift'); await page.keyboard.up('Control')
  check('redo reapplies it',
    Math.hypot((await items())[0].points[1].x - afterV[1].x, (await items())[0].points[1].y - afterV[1].y) < 1e-6)

  // --- alt+click inserts and removes corners ------------------------------------------------
  const mid = await page.evaluate(() => {
    const app = window.warren
    const pts = app.store.items()[0].points
    const r = document.getElementById('canvas').getBoundingClientRect()
    return {
      x: r.x + app.editor.cam.toScreenX((pts[0].x + pts[1].x) / 2),
      y: r.y + app.editor.cam.toScreenY((pts[0].y + pts[1].y) / 2),
    }
  })
  await page.keyboard.down('Alt')
  await page.mouse.click(mid.x, mid.y)
  await page.keyboard.up('Alt')
  check('Alt+click on a segment inserts a corner', (await items())[0].points.length === 4)
  await page.keyboard.down('Alt')
  await page.mouse.click(mid.x, mid.y)
  await page.keyboard.up('Alt')
  check('Alt+click on a corner removes it', (await items())[0].points.length === 3)

  // --- box and marker tools -------------------------------------------------------------------
  await page.keyboard.press('r')
  const boxA = at(0.68, 0.20)
  const boxB = at(0.80, 0.34)
  await page.mouse.move(boxA.x, boxA.y)
  await page.mouse.down()
  await page.mouse.move(boxB.x, boxB.y, { steps: 6 })
  await page.mouse.up()
  check('box tool creates an equipment box', (await items()).filter((i) => i.kind === 'box').length === 1)

  await page.keyboard.press('m')
  const markerAt = at(0.35, 0.55)
  await page.mouse.click(markerAt.x, markerAt.y)
  const markers = (await items()).filter((i) => i.kind === 'marker')
  check('marker tool places the selected symbol', markers.length === 1 && markers[0].symbol === 'riser-up',
    markers[0]?.symbol)

  // --- rubber-band selection --------------------------------------------------------------------
  await page.keyboard.press('v')
  await page.keyboard.press('Escape')
  const bandA = at(0.05, 0.05)
  const bandB = at(0.95, 0.95)
  await page.mouse.move(bandA.x, bandA.y)
  await page.mouse.down()
  await page.mouse.move(bandB.x, bandB.y, { steps: 10 })
  await page.mouse.up()
  check('rubber band selects everything it covers',
    (await page.evaluate(() => window.warren.store.selection.size)) === 3)
  await page.keyboard.press('Escape')

  // --- a drainage run guesses its fall, and says that it guessed ---------------------------------
  await page.evaluate(() => { window.warren.editor.activeSystemId = 'drain.soil' })
  await page.keyboard.press('l')
  for (const [fx, fy] of [[0.30, 0.72], [0.62, 0.72]]) {
    const p = at(fx, fy)
    await page.mouse.move(p.x, p.y)
    await page.mouse.click(p.x, p.y)
  }
  await page.keyboard.press('Enter')
  const drain = await page.evaluate(() => {
    const r = window.warren.store.items().filter((i) => i.systemId === 'drain.soil').pop()
    return { flow: r?.flow, assumed: r?.flowAssumed, id: r?.id }
  })
  check('a drain run takes its direction from the order it was drawn',
    drain.flow === 'forward' && drain.assumed === true, `${drain.flow}, assumed=${drain.assumed}`)

  await page.keyboard.press('v')
  const confirmed = await page.evaluate(async (id) => {
    const app = window.warren
    app.store.selection.clear()
    app.store.selection.add(id)
    app.store.touch(false)
    app.refresh()
    await new Promise((r) => setTimeout(r, 120))
    const btn = [...document.querySelectorAll('.tab-body button')].find((b) => b.textContent === 'It is right')
    const offered = !!btn
    btn?.click()
    await new Promise((r) => setTimeout(r, 80))
    const run = app.store.item(id)
    return { offered, flow: run.flow, assumed: run.flowAssumed }
  }, drain.id)
  check('confirming keeps the direction and drops the guess',
    confirmed.offered && confirmed.flow === 'forward' && confirmed.assumed === undefined,
    JSON.stringify(confirmed))

  // A power circuit gets no arrow at all - an arrow there would be noise.
  await page.evaluate(() => { window.warren.editor.activeSystemId = 'power.socket' })
  await page.keyboard.press('l')
  for (const [fx, fy] of [[0.30, 0.80], [0.62, 0.80]]) {
    const p = at(fx, fy)
    await page.mouse.move(p.x, p.y)
    await page.mouse.click(p.x, p.y)
  }
  await page.keyboard.press('Enter')
  check('a socket circuit does not sprout an arrow', await page.evaluate(() => {
    const r = window.warren.store.items().filter((i) => i.systemId === 'power.socket').pop()
    return r?.flow === 'none' && r?.flowAssumed === undefined
  }))
  await page.keyboard.press('v')
  await page.keyboard.press('Escape')
  await page.evaluate(() => { window.warren.editor.activeSystemId = 'water.cold' })

  // --- the size field is a dropdown that still takes anything ---------------------------------
  const runId = (await items()).find((i) => i.kind === 'run').id
  const selectRun = async () => {
    await page.evaluate((id) => {
      const app = window.warren
      app.store.selection.clear()
      app.store.selection.add(id)
      app.store.touch(false)
      app.refresh()
    }, runId)
    await new Promise((r) => setTimeout(r, 120))
  }
  const sizeField = async () => page.evaluate(() => {
    const input = [...document.querySelectorAll('.tab-body input[type=text]')]
      .find((i) => i.getAttribute('list')?.startsWith('sizes-'))
    if (!input) return null
    const list = document.getElementById(input.getAttribute('list'))
    return { value: input.value, options: [...(list?.options ?? [])].map((o) => o.value) }
  })
  await selectRun()
  let sz = await sizeField()
  check('the size field offers the system\'s common sizes',
    !!sz && sz.options[0] === 'Ø16' && sz.options.includes('Ø25') && sz.value === 'Ø16',
    sz ? sz.options.join(' ') : 'no datalist')

  // Switch the run to a power system and the suggestions follow it.
  await page.evaluate((id) => {
    const app = window.warren
    app.store.mutate(() => {
      const run = app.store.item(id)
      run.systemId = 'power.socket'
      run.size = app.store.system('power.socket').defaultSize
    })
  }, runId)
  await selectRun()
  sz = await sizeField()
  check('a socket group defaults to 3×2.5mm² with the other gauges listed',
    sz?.value === '3×2.5mm²' && sz.options[0] === '3×2.5mm²' && sz.options.includes('3×4mm²'),
    sz ? sz.options.join(' ') : 'no datalist')

  await page.evaluate((id) => {
    const app = window.warren
    app.store.mutate(() => { app.store.item(id).systemId = 'power.3ph' })
  }, runId)
  await selectRun()
  sz = await sizeField()
  check('three-phase offers 5×2.5 through 5×16',
    sz?.options[0] === '5×2.5mm²' && sz.options.includes('5×6mm²') && sz.options.includes('5×16mm²'),
    sz ? sz.options.join(' ') : 'no datalist')

  // Free text still wins: the list is a suggestion, not a constraint.
  await page.evaluate(() => {
    const input = [...document.querySelectorAll('.tab-body input[type=text]')]
      .find((i) => i.getAttribute('list')?.startsWith('sizes-'))
    input.value = '5×35mm² Al'
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  check('a size that is not on the list is still accepted',
    await page.evaluate((id) => window.warren.store.item(id).size === '5×35mm² Al', runId))

  await page.evaluate((id) => {
    const app = window.warren
    app.store.mutate(() => {
      const run = app.store.item(id)
      run.systemId = 'water.cold'
      run.size = 'Ø16'
    })
  }, runId)
  await page.keyboard.press('Escape')

  // --- connections are derived, and checks stay behind a tab you open --------------------------
  // This section zooms around, and later checks click fixed screen positions, so put the view
  // back exactly where it was afterwards.
  const savedCam = await page.evaluate(() => ({ x: window.warren.editor.cam.x, y: window.warren.editor.cam.y, zoom: window.warren.editor.cam.zoom }))
  const topo = await page.evaluate(async () => {
    const { buildGraph, connectionsOf, networkOf } = await import('/src/topology.ts')
    const app = window.warren
    const sheet = app.store.sheet
    const g = buildGraph(sheet)
    const runs = sheet.items.filter((i) => i.kind === 'run')
    return {
      tolerance: g.tolerance,
      networks: g.networks.length,
      freeEnds: g.freeEnds.length,
      firstRunJoins: connectionsOf(g, runs[0].id).length,
      lonely: networkOf(g, runs[0].id)?.items.length,
    }
  })
  check('drawn-apart runs are read as separate networks, not one merged blob',
    topo.networks >= 2 && topo.freeEnds > 0 && topo.tolerance < 1,
    `${topo.networks} networks, ${topo.freeEnds} free ends, tol ${topo.tolerance.toFixed(2)} pt`)

  // Draw one run that deliberately starts exactly where another ends.
  const joinPoint = await page.evaluate(() => {
    const app = window.warren
    const run = app.store.items().find((i) => i.kind === 'run')
    const p = run.points[run.points.length - 1]
    const r = document.getElementById('canvas').getBoundingClientRect()
    return { x: r.x + app.editor.cam.toScreenX(p.x), y: r.y + app.editor.cam.toScreenY(p.y), id: run.id }
  })
  await page.keyboard.press('l')
  await page.mouse.move(joinPoint.x, joinPoint.y)
  await page.mouse.click(joinPoint.x, joinPoint.y)
  await page.mouse.move(joinPoint.x + 90, joinPoint.y + 60)
  await page.mouse.click(joinPoint.x + 90, joinPoint.y + 60)
  await page.keyboard.press('Enter')
  await page.keyboard.press('v')

  const joined = await page.evaluate(async (id) => {
    const { buildGraph, connectionsOf, networkOf } = await import('/src/topology.ts')
    const g = buildGraph(window.warren.store.sheet)
    return { joins: connectionsOf(g, id).length, network: networkOf(g, id)?.items.length }
  }, joinPoint.id)
  check('snapping to an end makes a real connection', joined.joins >= 1 && joined.network >= 2,
    `${joined.joins} joined, network of ${joined.network}`)

  // Properties offers it as navigation, not as a complaint.
  const netButton = await page.evaluate(async (id) => {
    const app = window.warren
    app.store.selection.clear()
    app.store.selection.add(id)
    app.store.touch(false)
    app.refresh()
    await new Promise((r) => setTimeout(r, 140))
    const btn = [...document.querySelectorAll('.tab-body button')].find((b) => /Select all \d+ joined/.test(b.textContent))
    const label = btn?.textContent ?? ''
    btn?.click()
    await new Promise((r) => setTimeout(r, 80))
    return { label, selected: app.store.selection.size }
  }, joinPoint.id)
  check('Properties can select the whole connected network', netButton.selected >= 2, netButton.label)
  await page.keyboard.press('Escape')

  const checkTab = await page.evaluate(async () => {
    const tabs = [...document.querySelectorAll('#panel .tabs button')].map((b) => b.textContent)
    const before = document.querySelector('.tab-body')?.textContent ?? ''
    ;[...document.querySelectorAll('#panel .tabs button')].find((b) => b.textContent === 'Check').click()
    await new Promise((r) => setTimeout(r, 200))
    const after = document.querySelector('.tab-body')?.textContent ?? ''
    ;[...document.querySelectorAll('#panel .tabs button')].find((b) => b.textContent === 'Properties').click()
    return { tabs, mentionedBefore: /second pair of eyes/.test(before), after }
  })
  check('checks live behind a tab and say nothing until opened',
    checkTab.tabs.includes('Check') && !checkTab.mentionedBefore && /second pair of eyes/.test(checkTab.after),
    checkTab.tabs.join('/'))
  check('the Check tab is worded as help, not as a telling-off',
    /not a set of rules/.test(checkTab.after) && !/error|invalid|must/i.test(checkTab.after.slice(0, 220)))

  await page.evaluate((cam) => {
    Object.assign(window.warren.editor.cam, cam)
    window.warren.editor.requestRender()
  }, savedCam)
  await new Promise((r) => setTimeout(r, 120))

  // --- the CAD habits an architect arrives with ---------------------------------------------------
  const cad = await page.evaluate(async () => {
    const app = window.warren
    const buttons = () => [...document.querySelectorAll('#modes button')]
    const modes = () => buttons().map((b) => `${b.textContent}:${b.classList.contains('on') ? 'on' : 'off'}`).join(' ')
    const before = modes()
    for (const key of ['F8', 'F3', 'F7']) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    }
    await new Promise((r) => setTimeout(r, 120))
    const after = modes()
    // And the buttons are toggles too, not just readouts.
    buttons()[0].click()
    await new Promise((r) => setTimeout(r, 120))
    return { before, after, clicked: modes(), ortho: app.store.project.settings.orthoLock }
  })
  check('F8, F3 and F7 flip ortho, snap and grid', cad.before === 'ORTHO:off SNAP:on GRID:off'
    && cad.after === 'ORTHO:on SNAP:off GRID:on', `${cad.before}  ->  ${cad.after}`)
  check('and the status bar toggles are clickable', /ORTHO:off/.test(cad.clicked) && cad.ortho === false)

  // Ortho latched means a run snaps to 45 degrees without holding Shift.
  const latched = await page.evaluate(async () => {
    const { resolvePoint } = await import('/src/interact/snap.ts')
    const app = window.warren
    app.store.project.settings.snapToItems = false
    app.store.project.settings.orthoLock = true
    const free = resolvePoint(app.store, { x: 200, y: 13 }, 5, { anchor: { x: 0, y: 0 }, ortho: true })
    app.store.project.settings.orthoLock = false
    app.store.project.settings.snapToItems = true
    return free.point
  })
  check('latched ortho constrains without a modifier held', Math.abs(latched.y) < 0.001,
    `y ${latched.y.toFixed(3)}`)

  // Middle double-click is Zoom Extents. Driven through the real mouse, because a synthetic
  // pointer event has no pointer id for setPointerCapture to find.
  const cadCam = await page.evaluate(() => ({ x: window.warren.editor.cam.x, y: window.warren.editor.cam.y, zoom: window.warren.editor.cam.zoom }))
  await page.evaluate(() => {
    window.warren.editor.cam.zoom = 12
    window.warren.editor.cam.x = -500
    window.warren.editor.requestRender()
  })
  await page.mouse.move(400, 300)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.up({ button: 'middle' })
  await page.mouse.down({ button: 'middle' })
  await page.mouse.up({ button: 'middle' })
  await new Promise((r) => setTimeout(r, 200))
  const extents = await page.evaluate(() => window.warren.editor.cam.zoom)
  check('middle double-click zooms to extents', extents < 5, `zoom ${extents.toFixed(2)}`)
  await page.evaluate((cam) => {
    Object.assign(window.warren.editor.cam, cam)
    window.warren.editor.requestRender()
  }, cadCam)
  await new Promise((r) => setTimeout(r, 120))

  // --- a wheel zooms, two fingers pan ------------------------------------------------------------
  // Scrolling moves the view, and later checks click fixed screen positions, so put it back.
  const wheelCam = await page.evaluate(() => ({ x: window.warren.editor.cam.x, y: window.warren.editor.cam.y, zoom: window.warren.editor.cam.zoom }))
  const wheelTest = await page.evaluate(async () => {
    const app = window.warren
    const canvas = document.getElementById('canvas')
    const fire = (init) => canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 400, clientY: 300, ...init }))
    const snap = () => ({ x: app.editor.cam.x, y: app.editor.cam.y, z: app.editor.cam.zoom })
    const moved = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) > 0.5

    // A wheel mouse: whole lines, no sideways movement.
    const a = snap()
    fire({ deltaY: -3, deltaMode: 1 })
    await new Promise((r) => setTimeout(r, 40))
    const b = snap()

    // A trackpad: small pixel deltas, and sideways movement a wheel cannot make.
    fire({ deltaY: 12, deltaX: 7, deltaMode: 0 })
    await new Promise((r) => setTimeout(r, 40))
    const c = snap()
    fire({ deltaY: 20, deltaX: 0, deltaMode: 0 })
    await new Promise((r) => setTimeout(r, 40))
    const d = snap()

    // Pinch arrives as ctrl+wheel and must still zoom.
    fire({ deltaY: -8, deltaMode: 0, ctrlKey: true })
    await new Promise((r) => setTimeout(r, 40))
    const e = snap()
    return {
      wheelZoomed: b.z > a.z,
      trackpadPanned: c.z === b.z && moved(b, c),
      staysPanning: d.z === c.z && moved(c, d),
      pinchZoomed: e.z > d.z,
      hint: document.getElementById('status-text').textContent,
    }
  })
  check('a wheel mouse zooms', wheelTest.wheelZoomed)
  check('two fingers pan instead of zooming', wheelTest.trackpadPanned)
  check('and keep panning once the trackpad is recognised', wheelTest.staysPanning)
  check('a pinch still zooms', wheelTest.pinchZoomed)
  check('the status line says what the trackpad does', /two fingers pan/.test(wheelTest.hint || ''),
    (wheelTest.hint || '').slice(-46))
  await page.evaluate((cam) => {
    Object.assign(window.warren.editor.cam, cam)
    window.warren.editor.requestRender()
  }, wheelCam)
  await new Promise((r) => setTimeout(r, 120))

  // --- a room corner drags like any other corner ------------------------------------------------
  const roomCam = await page.evaluate(() => ({ x: window.warren.editor.cam.x, y: window.warren.editor.cam.y, zoom: window.warren.editor.cam.zoom }))
  const roomHandle = await page.evaluate(async () => {
    const app = window.warren
    app.store.sheet.items.push({
      kind: 'room', id: 'resize-me', systemId: 'struct.room', level: 'floor',
      name: 'Test', use: 'bedroom',
      points: [{ x: 500, y: 500 }, { x: 700, y: 500 }, { x: 700, y: 640 }, { x: 500, y: 640 }],
    })
    app.store.selection.clear()
    app.store.selection.add('resize-me')
    app.editor.zoomToSelection()
    app.store.touch(false)
    await new Promise((r) => setTimeout(r, 150))
    const corner = app.store.item('resize-me').points[1]
    const r = document.getElementById('canvas').getBoundingClientRect()
    return { x: r.x + app.editor.cam.toScreenX(corner.x), y: r.y + app.editor.cam.toScreenY(corner.y) }
  })
  await page.mouse.move(roomHandle.x, roomHandle.y)
  await page.mouse.down()
  await page.mouse.move(roomHandle.x + 55, roomHandle.y + 35, { steps: 6 })
  await page.mouse.up()
  const resized = await page.evaluate(() => {
    const p = window.warren.store.item('resize-me').points
    return { n: p.length, moved: p.filter((q, i) => (i === 1 ? Math.hypot(q.x - 700, q.y - 500) > 2 : false)).length,
             others: p.filter((q, i) => i !== 1).map((q) => `${Math.round(q.x)},${Math.round(q.y)}`).join(' ') }
  })
  check('dragging a room corner moves that corner',
    resized.moved === 1 && resized.others === '500,500 700,640 500,640', resized.others)

  // A room is closed, so the edge back to the first corner takes a new corner too.
  const grew = await page.evaluate(async () => {
    const app = window.warren
    const pts = app.store.item('resize-me').points
    const r = document.getElementById('canvas').getBoundingClientRect()
    const mid = { x: (pts[3].x + pts[0].x) / 2, y: (pts[3].y + pts[0].y) / 2 }
    return { x: r.x + app.editor.cam.toScreenX(mid.x), y: r.y + app.editor.cam.toScreenY(mid.y) }
  })
  await page.keyboard.down('Alt')
  await page.mouse.click(grew.x, grew.y)
  await page.keyboard.up('Alt')
  check('Alt+click on the closing edge adds a corner there',
    (await page.evaluate(() => window.warren.store.item('resize-me').points.length)) === 5)

  // But a room never shrinks below a triangle.
  const floor = await page.evaluate(async () => {
    const app = window.warren
    while (app.store.item('resize-me').points.length > 3) {
      app.store.activeVertex = { itemId: 'resize-me', index: 0 }
      app.editor.deleteSelectionOrVertex()
    }
    // One more: aiming at a corner must not take the whole room with it.
    app.store.activeVertex = { itemId: 'resize-me', index: 0 }
    app.editor.deleteSelectionOrVertex()
    await new Promise((r) => setTimeout(r, 60))
    const still = app.store.item('resize-me')
    return { corners: still ? still.points.length : 0, said: document.getElementById('status-text').textContent }
  })
  check('a room will not be whittled below three corners', floor.corners === 3, `${floor.corners} corners`)
  check('and it says why instead of deleting the room', /three corners/.test(floor.said || ''), floor.said)

  await page.evaluate((cam) => {
    const app = window.warren
    app.store.sheet.items = app.store.sheet.items.filter((i) => i.id !== 'resize-me')
    app.store.selection.clear()
    app.store.activeVertex = null
    Object.assign(app.editor.cam, cam)
    app.store.touch(false)
  }, roomCam)
  await new Promise((r) => setTimeout(r, 120))

  // --- naming the project -------------------------------------------------------------------
  const projectName = () => page.evaluate(() => window.warren.store.project.name)
  check('a new project starts as Untitled', (await projectName()) === 'Untitled')
  await page.evaluate(() => document.querySelector('.brand small').click())
  await page.waitForSelector('.brand input', { timeout: 3000 })
  await page.evaluate(() => {
    const input = document.querySelector('.brand input')
    input.value = 'Aarts services'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  check('clicking the title renames the project', (await projectName()) === 'Aarts services', await projectName())
  check('the rename lands in the window title',
    /Aarts services/.test(await page.title()), await page.title())
  check('renaming is undoable', await page.evaluate(() => {
    window.warren.store.undo()
    return window.warren.store.project.name === 'Untitled'
  }))
  await page.evaluate(() => window.warren.store.redo())

  // --- sticky notes ------------------------------------------------------------------------------
  await page.keyboard.press('n')
  const noteAt = at(0.20, 0.70)
  await page.mouse.click(noteAt.x, noteAt.y)
  const noteId = await page.evaluate(() => window.warren.store.items().find((i) => i.kind === 'note')?.id)
  const note = () => page.evaluate((id) => ({ ...window.warren.store.item(id) }), noteId)
  let n = await note()
  check('note tool places a sticky sized from the sheet', !!noteId && n.w >= 60 && n.w <= 240 && n.text === '',
    `w ${Math.round(n.w)} pt`)
  check('a new note is tied to the active system', n.systemId === 'water.cold', n.systemId)

  await page.type('.tab-body textarea', 'Check duct height with the architect before the pour')
  await page.evaluate(() => document.querySelector('.tab-body textarea').blur())
  n = await note()
  check('typing in Properties fills the sticky', /architect/.test(n.text), `${n.text.length} chars`)

  await page.keyboard.press('v')
  await page.keyboard.press('Escape')
  await page.mouse.click(noteAt.x + 12, noteAt.y + 10)
  check('clicking the note body selects it', (await selectionSizeOf()) === 1)

  // The one handle a note has: bottom-right, width only.
  const noteHandle = await page.evaluate(async (id) => {
    const { noteHeight } = await import('/src/render/notes.ts')
    const app = window.warren
    const item = app.store.item(id)
    const r = document.getElementById('canvas').getBoundingClientRect()
    return {
      x: r.x + app.editor.cam.toScreenX(item.x + item.w),
      y: r.y + app.editor.cam.toScreenY(item.y + noteHeight(item)),
    }
  }, noteId)
  const beforeNote = await note()
  await page.mouse.move(noteHandle.x, noteHandle.y)
  await page.mouse.down()
  await page.mouse.move(noteHandle.x + 40, noteHandle.y + 25, { steps: 6 })
  await page.mouse.up()
  n = await note()
  check('the note handle changes width only',
    n.w > beforeNote.w + 5 && n.x === beforeNote.x && n.y === beforeNote.y, `w ${Math.round(n.w)} pt`)

  await page.keyboard.press('Escape')
  await page.evaluate(() => {
    ;[...document.querySelectorAll('#toolbar button')].find((b) => b.textContent === 'Notes').click()
  })
  await page.mouse.click(noteAt.x + 12, noteAt.y + 10)
  check('hiding notes also stops them being clickable', (await selectionSizeOf()) === 0)
  await page.evaluate(() => {
    ;[...document.querySelectorAll('#toolbar button')].find((b) => b.textContent === 'Notes').click()
  })
  await page.keyboard.press('Escape')

  // --- lock is reversible, and a locked item explains itself -----------------------------------
  const panelButton = (label) => page.evaluate((l) => {
    const btn = [...document.querySelectorAll('.tab-body button')].find((b) => b.textContent.startsWith(l))
    if (!btn) return false
    btn.click()
    return true
  }, label)
  const markerId = (await items()).find((i) => i.kind === 'marker').id
  const isLocked = () => page.evaluate((id) => window.warren.store.item(id)?.locked === true, markerId)

  await page.mouse.click(markerAt.x, markerAt.y)
  check('the marker is selectable before locking', (await selectionSizeOf()) === 1)
  check('Lock button found', await panelButton('Lock'))
  check('locking marks the item locked', await isLocked())

  // The reported bug: Unlock did nothing because it ran through the same gate lock disables.
  check('Unlock works while the item is still selected', (await panelButton('Unlock')) && !(await isLocked()))

  await panelButton('Lock')
  await page.keyboard.press('Escape')
  await page.mouse.click(markerAt.x, markerAt.y)
  check('a locked item cannot be clicked', (await selectionSizeOf()) === 0)

  await page.mouse.move(markerAt.x + 3, markerAt.y + 3)
  await new Promise((r) => setTimeout(r, 200))
  const lockedHint = await page.evaluate(() => document.getElementById('status-text').textContent)
  check('hovering a locked item says why it will not select', /locked item/.test(lockedHint || ''),
    (lockedHint || '').slice(-60))

  check('Unlock all is offered once something is locked', await panelButton('Unlock all'))
  check('unlock all makes it selectable again', !(await isLocked()))
  await page.mouse.click(markerAt.x, markerAt.y)
  check('the marker selects again after unlocking', (await selectionSizeOf()) === 1)
  await page.keyboard.press('Escape')

  // --- calibrate against the printed 10000 mm dimension --------------------------------------------
  await page.keyboard.press('k')
  const dim = await page.evaluate(() => {
    const app = window.warren
    const r = document.getElementById('canvas').getBoundingClientRect()
    const y = 595 - 96
    return {
      a: { x: r.x + app.editor.cam.toScreenX(120), y: r.y + app.editor.cam.toScreenY(y) },
      b: { x: r.x + app.editor.cam.toScreenX(620), y: r.y + app.editor.cam.toScreenY(y) },
    }
  })
  await page.mouse.click(dim.a.x, dim.a.y)
  await page.mouse.click(dim.b.x, dim.b.y)
  await page.waitForSelector('.dialog input[type=number]', { timeout: 5000 })
  await page.type('.dialog input[type=number]', '10000')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => window.warren.store.sheet.mmPerPoint !== null, { timeout: 5000 })
  const mmPerPoint = await page.evaluate(() => window.warren.store.sheet.mmPerPoint)
  check('calibration resolves to 20 mm per point', Math.abs(mmPerPoint - 20) < 0.5, mmPerPoint.toFixed(3))

  const takeoff = await page.evaluate(async () => {
    const { computeTakeoff } = await import('/src/takeoff.ts')
    const rows = computeTakeoff(window.warren.store, 'sheet').rows.filter((r) => r.runs > 0)
    return rows.map((r) => ({ id: r.system.id, m: r.lengthMm / 1000, order: r.orderMm / 1000 }))
  })
  const cold = takeoff.find((r) => r.id === 'water.cold')
  check('takeoff reports real metres', !!cold && cold.m > 1 && cold.order > cold.m,
    `cold water ${cold?.m.toFixed(2)} m plan, ${cold?.order.toFixed(2)} m to order, ${takeoff.length} systems`)

  // --- hiding a layer also removes it from editing --------------------------------------------------
  check('hiding a layer makes its items unclickable', await page.evaluate(() => {
    const app = window.warren
    const run = app.store.items().find((i) => i.kind === 'run')
    const sys = app.store.project.systems.find((s) => s.id === run.systemId)
    sys.visible = false
    app.store.invalidateSystems()
    const editable = app.store.isEditable(run)
    sys.visible = true
    app.store.invalidateSystems()
    return editable === false
  }))

  // --- copy the selection to another sheet ------------------------------------------------------------
  const copied = await page.evaluate(() => {
    const app = window.warren
    app.addSheet()
    const second = app.store.project.sheets[1].id
    app.store.setActiveSheet(app.store.project.sheets[0].id)
    app.store.selection.clear()
    for (const i of app.store.items()) app.store.selection.add(i.id)
    app.duplicateSelectionToSheet(second)
    return app.store.project.sheets[1].items.length
  })
  check('copy-to-sheet duplicates at the same coordinates', copied === 7, `${copied} items`)

  // --- autosave round trip through IndexedDB -------------------------------------------------------------
  const autosave = await page.evaluate(async () => {
    const { writeAutosave, readAutosave, clearAutosave } = await import('/src/io/autosave.ts')
    const app = window.warren
    await writeAutosave(app.store.project, 'demo.warren.json')
    const back = await readAutosave()
    await clearAutosave()
    const gone = await readAutosave()
    return {
      items: back?.project.sheets[0].items.length,
      assets: Object.keys(back?.project.assets ?? {}).length,
      scale: back?.project.sheets[0].mmPerPoint,
      fileName: back?.fileName,
      cleared: gone === null,
    }
  })
  check('autosave survives a round trip through IndexedDB',
    autosave.items === 7 && autosave.assets === 1 && Math.abs(autosave.scale - 20) < 0.5 && autosave.cleared,
    JSON.stringify(autosave))

  // --- a recovery copy written before the rename is still found --------------------------------
  const legacy = await page.evaluate(async () => {
    const { readAutosave, clearAutosave } = await import('/src/io/autosave.ts')
    await clearAutosave()
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('ductwork', 1)
      req.onupgradeneeded = () => {
        req.result.createObjectStore('meta')
        req.result.createObjectStore('assets')
      }
      req.onsuccess = () => {
        const db = req.result
        const t = db.transaction('meta', 'readwrite')
        t.objectStore('meta').put({
          savedAt: 1700000000000,
          fileName: 'old.ductwork.json',
          body: JSON.stringify({
            version: 1, name: 'Recovered from the old name',
            sheets: [{ id: 's', name: 'Sheet', items: [] }], systems: [], settings: {},
          }),
          assetIds: [],
        }, 'current')
        t.oncomplete = () => { db.close(); resolve() }
        t.onerror = () => reject(t.error)
      }
      req.onerror = () => reject(req.error)
    })
    const found = await readAutosave()
    await clearAutosave()
    const afterClear = await readAutosave()
    return { name: found?.project.name, fileName: found?.fileName, cleared: afterClear === null }
  })
  check('an autosave from the old app name is still recovered',
    legacy.name === 'Recovered from the old name' && legacy.fileName === 'old.ductwork.json' && legacy.cleared,
    JSON.stringify(legacy))

  // --- project file round trip ---------------------------------------------------------------------------
  const roundTrip = await page.evaluate(async () => {
    const { serialize, parseProject } = await import('/src/io/projectFile.ts')
    const app = window.warren
    const text = serialize(app.store.project)
    const back = parseProject(text)
    return {
      same: JSON.stringify(back) === JSON.stringify(parseProject(serialize(back))),
      bytes: text.length,
      sheets: back.sheets.length,
    }
  })
  check('project file round trips, without the PDF in it',
    roundTrip.same && roundTrip.sheets === 2 && roundTrip.bytes > 1000, `${roundTrip.bytes} bytes`)

  // The whole point of the reference format: the file is the drawing, not the plan.
  const sizes = await page.evaluate(async () => {
    const { serialize } = await import('/src/io/projectFile.ts')
    const app = window.warren
    const refs = serialize(app.store.project).length
    const bundled = serialize(app.store.project, { bundle: true }).length
    const assets = JSON.parse(serialize(app.store.project)).assets
    const bundledAssets = JSON.parse(serialize(app.store.project, { bundle: true })).assets
    return {
      refs,
      bundled,
      hasData: Object.values(assets).some((a) => 'data' in a),
      bundleHasData: Object.values(bundledAssets).every((a) => typeof a.data === 'string'),
      name: Object.values(assets)[0]?.name,
      bytes: Object.values(assets)[0]?.bytes,
    }
  })
  // The sample plan is barely a kilobyte, so sizes prove little here — what matters is that
  // the bytes are absent by default, present on request, and the reference is descriptive
  // enough to go and find the file again.
  check('a saved project references the plan instead of carrying it',
    !sizes.hasData && sizes.bundleHasData && sizes.name === 'sample-floorplan.pdf' && sizes.bytes > 0 && sizes.bundled > sizes.refs,
    `${sizes.name}, ${sizes.bytes} bytes, ${sizes.bundled - sizes.refs} bytes larger when bundled`)

  // --- PNG export through the File menu ---------------------------------------------------------------------
  const clickMenu = async (label) => {
    await page.evaluate(() => {
      ;[...document.querySelectorAll('#toolbar button')].find((b) => b.textContent.startsWith('File')).click()
    })
    await page.waitForSelector('.menu', { timeout: 3000 })
    await page.evaluate((l) => {
      ;[...document.querySelectorAll('.menu button')].find((b) => b.textContent.includes(l)).click()
    }, label)
    await page.waitForSelector('.dialog', { timeout: 3000 })
  }
  await clickMenu('Export PNG')
  await page.evaluate(() => {
    ;[...document.querySelectorAll('.dialog footer button')].find((b) => b.textContent === 'Export').click()
  })
  await page.waitForFunction(
    () => /Exported \d+×\d+ px/.test(document.getElementById('status-text').textContent || ''),
    { timeout: 30_000 },
  ).catch(() => {})
  const exportStatus = await page.evaluate(() => document.getElementById('status-text').textContent)
  check('PNG export renders the sheet', /Exported \d+×\d+ px/.test(exportStatus || ''), exportStatus)

  // --- print view ---------------------------------------------------------------------------------------------
  await clickMenu('Print')
  await page.evaluate(() => {
    ;[...document.querySelectorAll('.dialog footer button')].find((b) => b.textContent === 'Print').click()
  })
  const printText = await page.waitForFunction(() => {
    for (const frame of document.querySelectorAll('iframe')) {
      const doc = frame.contentDocument
      if (doc && doc.querySelectorAll('img.plan').length === 1) return doc.body.innerText.replace(/\s+/g, ' ')
    }
    return false
  }, { timeout: 40_000, polling: 300 }).then((h) => h.jsonValue()).catch(() => '')
  check('print view carries the plan, legend and takeoff',
    /Legend/.test(printText) && /takeoff/i.test(printText), printText.slice(0, 70))

  // --- backfilling a catalogue that predates a system -------------------------------------------
  const backfill = await page.evaluate(async () => {
    const app = window.warren
    // Simulate a project saved before power.smoke existed.
    app.store.project.systems = app.store.project.systems.filter((s) => s.id !== 'power.smoke')
    app.store.invalidateSystems()
    app.refresh()
    await new Promise((r) => setTimeout(r, 60))
    ;[...document.querySelectorAll('#toolbar button')].find((b) => b.textContent === 'Systems…').click()
    await new Promise((r) => setTimeout(r, 120))
    const btn = [...document.querySelectorAll('.dialog button')].find((b) => /missing default/.test(b.textContent))
    const offered = btn?.textContent ?? ''
    btn?.click()
    await new Promise((r) => setTimeout(r, 120))
    const restored = app.store.project.systems.find((s) => s.id === 'power.smoke')
    const stillOffered = [...document.querySelectorAll('.dialog button')].some((b) => /missing default/.test(b.textContent))
    ;[...document.querySelectorAll('.dialog footer button')].find((b) => b.textContent === 'Done')?.click()
    return { offered, category: restored?.category, stillOffered }
  })
  check('an older catalogue is offered the systems it lacks', /1 missing default system/.test(backfill.offered),
    backfill.offered)
  check('backfilling restores it into the power group',
    backfill.category === 'power' && !backfill.stillOffered, backfill.category)

  // --- rules place things, and editing one protects it ------------------------------------------
  const generated = await page.evaluate(async () => {
    const { generate, applyGenerated, rulesOf, generatedBy } = await import('/src/generate.ts')
    const app = window.warren
    const sheet = app.store.sheet
    // A room a person (or an AI) put there; the rule only supplies the arithmetic.
    sheet.items.push({
      kind: 'room', id: 'demo-room', systemId: 'struct.room', level: 'floor',
      name: 'Keuken', use: 'kitchen',
      points: [{ x: 100, y: 100 }, { x: 400, y: 100 }, { x: 400, y: 300 }, { x: 100, y: 300 }],
    })
    const rule = rulesOf(app.store).find((r) => r.id === 'sockets')
    applyGenerated(sheet, generate(sheet, rule))
    const placed = sheet.items.filter((i) => generatedBy(i)?.rule === 'sockets')
    const first = placed[0]

    // Same rule again: same result, no churn.
    const before = placed.map((i) => `${i.id}@${i.x.toFixed(2)}`).join('|')
    applyGenerated(sheet, generate(sheet, rule))
    const after = sheet.items.filter((i) => generatedBy(i)?.rule === 'sockets')
      .map((i) => `${i.id}@${i.x.toFixed(2)}`).join('|')

    app.store.touch(false)
    return { count: placed.length, idempotent: before === after, id: first.id, x: first.x }
  })
  check('a rule places two sockets on each wall of the room', generated.count === 8, `${generated.count} placed`)

  // Fifty unlabelled markers must not each sprout a pill saying only which level they are on.
  const quiet = await page.evaluate(async () => {
    const { labelTextFor } = await import('/src/render/scene.ts')
    const app = window.warren
    const socket = app.store.items().find((i) => i.generated?.rule === 'sockets')
    const labelled = app.store.items().find((i) => i.kind === 'run' && i.size)
    return { bare: labelTextFor(app.store, socket), withLabel: labelTextFor(app.store, labelled) }
  })
  check('an unlabelled marker draws no pill at all', quiet.bare === '', JSON.stringify(quiet.bare))
  check('but a level still annotates a real label', /·/.test(quiet.withLabel), quiet.withLabel)
  check('running the same rule again changes nothing', generated.idempotent)

  const protectedEdit = await page.evaluate(async (id) => {
    const { generate, applyGenerated, rulesOf, generatedBy } = await import('/src/generate.ts')
    const app = window.warren
    // Drag it the way a person would, through the editor rather than by poking the model.
    app.store.selection.clear()
    app.store.selection.add(id)
    app.editor.nudge(40, 0)
    const moved = app.store.item(id)
    const wasClaimed = generatedBy(moved) === undefined
    const x = moved.x
    const rule = rulesOf(app.store).find((r) => r.id === 'sockets')
    const result = generate(app.store.sheet, rule)
    applyGenerated(app.store.sheet, result)
    app.store.selection.clear()
    app.store.touch(false)
    return { wasClaimed, keptX: app.store.item(id).x === x, leftAlone: result.adopted.length, replaced: result.replace.length }
  }, generated.id)
  check('moving a generated item makes it yours', protectedEdit.wasClaimed)
  check('and re-running the rule leaves it exactly where you put it',
    protectedEdit.keptX && protectedEdit.leftAlone === 1 && protectedEdit.replaced === 7,
    `${protectedEdit.replaced} replaced, ${protectedEdit.leftAlone} left alone`)

  // --- the fallback path explains itself ------------------------------------------------------
  // Reproduce a browser without the File System Access API (Firefox, or any non-secure origin).
  const fallbackHint = await page.evaluate(async () => {
    const saved = window.showSaveFilePicker
    delete window.showSaveFilePicker
    window.warren.refresh()
    await new Promise((r) => setTimeout(r, 60))
    ;[...document.querySelectorAll('#toolbar button')].find((b) => b.textContent.startsWith('File')).click()
    const text = document.querySelector('.menu .hint')?.textContent ?? ''
    document.body.click()
    if (saved) window.showSaveFilePicker = saved
    window.warren.refresh()
    return text
  })
  check('without save-in-place, the File menu says so and why',
    /cannot write over an existing file|not a secure context/.test(fallbackHint),
    fallbackHint.slice(0, 70))

  const realErrors = errors.filter((e) => !/favicon/i.test(e))
  check('no console errors', realErrors.length === 0, realErrors.slice(0, 2).join(' | '))
} finally {
  await browser.close()
  stopServer()
}

const failed = checks.filter((c) => !c.ok).length
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
