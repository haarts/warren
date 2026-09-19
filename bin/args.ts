/**
 * Turns argv into a command plus flags. No knowledge of what any particular command wants — that
 * belongs to the command, which reads `args.flags` and `args.positional` for itself. Also the one
 * place a command line fails outright, with exit code 2 (the command line was wrong, as opposed
 * to 1: the file was read but the answer is bad news).
 */
export interface Args {
  command: string
  positional: string[]
  flags: Record<string, string | true>
}

export function parseArgs(argv: string[]): Args {
  // A leading flag is not a command: `warren --help` and `warren -h` are asking for help, and
  // being told "no such command: --help" would be a poor first impression.
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

export function fail(message: string): never {
  process.stderr.write(`warren: ${message}\n`)
  process.exit(2)
}
