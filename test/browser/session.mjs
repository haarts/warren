/**
 * The shared session: a person in a browser and a command line working on one project.
 *
 * Starts `warren serve` on a scratch project and drives a real browser against it. The unit
 * tests cannot reach this — the interesting failures are races between a save going out and a
 * change coming back, and they only exist when both ends are actually running.
 *
 *   npm run test:session
 */
import puppeteer from 'puppeteer-core'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PORT = Number(process.env.PORT || 5178)
const CHROME = [
  process.env.CHROME_PATH, '/usr/bin/chromium-browser', '/usr/bin/chromium',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
].filter(Boolean).find((p) => existsSync(p))
if (!CHROME) {
  console.error('No Chromium found. Set CHROME_PATH.')
  process.exit(2)
}
if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
  console.error('Nothing built. Run: npm run build')
  process.exit(2)
}

const checks = []
const check = (name, ok, extra = '') => {
  checks.push({ name, ok })
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`)
}

const dir = mkdtempSync(join(tmpdir(), 'warren-session-'))
const file = join(dir, 'p.warren.json')
writeFileSync(file, JSON.stringify({
  version: 1,
  name: 'Session',
  systems: [{ id: 'power.230v', category: 'power', name: '230V group', color: '#ea580c', dash: [], width: 1.7 }],
  assets: {},
  activeSheetId: 's1',
  sheets: [{
    id: 's1', name: 'Ground', mmPerPoint: 20, pdf: null,
    items: [
      { kind: 'run', id: 'r1', systemId: 'power.230v', level: 'wall', flow: 'none', points: [{ x: 0, y: 0 }, { x: 200, y: 0 }] },
      { kind: 'run', id: 'r2', systemId: 'power.230v', level: 'wall', flow: 'none', points: [{ x: 0, y: 80 }, { x: 200, y: 80 }] },
    ],
  }],
}, null, 2))

const warren = (...args) => execFileSync(process.execPath, [join(ROOT, 'bin/warren.ts'), ...args], { cwd: ROOT, encoding: 'utf8' })
const server = spawn(process.execPath, [join(ROOT, 'bin/warren.ts'), 'serve', file, '--port', String(PORT)], { cwd: ROOT, stdio: 'pipe' })
const stop = () => { try { server.kill('SIGTERM') } catch { /* gone */ } }
process.on('exit', stop)

await new Promise((ok, no) => {
  const timer = setTimeout(() => no(new Error('serve did not start')), 20000)
  server.stdout.on('data', (b) => { if (String(b).includes('http://')) { clearTimeout(timer); setTimeout(ok, 300) } })
  server.stderr.on('data', (b) => process.stderr.write(String(b)))
})

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
const onDisk = () => JSON.parse(readFileSync(file, 'utf8')).sheets[0].items
const settle = (ms = 2200) => new Promise((r) => setTimeout(r, ms))

try {
  // SSE holds a request open for the life of the page, so the network is never idle.
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.warren, { timeout: 20000 })
  await page.waitForFunction(() => window.warren.store.items().length === 2, { timeout: 15000 })
  check('the app joins the session with no file dialog',
    await page.evaluate(() => !!window.warren.session && window.warren.store.items().length === 2))

  // --- pointing changes nothing ----------------------------------------------------------
  warren('select', file, '--id', 'r2', '--say', 'this one')
  await settle(900)
  const pointed = await page.evaluate(() => ({
    selected: [...window.warren.store.selection],
    status: document.getElementById('status-text')?.textContent ?? '',
    rev: window.warren.session.rev,
  }))
  check('select highlights in the window and says why',
    pointed.selected.length === 1 && pointed.selected[0] === 'r2' && /this one/.test(pointed.status), pointed.status)
  check('and costs no revision', pointed.rev === 1, `rev ${pointed.rev}`)

  // --- an edit from the command line arrives ------------------------------------------------
  writeFileSync(join(dir, 'ops.json'), JSON.stringify({ ops: [{ op: 'set', id: 'r1', patch: { label: 'g1 · koelkast' } }] }))
  warren('apply', file, join(dir, 'ops.json'))
  await settle()
  check('an edit made at the command line appears in the window',
    await page.evaluate(() => window.warren.store.item('r1')?.label === 'g1 · koelkast'))
  check('and the selection survives it',
    await page.evaluate(() => window.warren.store.selection.has('r2')))

  // --- the regression: two edits in quick succession -------------------------------------------
  // The browser used to reload its own echo, and a reload replaces the whole project — so
  // anything typed between a save going out and the reload landing was destroyed.
  await page.evaluate(() => {
    window.__traffic = []
    const s = window.warren.session
    const f = s.flush.bind(s); s.flush = async (p) => { window.__traffic.push('POST'); return f(p) }
    const l = s.load.bind(s); s.load = async () => { window.__traffic.push('GET'); return l() }
  })
  await page.evaluate(() => {
    const a = window.warren
    a.store.mutate(() => { a.store.item('r2').label = 'Tepehuis' })
  })
  await settle(780)
  await page.evaluate(() => {
    const a = window.warren
    a.store.mutate(() => { a.store.item('r2').size = '5×6mm²' })
  })
  await settle(2600)

  const edited = await page.evaluate(() => {
    const it = window.warren.store.item('r2')
    return { label: it?.label, size: it?.size, traffic: window.__traffic.join(' ') }
  })
  const saved = onDisk().find((i) => i.id === 'r2')
  check('both fields of a quick two-part edit survive',
    edited.label === 'Tepehuis' && edited.size === '5×6mm²', JSON.stringify(edited))
  check('the browser and the file agree',
    saved?.label === edited.label && saved?.size === edited.size,
    JSON.stringify({ label: saved?.label, size: saved?.size }))
  check('and a window does not reload its own change',
    !edited.traffic.includes('GET'), edited.traffic)

  // --- a genuine remote change still lands ---------------------------------------------------
  writeFileSync(join(dir, 'ops2.json'), JSON.stringify({ ops: [{ op: 'set', id: 'r1', patch: { note: 'from the CLI' } }] }))
  warren('apply', file, join(dir, 'ops2.json'))
  await settle()
  check('a change from elsewhere is still taken',
    await page.evaluate(() => window.warren.store.item('r1')?.note === 'from the CLI'))

  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '))
} finally {
  await browser.close()
  stop()
  rmSync(dir, { recursive: true, force: true })
}

const failed = checks.filter((c) => !c.ok).length
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
process.exit(failed ? 1 : 0)
