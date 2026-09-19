/**
 * The write path — the only one that should be used, since it is the only one that validates
 * before writing. Thin by design: all the actual work is `planOps`, in ../ops.ts, so `serve` can
 * run the identical checks against the project it holds.
 */
import { readFileSync, existsSync } from 'node:fs'
import { basename } from 'node:path'
import { fail, type Args } from '../args.ts'
import { load, persist } from '../project.ts'
import { planOps, type Op } from '../ops.ts'

export async function cmdApply(args: Args): Promise<void> {
  const loaded = await load(args)
  const { project, store, path } = loaded
  const opsPath = args.positional[1]
  if (!opsPath) fail('usage: warren apply <file.warren.json> <ops.json> [--dry-run]')
  if (!existsSync(opsPath)) fail(`no such file: ${opsPath}`)

  let ops: Op[]
  try {
    const parsed: unknown = JSON.parse(readFileSync(opsPath, 'utf8'))
    ops = Array.isArray(parsed) ? parsed as Op[] : (parsed as { ops: Op[] }).ops
    if (!Array.isArray(ops)) throw new Error('expected an array of ops, or {"ops": [...]}')
  } catch (err) {
    fail(`could not read ${opsPath}: ${err instanceof Error ? err.message : err}`)
  }

  // `--as <who>` marks everything this batch adds as placed-but-unreviewed, the same standing
  // a generated item has. Without it a model's suggestions would arrive looking like your work.
  const stamp = typeof args.flags.as === 'string' ? { rule: args.flags.as, from: 'apply' } : null

  const { problems, describe, planned } = planOps(project, store, ops, stamp)

  if (problems.length) {
    for (const p of problems) process.stderr.write(`warren: ${p}\n`)
    process.stderr.write(`warren: nothing was written — ${problems.length} of ${ops.length} ops did not validate\n`)
    process.exit(1)
  }

  for (const line of describe) console.log(line)
  if (args.flags['dry-run']) return void console.log(`${planned.length} op(s) would apply; nothing written`)
  for (const apply of planned) apply()
  await persist(loaded)
  console.log(`applied ${planned.length} op(s) to ${basename(path)}`)
}
