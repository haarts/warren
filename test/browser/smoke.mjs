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
    const app = window.warren
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const digest = await crypto.subtle.digest('SHA-256', bytes.buffer)
    const id = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
    app.store.project.assets[id] = b64
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
  check('takeoff reports real metres', takeoff.length === 1 && takeoff[0].m > 1 && takeoff[0].order > takeoff[0].m,
    `${takeoff[0]?.m.toFixed(2)} m plan, ${takeoff[0]?.order.toFixed(2)} m to order`)

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
  check('copy-to-sheet duplicates at the same coordinates', copied === 4, `${copied} items`)

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
    autosave.items === 4 && autosave.assets === 1 && Math.abs(autosave.scale - 20) < 0.5 && autosave.cleared,
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
  check('project file round trips with the PDF embedded',
    roundTrip.same && roundTrip.sheets === 2 && roundTrip.bytes > 1000, `${roundTrip.bytes} bytes`)

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
