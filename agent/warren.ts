import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { Project } from '../src/model/types.ts'
import { problem, usage } from './errors.ts'

/**
 * The Warren side of the tool: find the project and the server holding it, read the drawing,
 * and point at things.
 *
 * Everything goes through `warren serve`, never the file on disk. While a person has the app
 * open the server is the one copy that both sides see, so pointing at an item the app has
 * never heard of is impossible and a read is never a stale one.
 */

interface Lock {
  port: number
  pid: number
  path: string
}

/** Where a running server announces itself - the same lock file `warren` itself writes. */
function lockPath(projectPath: string): string {
  return join(dirname(resolve(projectPath)), `.${basename(projectPath)}.serve.json`)
}

/** The one project in this directory, unless it was named. */
export function findProject(explicit?: string): string {
  if (explicit) {
    if (!existsSync(explicit)) throw usage(`no such file: ${explicit}`)
    return explicit
  }
  const here = process.cwd()
  const found = readdirSync(here).filter(
    (name) => name.endsWith('.warren.json') && !name.endsWith('.bundle.warren.json'),
  )
  if (found.length === 1) return join(here, found[0])
  if (found.length === 0) throw usage('no *.warren.json here - pass --project <file>')
  throw usage(`several projects here (${found.join(', ')}) - pass --project <file>`)
}

/** The base URL of the server holding this project, if one is up and answering. */
export async function serverFor(projectPath: string): Promise<string> {
  const lock = lockPath(projectPath)
  if (existsSync(lock)) {
    try {
      const { port } = JSON.parse(readFileSync(lock, 'utf8')) as Lock
      const url = `http://127.0.0.1:${port}`
      const res = await fetch(`${url}/api/project`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) return url
    } catch {
      // A stale lock from a server that is gone. Fall through to the honest answer.
    }
  }
  throw usage(`nothing is serving ${basename(projectPath)}. Start it with: warren serve ${projectPath}`)
}

export interface Live {
  /** Base URL of the server, for pointing and later writes. */
  url: string
  /** Bumped on every change; a reader can tell whether the drawing moved under it. */
  rev: number
  name: string
  project: Project
}

export async function readProject(projectPath: string): Promise<Live> {
  const url = await serverFor(projectPath)
  const res = await fetch(`${url}/api/project`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw problem(`the server refused the read: ${res.status}`)
  const body = (await res.json()) as { rev: number; name: string; project: Project }
  return { url, rev: body.rev, name: body.name, project: body.project }
}

export interface PointOptions {
  /** Move the person's view to what was found; `no-zoom` leaves it where it is. */
  zoom: boolean
  /** A line for the status bar. */
  say: string | null
}

/** Highlight ids in the running app. Writes nothing, bumps no revision. */
export async function point(live: Live, ids: string[], opts: PointOptions): Promise<number> {
  const res = await fetch(`${live.url}/api/select`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids, zoom: opts.zoom, say: opts.say }),
  })
  if (!res.ok) throw problem(`the server refused: ${res.status}`)
  const body = (await res.json()) as { ids: number }
  return body.ids
}
