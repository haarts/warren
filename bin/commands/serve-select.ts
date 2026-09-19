/**
 * `serve` starts the shared server (../../bin/serve.ts holds the HTTP side); `select` is a
 * gesture against one already running — it points at items in the open window and writes
 * nothing at all.
 */
import { existsSync, writeFileSync, unlinkSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { defaultRoot, serve } from '../serve.ts'
import { fail, type Args } from '../args.ts'
import { lockPath, resolveAssets, runningServer } from '../project.ts'
import { planOps, type Op } from '../ops.ts'

export async function cmdServe(args: Args): Promise<void> {
  const projectPath = args.positional[0]
  if (!projectPath) fail('which project file? usage: warren serve <file.warren.json>')
  if (!existsSync(projectPath)) fail(`no such file: ${projectPath}`)

  const root = typeof args.flags.root === 'string' ? args.flags.root : defaultRoot()
  if (!existsSync(join(root, 'index.html'))) {
    fail(`nothing built at ${root}. Run: npm run build`)
  }

  const handle = await serve({
    projectPath,
    port: typeof args.flags.port === 'string' ? Number(args.flags.port) : 5170,
    root,
    hydrate: (project, path) => resolveAssets(project, path),
    applyOps: (project, store, ops, as) => {
      const plan = planOps(project, store, ops as Op[], as ? { rule: as, from: 'apply' } : null)
      return {
        problems: plan.problems,
        describe: plan.describe,
        commit: () => { for (const apply of plan.planned) apply() },
      }
    },
  })

  const lock = lockPath(projectPath)
  writeFileSync(lock, JSON.stringify({ port: handle.port, pid: process.pid, path: resolve(projectPath) }))
  const bye = (): void => {
    try {
      if (existsSync(lock)) unlinkSync(lock)
    } catch { /* going away anyway */ }
    handle.close()
    process.exit(0)
  }
  process.on('SIGINT', bye)
  process.on('SIGTERM', bye)

  console.log(`warren serve — http://127.0.0.1:${handle.port}`)
  console.log(`  holding ${basename(projectPath)}; other commands will route through this.`)
  console.log('  Ctrl+C to stop.')
}

export async function cmdSelect(args: Args): Promise<void> {
  const projectPath = args.positional[0]
  if (!projectPath) fail('which project file? usage: warren select <file> --id <a,b>')
  const url = await runningServer(projectPath)
  if (!url) fail('nothing is serving this project. Start it with: warren serve <file>')

  const ids = typeof args.flags.id === 'string' ? args.flags.id.split(',').map((v) => v.trim()).filter(Boolean) : []
  if (ids.length === 0) fail('which items? usage: warren select <file> --id run_abc,run_def')

  const res = await fetch(`${url}/api/select`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ids,
      zoom: args.flags['no-zoom'] !== true,
      say: typeof args.flags.say === 'string' ? args.flags.say : null,
    }),
  })
  if (!res.ok) fail(`the server refused: ${res.status}`)
  console.log(`pointing at ${ids.length} item(s) in the running app`)
}
