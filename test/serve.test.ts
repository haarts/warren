import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '../bin/serve.ts'
import { planOps } from '../bin/warren.ts'
import { Store } from '../src/model/doc.ts'
import type { Project } from '../src/model/types.ts'

/** A project on disk with one calibrated sheet and a run to point at. */
function fixture(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'warren-serve-'))
  const project = {
    version: 1,
    name: 'Served',
    systems: [{ id: 'power.230v', category: 'power', name: '230V group', color: '#ea580c', dash: [], width: 1.7 }],
    assets: {},
    activeSheetId: 's1',
    sheets: [{
      id: 's1', name: 'Ground', mmPerPoint: 20, pdf: null,
      items: [
        { kind: 'run', id: 'r1', systemId: 'power.230v', level: 'wall', flow: 'none', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
        { kind: 'run', id: 'r2', systemId: 'power.230v', level: 'wall', flow: 'none', points: [{ x: 0, y: 50 }, { x: 100, y: 50 }] },
      ],
    }],
  }
  const file = join(dir, 'p.warren.json')
  writeFileSync(file, JSON.stringify(project, null, 2))
  return { dir, file }
}

/** The same wiring the serve command uses, so the tests exercise the real validators. */
const options = (file: string) => ({
  projectPath: file,
  port: 0,
  root: join(import.meta.dirname, '..', 'dist'),
  hydrate: async (): Promise<string[]> => [],
  applyOps: (project: Project, store: Store, ops: unknown[], as: string | null) => {
    const plan = planOps(project, store, ops as never[], as ? { rule: as, from: 'apply' } : null)
    return {
      problems: plan.problems,
      describe: plan.describe,
      commit: () => { for (const apply of plan.planned) apply() },
    }
  },
})

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 600))

test('the server hands over the project it is holding', async () => {
  const { file } = fixture()
  const s = await serve(options(file))
  try {
    const body = await (await fetch(`http://127.0.0.1:${s.port}/api/project`)).json() as { rev: number; project: Project }
    assert.equal(body.rev, 1)
    assert.equal(body.project.sheets[0].items.length, 2)
  } finally {
    s.close()
  }
})

test('ops are validated exactly as apply would, and a bad batch writes nothing', async () => {
  const { file } = fixture()
  const before = readFileSync(file, 'utf8')
  const s = await serve(options(file))
  try {
    const bad = await fetch(`http://127.0.0.1:${s.port}/api/ops`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ops: [
        { op: 'set', id: 'r1', patch: { label: 'fine' } },
        { op: 'set', id: 'nope', patch: { label: 'no such item' } },
      ] }),
    })
    assert.equal(bad.status, 422)
    const { problems } = await bad.json() as { problems: string[] }
    assert.match(problems[0], /nope/)
    await settle()
    assert.equal(readFileSync(file, 'utf8'), before, 'one bad op means none of them applied')
  } finally {
    s.close()
  }
})

test('a good batch lands in the file and bumps the revision', async () => {
  const { file } = fixture()
  const s = await serve(options(file))
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}/api/ops`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ops: [{ op: 'set', id: 'r1', patch: { label: 'g1 · koelkast' } }] }),
    })
    assert.equal(res.status, 200)
    assert.equal((await res.json() as { rev: number }).rev, 2)
    await settle()
    assert.match(readFileSync(file, 'utf8'), /g1 · koelkast/)
  } finally {
    s.close()
  }
})

test('a dry run says what it would do and changes nothing', async () => {
  const { file } = fixture()
  const s = await serve(options(file))
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}/api/ops`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: true, ops: [{ op: 'set', id: 'r1', patch: { label: 'x' } }] }),
    })
    const body = await res.json() as { rev: number; describe: string[]; applied: number }
    assert.equal(body.rev, 1, 'no revision bump')
    assert.equal(body.applied, 0)
    assert.equal(body.describe.length, 1)
    await settle()
    assert.doesNotMatch(readFileSync(file, 'utf8'), /"label": "x"/)
  } finally {
    s.close()
  }
})

test('a write from a stale revision is refused rather than clobbering', async () => {
  const { file } = fixture()
  const s = await serve(options(file))
  try {
    const base = `http://127.0.0.1:${s.port}`
    const { project } = await (await fetch(`${base}/api/project`)).json() as { project: Project }
    // Somebody else changes it first.
    await fetch(`${base}/api/ops`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ops: [{ op: 'set', id: 'r2', patch: { label: 'theirs' } }] }),
    })
    // Now a save built on the older revision arrives.
    const stale = await fetch(`${base}/api/project`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rev: 1, project }),
    })
    assert.equal(stale.status, 409, 'merging two drawings is not something to guess at')
    await settle()
    assert.match(readFileSync(file, 'utf8'), /theirs/, 'and the newer change survives')
  } finally {
    s.close()
  }
})

test('pointing changes nothing at all', async () => {
  const { file } = fixture()
  const s = await serve(options(file))
  try {
    const base = `http://127.0.0.1:${s.port}`
    const before = readFileSync(file, 'utf8')
    const res = await fetch(`${base}/api/select`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['r1'], say: 'this one' }),
    })
    assert.equal(res.status, 200)
    const { rev } = await (await fetch(`${base}/api/project`)).json() as { rev: number }
    assert.equal(rev, 1, 'a gesture is not a revision')
    await settle()
    assert.equal(readFileSync(file, 'utf8'), before)
  } finally {
    s.close()
  }
})

test('a change reaches a listener over the event stream', async () => {
  const { file } = fixture()
  const s = await serve(options(file))
  const base = `http://127.0.0.1:${s.port}`
  const seen: string[] = []
  const ac = new AbortController()
  try {
    const stream = await fetch(`${base}/api/events`, { signal: ac.signal })
    const reader = stream.body!.getReader()
    const decoder = new TextDecoder()
    const pump = (async () => {
      while (seen.length < 2) {
        const { value, done } = await reader.read()
        if (done) break
        for (const line of decoder.decode(value).split('\n')) {
          if (line.startsWith('event: ')) seen.push(line.slice(7))
        }
      }
    })()
    await new Promise((r) => setTimeout(r, 150))
    await fetch(`${base}/api/select`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: ['r1'] }),
    })
    await Promise.race([pump, new Promise((r) => setTimeout(r, 3000))])
    assert.deepEqual(seen, ['hello', 'select'])
  } finally {
    ac.abort()
    s.close()
  }
})

test('the served app cannot be used to read outside its directory', async () => {
  const { file } = fixture()
  const s = await serve(options(file))
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}/../../../etc/passwd`, { redirect: 'manual' })
    assert.ok(res.status === 403 || res.status === 200, `got ${res.status}`)
    if (res.status === 200) {
      // A normalised path lands on the app's index, never on the filesystem above the root.
      assert.doesNotMatch(await res.text(), /root:/)
    }
  } finally {
    s.close()
  }
})
