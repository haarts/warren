/**
 * Gets a project onto the page and back off it again. Every command starts with `load` and, if
 * it writes, ends with `persist` — the pair that decides whether a running `warren serve` is
 * holding the drawing (route through it, so a person's window updates) or nothing is (read and
 * write the file directly).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { bytesToBase64, sha256Hex } from '../src/io/base64.ts'
import { parseProject, serialize } from '../src/io/projectFile.ts'
import { registerAsset } from '../src/model/assets.ts'
import { Store } from '../src/model/doc.ts'
import type { Project } from '../src/model/types.ts'
import { fail, type Args } from './args.ts'

export interface Loaded {
  path: string
  project: Project
  store: Store
  /** Asset ids whose bytes could not be found on disk. */
  missingAssets: string[]
  /** Base URL of the server holding this project, when one is running. */
  server: string | null
  /** The revision that came with it, so a write can refuse to clobber a newer one. */
  rev: number | null
}

/**
 * Finds the bytes for each referenced asset next to the project file: by its recorded name,
 * by `<hash>.pdf`, or under `assets/`. The hash is always verified, so a name collision
 * cannot silently attach the wrong plan.
 */
export async function resolveAssets(project: Project, projectPath: string, assetDir?: string): Promise<string[]> {
  const here = assetDir ? resolve(assetDir) : dirname(resolve(projectPath))
  const missing: string[] = []
  for (const [id, ref] of Object.entries(project.assets)) {
    if (ref.data) {
      registerAsset(id, ref.data)
      continue
    }
    const candidates = [join(here, ref.name), join(here, `${id}.pdf`), join(here, 'assets', `${id}.pdf`)]
    let found = false
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue
      const bytes = new Uint8Array(readFileSync(candidate))
      if (await sha256Hex(bytes) !== id) continue
      registerAsset(id, bytesToBase64(bytes))
      found = true
      break
    }
    if (!found) missing.push(id)
  }
  return missing
}

export async function load(args: Args): Promise<Loaded> {
  const path = args.positional[0]
  if (!path) fail('which project file? usage: warren <command> <file.warren.json>')
  if (!existsSync(path)) fail(`no such file: ${path}`)

  // A running server holds the drawing a person is editing. Reading the file instead would
  // mean working from a copy that is already behind, and writing it would overwrite their work.
  const server = await runningServer(path)
  let project: Project
  let rev: number | null = null
  try {
    if (server) {
      const res = await fetch(`${server}/api/project`, { signal: AbortSignal.timeout(5000) })
      const body = await res.json() as { rev: number; project: unknown }
      project = parseProject(JSON.stringify(body.project))
      rev = body.rev
    } else {
      project = parseProject(readFileSync(path, 'utf8'))
    }
  } catch (err) {
    fail(`could not read ${path}: ${err instanceof Error ? err.message : err}`)
  }
  const assetDir = typeof args.flags.assets === 'string' ? args.flags.assets : undefined
  const missingAssets = await resolveAssets(project, path, assetDir)
  const store = new Store()
  store.loadProject(project, basename(path))
  return { path, project, store, missingAssets, server, rev }
}

/**
 * Writes the project back to wherever it came from. Through the server when one is holding it,
 * so the browser sees the change at once; straight to the file otherwise.
 */
export async function persist(loaded: Loaded): Promise<void> {
  if (!loaded.server) {
    writeFileSync(loaded.path, serialize(loaded.project))
    return
  }
  const res = await fetch(`${loaded.server}/api/project`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rev: loaded.rev, project: loaded.project }),
  })
  if (res.status === 409) {
    fail('the drawing changed while this command was running — nothing was written. Try again.')
  }
  if (!res.ok) fail(`the server refused the write: ${res.status}`)
}

/** Where a running server announces itself, so other commands find it without being told. */
export function lockPath(projectPath: string): string {
  return join(dirname(resolve(projectPath)), `.${basename(projectPath)}.serve.json`)
}

/** The server holding this project, if one is up and answering. */
export async function runningServer(projectPath: string): Promise<string | null> {
  const lock = lockPath(projectPath)
  if (!existsSync(lock)) return null
  try {
    const { port } = JSON.parse(readFileSync(lock, 'utf8')) as { port: number }
    const url = `http://127.0.0.1:${port}`
    const res = await fetch(`${url}/api/project`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return null
    return url
  } catch {
    // A stale lock from a server that is no longer there; the file is still the truth.
    return null
  }
}
