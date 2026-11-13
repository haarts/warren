#!/usr/bin/env node
import { catalogue, type Candidate } from './catalog.ts'
import { AgentError, problem, usage } from './errors.ts'
import { selectItems, type Selection } from './select.ts'
import { typesafe, MODEL } from './typesafe.ts'
import { findProject, point, readProject } from './warren.ts'

/**
 * A command line that talks to Warren in English instead of ids.
 *
 * The translation lives in `select.ts` (a TypeSafe judgement) and the drawing lives behind
 * `warren serve` (see `warren.ts`). This file is only the conversation: read the flags, make
 * the two calls, and say what happened. Growing the tool means adding a command here and a
 * judgement beside it, not touching how the drawing is read or pointed at.
 */

interface Args {
  command: string
  positional: string[]
  flags: Record<string, string | true>
}

function parseArgs(argv: string[]): Args {
  const leads = argv[0] !== undefined && !argv[0].startsWith('-')
  const command = leads ? argv[0] : 'help'
  const rest = leads ? argv.slice(1) : argv
  const positional: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]
    if (token === '-h') {
      flags.help = true
    } else if (token.startsWith('--')) {
      const [name, inline] = token.slice(2).split('=')
      if (inline !== undefined) flags[name] = inline
      else if (rest[i + 1] && !rest[i + 1].startsWith('--')) flags[name] = rest[++i]
      else flags[name] = true
    } else {
      positional.push(token)
    }
  }
  return { command, positional, flags }
}

const flagString = (args: Args, name: string): string | undefined => {
  const value = args.flags[name]
  return typeof value === 'string' ? value : undefined
}

const HELP = `warren-agent — talk to Warren in English

  warren-agent select "<what to point at>" [options]
      Find the item the request is about and highlight it in the running app.
      Options:
        --project <file>   the *.warren.json to work on (default: the one here)
        --say <text>       status-bar line; defaults to the request itself
        --no-zoom          highlight without moving the person's view
        --top <n>          point at the n best matches as well (default: 1)
        --dry-run          do everything but point
        --json             machine-readable result
      Requires a running \`warren serve\`.

  warren-agent items [--project <file>] [--json]
      Print every item and the description the model is given for it.

  warren-agent help

Every id, and the meaning of every flag, comes from Warren itself: run
\`warren help --json\`.` 

// --------------------------------------------------------------------------------- commands

async function cmdSelect(args: Args): Promise<number> {
  const request = args.positional.join(' ').trim()
  if (!request) throw usage('what should I look for? usage: warren-agent select "<request>"')

  const projectPath = findProject(flagString(args, 'project'))
  const live = await readProject(projectPath)
  const candidates = catalogue(live.project)
  const byId = new Map(candidates.map((c) => [c.id, c]))

  const result = await selectItems(typesafe(), request, candidates)
  const top = Math.max(1, Number(flagString(args, 'top') ?? 1) || 1)
  const ids = result.matched ? result.ranking.slice(0, top).map((r) => r.id) : []

  const dryRun = args.flags['dry-run'] === true
  const say = flagString(args, 'say') ?? request
  let pointed = 0
  if (!dryRun && ids.length > 0) {
    pointed = await point(live, ids, { zoom: args.flags['no-zoom'] !== true, say })
  }

  if (args.flags.json === true) {
    process.stdout.write(
      JSON.stringify(
        {
          request,
          project: live.name,
          model: result.model,
          matched: result.matched,
          verdict: result.verdict,
          reason: result.reason,
          matchProbability: result.matchProbability,
          confidence: result.confidence,
          chosenId: result.chosenId,
          pointed,
          dryRun,
          chosen: result.chosenId ? describeCandidate(byId.get(result.chosenId), result) : null,
          ranking: result.ranking.slice(0, Math.max(top, 5)).map((r) => ({
            id: r.id,
            probability: r.probability,
            description: byId.get(r.id)?.description ?? null,
          })),
          usage: result.usage,
        },
        null,
        2,
      ) + '\n',
    )
  } else {
    report(result, byId, { pointed, dryRun, top })
  }

  if (!result.matched) throw problem(result.reason ?? 'nothing matched')
  return 0
}

async function cmdItems(args: Args): Promise<number> {
  const projectPath = findProject(flagString(args, 'project'))
  const live = await readProject(projectPath)
  const candidates = catalogue(live.project)
  if (args.flags.json === true) {
    process.stdout.write(JSON.stringify(candidates, null, 2) + '\n')
    return 0
  }
  for (const c of candidates) {
    process.stdout.write(`${c.id.padEnd(20)} ${c.kind.padEnd(7)} ${c.description}\n`)
  }
  process.stdout.write(`${candidates.length} item(s)\n`)
  return 0
}

// ---------------------------------------------------------------------------------- report

function describeCandidate(c: Candidate | undefined, result: Selection): unknown {
  if (!c) return null
  return { id: c.id, kind: c.kind, sheet: c.sheet, description: c.description, probability: result.ranking.find((r) => r.id === c.id)?.probability ?? null }
}

function report(
  result: Selection,
  byId: Map<string, Candidate>,
  opts: { pointed: number; dryRun: boolean; top: number },
): void {
  process.stdout.write(`request: ${result.request}\n`)
  if (!result.matched) {
    process.stdout.write(`no match - ${result.reason} (match ${result.matchProbability.toFixed(2)})\n`)
    const near = result.ranking.slice(0, 3)
    if (near.length) {
      process.stdout.write('closest things:\n')
      for (const r of near) process.stdout.write(`  ${bar(r.probability)} ${r.probability.toFixed(2)}  ${short(byId.get(r.id))}\n`)
    }
    return
  }

  const ids = result.ranking.slice(0, opts.top).map((r) => r.id)
  for (const id of ids) {
    const r = result.ranking.find((x) => x.id === id)!
    const c = byId.get(id)
    process.stdout.write(`\n${opts.dryRun ? 'would point at' : 'pointing at'} ${id}  (${r.probability.toFixed(2)})\n`)
    process.stdout.write(`  ${c?.description ?? '(unknown item)'}\n`)
  }
  process.stdout.write(
    `\nmatch ${result.matchProbability.toFixed(2)}, confidence ${result.confidence.toFixed(2)}` +
      `  ·  ${MODEL === result.model ? result.model : `${result.model} (requested ${MODEL})`}` +
      `  ·  ${opts.pointed} highlighted\n`,
  )
  if (result.verdict === 'uncertain') {
    process.stdout.write('  (an uncertain match - check it is the one meant; nothing was written)\n')
  }

  const runnerUp = result.ranking[opts.top]
  if (runnerUp && runnerUp.probability >= 0.05) {
    process.stdout.write('other candidates:\n')
    for (const r of result.ranking.slice(opts.top, opts.top + 4)) {
      process.stdout.write(`  ${bar(r.probability)} ${r.probability.toFixed(2)}  ${short(byId.get(r.id))}\n`)
    }
  }
}

const bar = (p: number): string => '#'.repeat(Math.max(1, Math.round(p * 10))).padEnd(10)
const short = (c: Candidate | undefined): string =>
  c ? `${c.id}  ${c.description.length > 96 ? `${c.description.slice(0, 93)}…` : c.description}` : '(unknown)'

// ------------------------------------------------------------------------------------ entry

async function run(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  if (args.flags.help === true) {
    process.stdout.write(HELP + '\n')
    return 0
  }
  switch (args.command) {
    case 'select':
      return cmdSelect(args)
    case 'items':
      return cmdItems(args)
    case 'help':
      process.stdout.write(HELP + '\n')
      return 0
    default:
      throw usage(`no such command: ${args.command}. Try: warren-agent help`)
  }
}

run().then(
  (code) => {
    process.exitCode = code
  },
  (err: unknown) => {
    if (err instanceof AgentError) {
      process.stderr.write(`warren-agent: ${err.message}\n`)
      process.exitCode = err.exitCode
    } else {
      process.stderr.write(`warren-agent: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
      process.exitCode = 1
    }
  },
)
