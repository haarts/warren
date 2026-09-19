#!/usr/bin/env node
/**
 * Warren command line. Reads and edits a project file using the same modules the app runs on,
 * so a length reported here is the length the drawing means - there is no second
 * implementation of the geometry to drift out of step.
 *
 * Everything speaks metres. The file stores PDF points and a per-sheet scale; converting at
 * the boundary is this tool's job, not the caller's.
 *
 * This file is the dispatcher: parse argv, answer `help`, or look the command up in the table
 * below and run it. Each command family lives in its own module under commands/; what they
 * share — arg parsing, loading and persisting a project, metre/point conversion, the ops
 * planner, the help text — lives in the modules beside this one.
 */
import { pathToFileURL } from 'node:url'
import { fail, parseArgs, type Args } from './args.ts'
import { commandHelp, isCommand, manifest, nearest, overview, type Command } from './help.ts'
import { cmdCheck, cmdGraph, cmdItems, cmdSummary, cmdTakeoff, cmdTrace } from './commands/read.ts'
import { cmdRules, cmdSystems } from './commands/catalogue.ts'
import { cmdDirections } from './commands/directions.ts'
import { cmdGenerate } from './commands/generate.ts'
import { cmdSplit, cmdBundle } from './commands/split-bundle.ts'
import { cmdApply } from './commands/apply.ts'
import { cmdSelect, cmdServe } from './commands/serve-select.ts'

// Typed by the manual, so a command that gains an implementation without gaining an entry — or
// the other way round — does not compile. Self-description is not a thing to remember to do.
const commands: Record<Command, (a: Args) => Promise<void>> = {
  summary: cmdSummary,
  items: cmdItems,
  takeoff: cmdTakeoff,
  check: cmdCheck,
  systems: cmdSystems,
  directions: cmdDirections,
  generate: cmdGenerate,
  rules: cmdRules,
  graph: cmdGraph,
  trace: cmdTrace,
  split: cmdSplit,
  bundle: cmdBundle,
  apply: cmdApply,
  serve: cmdServe,
  select: cmdSelect,
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  // Help is answered before anything is loaded, so `warren help apply` works with no file, no
  // plan PDF and nothing drawn yet — which is the state whoever is asking is usually in.
  if (args.command === 'help' || args.flags.help === true) {
    const topic = args.command === 'help' ? args.positional[0] : args.command
    if (topic !== undefined && !isCommand(topic)) {
      const guess = nearest(topic)
      fail(`no such command: ${topic}${guess ? `. Did you mean "${guess}"?` : ''}. Try: warren help`)
    }
    if (args.flags.json) {
      const all = manifest()
      console.log(JSON.stringify(topic === undefined ? all : all.commands.find((c) => c.name === topic), null, 2))
    } else {
      process.stdout.write(topic === undefined ? overview() : commandHelp(topic))
    }
    process.exit(0)
  }

  const run = isCommand(args.command) ? commands[args.command] : undefined
  if (!run) {
    const guess = nearest(args.command)
    process.stderr.write(`warren: no such command: ${args.command}${guess ? `. Did you mean "${guess}"?` : ''}\n`)
    process.stdout.write(overview())
    process.exit(2)
  }
  await run(args).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)))
}

// Only when run as the command. Importing this file — which the server and the tests do, for
// the validators — must not start a CLI and exit the process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
