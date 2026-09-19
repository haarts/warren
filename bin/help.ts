/**
 * One entry per command, and the only description of this command line there is: the overview,
 * the per-command help and the `--json` manifest are all printed from here. Something reading
 * the manifest gets the same facts as someone reading the prose, and the two cannot drift.
 */
import { readFileSync } from 'node:fs'
import { PLACEMENTS } from '../src/generate.ts'
import { CATEGORIES, ITEM_KINDS, LEVELS, MARKER_SYMBOLS, ROOM_USES } from '../src/model/types.ts'
import { ADDABLE_KINDS, PATCHABLE } from './ops.ts'

interface Entry {
  /** One line, for the overview listing. */
  summary: string
  usage: string[]
  flags?: [flag: string, does: string][]
  examples?: string[]
  /** What a caller has to know before the command is useful rather than merely runnable. */
  notes?: string[]
  /** Does it write to the project file? */
  writes?: boolean
}

const EVERYWHERE: [string, string][] = [
  ['--json', 'machine-readable output instead of prose'],
  ['--assets <dir>', 'where to look for the plan PDF (default: beside the project file)'],
]

const SHEET_FLAG: [string, string] = ['--sheet <n|name>', 'one sheet, by 1-based number or by name substring']

const FILTERS: [string, string][] = [
  SHEET_FLAG,
  ['--system <glob>', "system ids, `*` allowed — e.g. 'power.*'"],
  ['--level <level>', `one of ${LEVELS.join(', ')}`],
  ['--kind <kind>', `one of ${ITEM_KINDS.join(', ')}`],
]

const MANUAL = {
  summary: {
    summary: 'what is in this project',
    usage: ['warren summary <file>'],
    examples: ['warren summary house.warren.json --json'],
    notes: [
      'Read this first. It says whether each sheet is calibrated, and nothing that reports metres means anything until one is.',
    ],
  },
  items: {
    summary: 'list items, with real-world positions',
    usage: ['warren items <file> [filters]'],
    flags: FILTERS,
    examples: [
      "warren items house.warren.json --system 'power.*' --level wall",
      'warren items house.warren.json --kind room --json',
    ],
    notes: ['The id on each row is what `trace` and `apply` address items by.'],
  },
  takeoff: {
    summary: 'metres per system — the thing you order from',
    usage: ['warren takeoff <file> [--scope sheet] [--csv]'],
    flags: [
      ['--scope sheet', 'break the totals down per sheet instead of per project'],
      ['--csv', 'comma-separated instead of a table'],
    ],
    examples: ['warren takeoff house.warren.json --csv'],
  },
  check: {
    summary: 'a second pair of eyes; exits 1 on errors',
    usage: ['warren check <file> [--strict]'],
    flags: [['--strict', 'exit 1 on suggestions too, not only errors']],
    examples: ['warren check house.warren.json --strict'],
    notes: [
      'Run this after every write. The file parser is forgiving on purpose — it repairs damage so a file written 18 months ago still opens — and that is right for a person and dangerous for a machine. `check` fails where the parser forgives: a run with one vertex, coordinates in millimetres where points belong, a system id that does not exist.',
      'One finding is an error rather than an opinion: non-potable water may never reach drinking water. It is derived from the geometry, so it holds whether or not anything is labelled.',
    ],
  },
  graph: {
    summary: 'derived connections: networks, junctions, free ends',
    usage: ['warren graph <file> [--sheet <n|name>]'],
    flags: [SHEET_FLAG],
    notes: [
      'Nothing records what is joined to what — it is read back from the coordinates, within 5 mm of real world. Two things that look joined but are not show up as loose ends, which is the honest answer: they are not joined.',
    ],
  },
  trace: {
    summary: 'what one item is joined to, and what it reaches',
    usage: ['warren trace <file> --id <item-id>', 'warren trace <file> <item-id>'],
    flags: [['--id <item-id>', 'the item to trace, as printed by `items`']],
    examples: ['warren trace house.warren.json --id run_x'],
  },
  systems: {
    summary: 'the catalogue: list it, extend it, fold parts of it together',
    usage: [
      'warren systems <file>',
      'warren systems <file> --add-missing',
      'warren systems <file> --merge <a,b> --into <c>',
      'warren systems <file> --set-sizes <id> --sizes "a,b,c"',
    ],
    flags: [
      ['--add-missing', 'add built-in systems this project predates'],
      ['--merge <a,b,...>', 'system ids to fold away'],
      ['--into <id>', 'the system their items move to'],
      ['--set-sizes <id>', 'replace a system\'s size list — first entry becomes the default'],
      ['--sizes <a,b,...>', 'the new list, used with --set-sizes'],
    ],
    examples: [
      'warren systems house.warren.json --merge power.light,power.socket --into power.230v',
      'warren systems house.warren.json --set-sizes power.smoke --sizes "2×1.5mm² + interlink,4×1.5mm²"',
    ],
    notes: [
      'Style belongs to the system, not to the shape: colour, dash, width and default size all come from here. That is why a drawing made over two years still agrees with itself, and why the takeoff can add anything up.',
      'Every item must name a system that exists. `--add-missing` is the usual first move on an older project.',
      '--set-sizes only changes the suggestion list and its default — items already drawn keep whatever size text they have; fix those with `apply`\'s `set` op if the wording changed.',
    ],
    writes: true,
  },
  directions: {
    summary: 'which way is which — one compass rose with named tips, plus one-off bearings',
    usage: [
      'warren directions <file>',
      'warren directions <file> --compass [--rotation <deg>] [--tips "a,b; c; d; e"] [--at <xM,yM>]',
      'warren directions <file> --compass --tip <n> --names "a, b"',
      'warren directions <file> --remove-compass',
      'warren directions <file> --set <id> --bearing <deg> [--aliases "a,b,c"]',
      'warren directions <file> --remove <id>',
      'warren directions <file> --resolve <term>',
      'warren directions <file> --toward <term> --from <xM,yM> --distanceM <d> [--sheet <n|name>]',
    ],
    flags: [
      ['--compass', 'place the compass rose, or update it; parts you leave out stay as they are'],
      ['--rotation <deg>', 'where tip 1 points, clockwise from "up"; tips 2-4 follow at +90° each'],
      ['--tips <names>', 'all four tips\' names at once: exactly four, ";" between tips, "," between names'],
      ['--tip <n>', 'one tip (1-4) to rename, with --names; the other three are left alone'],
      ['--names <a,b,...>', 'every name tip <n> should carry afterwards, used with --tip'],
      ['--at <xM,yM>', 'where the rose stands, in metres on --sheet (default the first) — only for the eye'],
      ['--remove-compass', 'take the rose off'],
      ['--set <id>', 'a one-off direction the rose does not cover'],
      ['--bearing <deg>', 'its bearing, clockwise from "up" (0=up, 90=right, 180=down, 270=left)'],
      ['--aliases <a,b,...>', 'every name the one-off direction answers to'],
      ['--remove <id>', 'delete a one-off direction'],
      ['--resolve <term>', 'look a name up and print the bearing it means'],
      ['--toward <term>', 'with --from and --distanceM, print the point that far along this bearing'],
      ['--from <xM,yM>', 'origin point in metres on --sheet, used with --toward'],
      ['--distanceM <d>', 'distance in metres, used with --toward'],
      SHEET_FLAG,
    ],
    examples: [
      'warren directions house.warren.json --compass --rotation 12 --tips "north, straatzijde; east; south, tuin; west"',
      'warren directions house.warren.json --compass --tip 4 --names "west, links, voorkant"',
      'warren directions house.warren.json --resolve straatzijde',
      'warren directions house.warren.json --toward straatzijde --from 12.87,11.39 --distanceM 6.5',
    ],
    notes: [
      'There is one set of directions for the whole project, not one per sheet: pipes and ducts pass between floors, so every sheet is already drawn the same way round. The rose shows on every sheet at the same spot.',
      'A compass rose is four tips a quarter-turn apart, turned to match the building, each with as many names as people use for that way. In the app it is dragged into place and named in Properties; here it is --compass.',
      'Bearings are clockwise from "up" on the plan — not true north, unless the rose says so. Only confirmed readings belong here: a guess recorded as a direction becomes a fact the next session trusts.',
      'The rose\'s tips and the one-off list are read together: --resolve, --toward and the app all see both.',
      '--toward computes a point; it draws nothing. Feed the result into an `add` op\'s pointsM/xM/yM.',
      'Lookup is case-insensitive and substring-tolerant: "street" matches a tip named "street side".',
    ],
    writes: true,
  },
  rules: {
    summary: 'the placement rules (data, so they are yours)',
    usage: ['warren rules <file>', 'warren rules <file> --set <rules.json>'],
    flags: [['--set <rules.json>', 'replace the whole rule set with this file']],
    notes: [
      `A rule set is an array of rules. Placements are ${PLACEMENTS.join(', ')}; each rule says which room uses it applies to, which system and level its output belongs to, and the distances involved.`,
      'Warren executes a rule set rather than believing one, so `--set` replaces them wholesale. There is no merge.',
    ],
    writes: true,
  },
  generate: {
    summary: 'run the rules over the rooms and doors',
    usage: ['warren generate <file> [--rule <name>] [--room <a,b>] [--set <k=v>] [--dry-run|--where|--clear|--save]'],
    flags: [
      ['--rule <name>', 'just this rule, instead of all of them'],
      ['--room <a,b,...>', 'just these rooms, by name substring'],
      ['--set <k=v,...>', 'override rule parameters for this run'],
      ['--dry-run', 'report what would happen; write nothing'],
      ['--where', 'with --dry-run, print the position of every placement'],
      ['--clear', 'remove what the rule generated, and stop'],
      ['--save', 'keep a --set override in the project as the new rule'],
      SHEET_FLAG,
    ],
    examples: [
      'warren generate house.warren.json --rule sockets --room Keuken --dry-run --where',
      'warren generate house.warren.json --rule sockets --room Keuken --set perWall=3 --save',
    ],
    notes: [
      'This is the repetitive half of an electrical layout — two sockets per wall, a switch by each door, a detector in the halls. It needs rooms and doors to exist first; `apply` is how they get there.',
      'Generated items are stamped with the rule that made them, and their ids are derived from rule and room rather than random, so re-running produces the same file instead of a diff full of new identifiers.',
      'Move or change one and it becomes yours: the stamp comes off and re-running leaves it exactly where you put it. That holds whoever did the editing, `apply` included.',
      'Scoping with --room limits what gets replaced, so regenerating one room never disturbs another. Whatever the name matched is printed, so a mis-scope is visible rather than silent.',
    ],
    writes: true,
  },
  split: {
    summary: 'move the PDF out beside the file',
    usage: ['warren split <file>'],
    notes: [
      'A project that references its plan is tens of KB instead of tens of MB, and `git log` becomes a readable history of the design rather than a wall of base64.',
    ],
    writes: true,
  },
  bundle: {
    summary: 'write one self-contained file, for mailing or archiving',
    usage: ['warren bundle <file> [--out <path>]'],
    flags: [['--out <path>', 'where to write it (default: <name>.bundle.warren.json)']],
    writes: true,
  },
  serve: {
    summary: 'hold the project so the app and the command line share it',
    usage: ['warren serve <file> [--port 5170] [--root dist]'],
    flags: [
      ['--port <n>', 'port to listen on (default 5170)'],
      ['--root <dir>', 'the built app to serve (default dist/)'],
    ],
    examples: ['warren serve house.warren.json'],
    notes: [
      'Without this the app holds the project in memory and the command line holds a file on disk, so every exchange between a person and a model is a manual save, apply and reopen — and pointing at something has to be done by writing a label into the file, which is an absurd price for a gesture.',
      'While it runs, every other command routes through it instead of touching the file, so both see the same drawing. Writes reach the disk on a short delay; the file is always a real file.',
      'The app still runs as static files with no server at all. This is an additional mode, not a replacement.',
    ],
  },
  select: {
    summary: 'point at items in the running app',
    usage: ['warren select <file> --id <a,b> [--say "..."] [--no-zoom]'],
    flags: [
      ['--id <a,b>', 'the items to highlight, as printed by `items`'],
      ['--say <text>', 'a line to show in the status bar alongside'],
      ['--no-zoom', 'highlight without moving the view'],
    ],
    examples: ['warren select house.warren.json --id run_abc --say "two runs reach the Quooker"'],
    notes: [
      'Changes nothing: no write, no revision, no undo entry. It is a gesture, and it needs `serve` to be running.',
    ],
  },
  apply: {
    summary: 'apply validated edits from an ops file',
    usage: ['warren apply <file> <ops.json> [--as <who>] [--dry-run]'],
    flags: [
      ['--dry-run', 'validate and describe; write nothing'],
      ['--as <who>', 'mark what this batch adds as placed-but-unreviewed'],
    ],
    examples: [
      'warren apply house.warren.json rooms.json --dry-run',
      'warren apply house.warren.json sockets.json --as ai:keuken',
    ],
    notes: [
      'This is the write path, and the only one that should be used: editing the JSON directly skips every check below.',
      'The ops file is an array of ops, or {"ops": [...]}. All of it is validated before any of it is applied, so a half-understood instruction cannot leave the drawing half-changed. If one op fails, nothing is written.',
      'Coordinates: pointsM / xM / yM are metres and need a calibrated sheet; points / x / y are raw PDF points. Prefer metres — converting at the boundary is this tool’s job, not the caller’s.',
      '--as stamps everything the batch adds with the standing generated items have: drawn faintly, left alone by a later generate, and yours the moment you touch one. Use it for anything a model suggested, so it does not arrive looking like work the person did.',
      'A room op may carry expectM2. Dutch architect’s plans print the area of every room, so a traced outline can check itself: the batch is refused if the polygon disagrees by more than 8%.',
    ],
    writes: true,
  },
} satisfies Record<string, Entry>

export type Command = keyof typeof MANUAL

export const isCommand = (word: string): word is Command => Object.hasOwn(MANUAL, word)

/** The op shapes `apply` accepts, written down once so the manifest and the prose agree. */
const OPS: Record<string, { does: string; fields: Record<string, string> }> = {
  set: {
    does: 'change fields on an existing item',
    fields: {
      id: 'the item to change, as printed by `items`',
      patch: `object — any of: ${[...PATCHABLE].join(', ')}`,
    },
  },
  delete: {
    does: 'remove an item',
    fields: { id: 'the item to remove' },
  },
  move: {
    does: 'shift an item by a delta',
    fields: {
      id: 'the item to move',
      byM: '[dx, dy] in metres (needs a calibrated sheet)',
      byPt: '[dx, dy] in raw PDF points — instead of byM, not as well as',
    },
  },
  add: {
    does: 'add a new item',
    fields: {
      sheet: 'optional — 1-based number or name substring; defaults to the first sheet',
      'item.kind': `one of ${ADDABLE_KINDS.join(', ')}`,
      'item.systemId': 'required — must already be in this project’s catalogue (see `systems`)',
      'item.level': `optional — one of ${LEVELS.join(', ')} (default: wall)`,
      'item.pointsM': 'run/room/door — [[x, y], ...] in metres. A run takes 2+, a room 3+, a door exactly 2 with the hinge jamb first',
      'item.xM, item.yM': 'marker/note — position in metres',
      'item.name, item.ref': 'room — its name, and the number printed on the plan',
      'item.use': `room — one of ${ROOM_USES.join(', ')}`,
      'item.expectM2': 'room — the area printed on the plan; the batch is refused if the outline is more than 8% out',
      'item.swing': 'door — 1 or -1',
      'item.label': 'run/door/marker — the text drawn beside it',
      'item.size, item.flow': `run — size defaults to the system’s; flow is none, forward or reverse`,
      'item.symbol': `marker — one of ${MARKER_SYMBOLS.join(', ')}`,
      'item.text': 'note — its contents',
    },
  },
}

const EXIT: Record<string, string> = {
  '0': 'it worked',
  '1': 'the project was read, but the answer is bad news — `check` found errors, or an ops file did not validate and nothing was written',
  '2': 'the command line itself was wrong — unknown command, or a missing or unreadable file',
}

const UNITS = 'Every length and position in and out of this tool is metres. The file stores PDF '
  + 'points and a per-sheet scale; converting is this tool’s job, not the caller’s. An '
  + 'uncalibrated sheet reports null rather than a guess.'

const pad = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - s.length))

/** Soft-wraps prose, so the per-command help stays readable in a terminal. */
function wrapWords(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line && line.length + word.length + 1 > width) { lines.push(line); line = word }
    else line = line ? `${line} ${word}` : word
  }
  if (line) lines.push(line)
  return lines
}

const wrap = (text: string, width = 92): string => wrapWords(text, width).join('\n')

/** A `name  description` row whose wrapped description stays under its own first line. */
function row(name: string, means: string, at: number, lead = '      '): string {
  const indent = ' '.repeat(lead.length + at + 2)
  const [first, ...rest] = wrapWords(means, 96 - indent.length)
  return [`${lead}${pad(name, at)}  ${first}`, ...rest.map((l) => indent + l)].join('\n')
}

export function overview(): string {
  const asking: [string, string][] = [
    ['help <cmd>', 'usage, flags, examples and the rules of one command'],
    ['help --json', 'every command, flag, op shape and enum, machine-readable'],
  ]
  const entries = Object.entries(MANUAL)
  const width = Math.max(...entries.map(([n]) => n.length), ...asking.map(([n]) => n.length))
  const line = ([n, s]: [string, string]): string => `  warren ${pad(n, width)}  ${s}`
  const listing = entries.map(([n, entry]) => line([n, entry.summary])).join('\n')
  const everywhere = EVERYWHERE.map(([f, d]) => `  ${pad(f, width + 7)}  ${d}`).join('\n')
  return `warren — read and edit a Warren project from the command line

${listing}

${asking.map(line).join('\n')}

Everywhere:
${everywhere}

Lengths and positions are metres; a sheet must be calibrated for those to exist.
Writing to a project? Use \`warren apply\`, then \`warren check\`. See AGENTS.md.
`
}

export function commandHelp(name: Command): string {
  const entry: Entry = MANUAL[name]
  const out: string[] = [`warren ${name} — ${entry.summary}`, '']
  for (const line of entry.usage) out.push(`  ${line}`)

  const flags = [...(entry.flags ?? []), ...EVERYWHERE]
  const width = Math.max(...flags.map(([f]) => f.length))
  out.push('', 'Flags:')
  for (const [flag, does] of flags) out.push(`  ${pad(flag, width)}  ${does}`)

  if (name === 'apply') {
    out.push('', 'Ops:')
    for (const [op, { does, fields }] of Object.entries(OPS)) {
      out.push('', `  {"op": "${op}", ...} — ${does}`)
      const at = Math.max(...Object.keys(fields).map((f) => f.length))
      for (const [field, means] of Object.entries(fields)) out.push(row(field, means, at))
    }
  }

  for (const note of entry.notes ?? []) out.push('', wrap(note))

  if (entry.examples?.length) {
    out.push('', 'Examples:')
    for (const example of entry.examples) out.push(`  ${example}`)
  }
  if (entry.writes) out.push('', 'Writes to the project file. Run `warren check` afterwards.')
  return `${out.join('\n')}\n`
}

/**
 * Everything a caller needs to drive this tool without reading prose: the commands, their
 * flags, the op shapes and the enumerations they have to choose from. The enums come from the
 * same constants the validators use, so a value listed here is a value that will be accepted.
 */
export function manifest() {
  return {
    tool: 'warren',
    version: version(),
    describes: 'Draw and measure the services in a house — pipes, ducts and circuits over an architect’s floor plan PDF.',
    invoke: { installed: 'warren <command> <file.warren.json>', inRepo: 'node bin/warren.ts <command> <file.warren.json>' },
    guide: 'AGENTS.md',
    units: UNITS,
    knows: 'Warren holds a drawing, places things by arithmetic and checks claims rigorously. It cannot read a floor plan — deciding which rectangle is the kitchen is the caller’s job, and arrives as ops.',
    commands: Object.entries(MANUAL as Record<string, Entry>).map(([name, entry]) => ({
      name,
      summary: entry.summary,
      usage: entry.usage,
      writes: entry.writes === true,
      flags: [...(entry.flags ?? []), ...EVERYWHERE].map(([flag, does]) => ({ flag, does })),
      examples: entry.examples ?? [],
      notes: entry.notes ?? [],
    })),
    apply: {
      file: 'an array of ops, or {"ops": [...]}',
      atomic: 'every op is validated before any is applied; if one fails, nothing is written and the exit code is 1',
      ops: Object.entries(OPS).map(([op, { does, fields }]) => ({ op, does, fields })),
      patchable: [...PATCHABLE],
    },
    enums: {
      level: [...LEVELS],
      itemKind: [...ITEM_KINDS],
      addableKind: [...ADDABLE_KINDS],
      roomUse: [...ROOM_USES],
      markerSymbol: [...MARKER_SYMBOLS],
      category: [...CATEGORIES],
      flow: ['none', 'forward', 'reverse'],
      placement: [...PLACEMENTS],
    },
    exitCodes: EXIT,
  }
}

function version(): string {
  try {
    const raw: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const found = (raw as { version?: unknown }).version
    return typeof found === 'string' ? found : 'unknown'
  } catch {
    return 'unknown'
  }
}

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    row = next
  }
  return row[b.length]
}

/** A wrong command is usually a near miss — `takoff`, `sytems` — so say what was probably meant. */
export function nearest(word: string): string | null {
  const names = Object.keys(MANUAL)
  const prefix = names.find((n) => n.startsWith(word) || word.startsWith(n))
  if (prefix) return prefix
  const [best] = names
    .map((n) => ({ n, d: distance(word.toLowerCase(), n) }))
    .filter(({ d, n }) => d <= Math.max(2, Math.floor(n.length / 3)))
    .sort((x, y) => x.d - y.d)
  return best?.n ?? null
}
