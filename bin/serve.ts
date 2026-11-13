/**
 * One source of truth for a project, so a person in the browser and a model at the command
 * line are looking at the same drawing rather than two copies of it.
 *
 * Without this they each hold their own: the app has the project in memory, the CLI has a file
 * on disk, and every exchange between them is a manual save / apply / reopen. Worse, pointing
 * at something — "look at this run" — had to be done by writing a label into the file, which
 * is an absurd price for a gesture.
 *
 * The app still runs as static files with no server at all. This is an additional mode.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { parseProject, serialize } from '../src/io/projectFile.ts'
import { assetData, registerAsset } from '../src/model/assets.ts'
import { bytesToBase64, sha256Hex } from '../src/io/base64.ts'
import { Store } from '../src/model/doc.ts'
import type { Project } from '../src/model/types.ts'

export interface ServeOptions {
  projectPath: string
  port: number
  root: string
  /** Called to resolve the plan PDF bytes into the asset registry. */
  hydrate: (project: Project, path: string) => Promise<string[]>
  /** Validates and applies a batch, exactly as `warren apply` would. */
  applyOps: (project: Project, store: Store, ops: unknown[], as: string | null) => {
    problems: string[]
    describe: string[]
    commit: () => void
  }
  open?: boolean
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
  '.map': 'application/json',
}

interface Client {
  res: ServerResponse
  id: number
}

export async function serve(opts: ServeOptions): Promise<{ port: number; close: () => void }> {
  const path = resolve(opts.projectPath)
  const root = resolve(opts.root)
  let project = parseProject(readFileSync(path, 'utf8'))
  await opts.hydrate(project, path)

  /**
   * Bumped on every change to the drawing. The browser sends the revision it started from, so
   * two writers cannot silently overwrite each other - the stale one is told to reload.
   */
  let rev = 1
  let writeTimer: NodeJS.Timeout | null = null

  const clients = new Set<Client>()
  let nextClient = 1

  const broadcast = (event: string, data: unknown): void => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const c of clients) {
      try {
        c.res.write(payload)
      } catch {
        clients.delete(c)
      }
    }
  }

  /** Written on a short delay, so a drag does not mean a thousand writes. */
  const persist = (): void => {
    if (writeTimer) clearTimeout(writeTimer)
    writeTimer = setTimeout(() => {
      writeTimer = null
      try {
        writeFileSync(path, serialize(project))
      } catch (err) {
        process.stderr.write(`warren serve: could not write ${basename(path)}: ${String(err)}\n`)
      }
    }, 400)
  }

  const json = (res: ServerResponse, code: number, body: unknown): void => {
    const text = JSON.stringify(body)
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(text)
  }

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((ok, no) => {
      let out = ''
      req.on('data', (chunk) => {
        out += chunk
        // A project with a bundled PDF can be large; anything past this is not a project.
        if (out.length > 64 * 1024 * 1024) no(new Error('body too large'))
      })
      req.on('end', () => ok(out))
      req.on('error', no)
    })

  const readBytes = (req: IncomingMessage, limit: number): Promise<Buffer> =>
    new Promise((ok, no) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > limit) no(new Error('body too large'))
        else chunks.push(chunk)
      })
      req.on('end', () => ok(Buffer.concat(chunks)))
      req.on('error', no)
    })

  /**
   * Keeps a plan PDF the browser has attached. The project file only references it, so unless
   * the bytes land on disk beside it, the plan exists only in that one tab and is gone on the
   * next reload. Written under its own name, where `resolveAssets` looks first - or as
   * `<hash>.pdf` when that name is taken by different bytes, which it also looks for.
   */
  const keepAsset = async (id: string, name: string, bytes: Uint8Array): Promise<string> => {
    const here = dirname(path)
    const safe = basename(name)
    const named = safe && safe !== '.' && safe !== '..' ? join(here, safe) : null
    const byHash = join(here, `${id}.pdf`)
    let target = named ?? byHash
    if (existsSync(target) && await sha256Hex(new Uint8Array(readFileSync(target))) !== id) target = byHash
    if (!existsSync(target) || target === byHash) writeFileSync(target, bytes)
    registerAsset(id, bytesToBase64(bytes))
    return basename(target)
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname

    try {
      // --- the shared project ------------------------------------------------------------
      if (route === '/api/project' && req.method === 'GET') {
        return json(res, 200, { rev, name: basename(path), project })
      }

      if (route === '/api/project' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req)) as { rev?: number; project?: unknown; by?: string }
        if (typeof body.rev === 'number' && body.rev !== rev) {
          // Somebody else has changed it since this browser loaded. Reloading is the honest
          // answer: merging two drawings is not something to guess at.
          return json(res, 409, { rev, reason: 'stale' })
        }
        project = parseProject(JSON.stringify(body.project))
        await opts.hydrate(project, path)
        rev += 1
        persist()
        // Tagged with who did it, so the window that saved does not turn round and reload its
        // own change — which would race with anything typed since, and lose it.
        broadcast('changed', { rev, source: 'browser', by: typeof body.by === 'string' ? body.by : null })
        return json(res, 200, { rev })
      }

      // --- a batch of ops, validated exactly as `warren apply` would ----------------------
      if (route === '/api/ops' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req)) as { ops?: unknown[]; as?: string; dryRun?: boolean }
        const ops = Array.isArray(body.ops) ? body.ops : []
        const store = new Store()
        store.loadProject(project, basename(path))
        const plan = opts.applyOps(project, store, ops, typeof body.as === 'string' ? body.as : null)
        if (plan.problems.length) return json(res, 422, { problems: plan.problems })
        if (body.dryRun) return json(res, 200, { rev, describe: plan.describe, applied: 0 })
        plan.commit()
        rev += 1
        persist()
        broadcast('changed', { rev, source: 'cli', by: null })
        return json(res, 200, { rev, describe: plan.describe, applied: plan.describe.length })
      }

      // --- pointing: changes nothing, writes nothing, bumps no revision -------------------
      if (route === '/api/select' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req)) as { ids?: string[]; zoom?: boolean; say?: string }
        const ids = Array.isArray(body.ids) ? body.ids.filter((v): v is string => typeof v === 'string') : []
        broadcast('select', { ids, zoom: body.zoom !== false, say: typeof body.say === 'string' ? body.say : null })
        return json(res, 200, { ids: ids.length })
      }

      // --- the plan PDF, so a browser that has never seen it can still draw ---------------
      if (route.startsWith('/api/asset/') && req.method === 'GET') {
        const id = route.slice('/api/asset/'.length)
        const data = assetData(id)
        if (!data) return json(res, 404, { error: 'no such asset' })
        const bytes = Buffer.from(data, 'base64')
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': String(bytes.length) })
        return void res.end(bytes)
      }

      if (route.startsWith('/api/asset/') && req.method === 'PUT') {
        const id = route.slice('/api/asset/'.length)
        if (!/^[0-9a-f]{64}$/.test(id)) return json(res, 400, { error: 'an asset id is a sha-256' })
        const bytes = new Uint8Array(await readBytes(req, 256 * 1024 * 1024))
        // The id is the hash of the bytes; anything else is not this asset.
        if (await sha256Hex(bytes) !== id) return json(res, 422, { error: 'the bytes do not match the id' })
        const file = await keepAsset(id, url.searchParams.get('name') ?? '', bytes)
        return json(res, 200, { id, file })
      }

      // --- live updates -------------------------------------------------------------------
      if (route === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        })
        res.write(`event: hello\ndata: ${JSON.stringify({ rev })}\n\n`)
        const client: Client = { res, id: nextClient++ }
        clients.add(client)
        const keepAlive = setInterval(() => {
          try {
            res.write(': ping\n\n')
          } catch {
            clearInterval(keepAlive)
          }
        }, 25_000)
        req.on('close', () => {
          clearInterval(keepAlive)
          clients.delete(client)
        })
        return
      }

      // --- the app itself -------------------------------------------------------------------
      const wanted = route === '/' ? '/index.html' : route
      const file = resolve(join(root, wanted))
      // Anything that escapes the served directory is not ours to hand out.
      if (!file.startsWith(root + sep) && file !== root) {
        return json(res, 403, { error: 'outside the served directory' })
      }
      if (!existsSync(file)) {
        // A single-page app: unknown paths are the app's business, not a 404.
        const index = join(root, 'index.html')
        if (!existsSync(index)) {
          return json(res, 404, { error: `nothing built at ${root}. Run: npm run build` })
        }
        res.writeHead(200, { 'content-type': MIME['.html'] })
        return void res.end(injectMode(readFileSync(index, 'utf8')))
      }
      const ext = extname(file)
      if (ext === '.html') {
        res.writeHead(200, { 'content-type': MIME['.html'] })
        return void res.end(injectMode(readFileSync(file, 'utf8')))
      }
      res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' })
      return void res.end(readFileSync(file))
    } catch (err) {
      return json(res, 400, { error: err instanceof Error ? err.message : String(err) })
    }
  })

  await new Promise<void>((ok) => server.listen(opts.port, '127.0.0.1', ok))
  const actual = (server.address() as { port: number }).port

  return {
    port: actual,
    close: () => {
      if (writeTimer) {
        clearTimeout(writeTimer)
        writeFileSync(path, serialize(project))
      }
      for (const c of clients) c.res.end()
      server.close()
    },
  }
}

/** Tells the app it is being served rather than opened as a file. */
function injectMode(html: string): string {
  return html.replace('<head>', '<head><script>window.__warrenServed = true</script>')
}

export function defaultRoot(): string {
  return resolve(dirname(new URL(import.meta.url).pathname), '..', 'dist')
}
