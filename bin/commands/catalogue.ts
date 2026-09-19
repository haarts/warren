/**
 * The systems catalogue and the placement rules: the two things a project carries about itself
 * beyond the drawing. `systems` dispatches on which flag was given — add-missing, set-sizes or
 * merge are mutually exclusive modes, so a table of {flag → mode} reads better than an if-chain
 * that re-checks flags already ruled out.
 */
import { readFileSync } from 'node:fs'
import { rulesOf } from '../../src/generate.ts'
import { missingDefaults } from '../../src/model/systems.ts'
import { fail, type Args } from '../args.ts'
import { load, persist, type Loaded } from '../project.ts'

type Mode = (loaded: Loaded, args: Args) => Promise<void> | void

const SYSTEMS_MODES: [test: (args: Args) => boolean, run: Mode][] = [
  [(args) => Boolean(args.flags['add-missing']), async (loaded) => {
    const missing = missingDefaults(loaded.project.systems)
    if (missing.length === 0) return void console.log('catalogue is already complete')
    loaded.project.systems.push(...missing)
    await persist(loaded)
    console.log(`added ${missing.length}: ${missing.map((s) => s.id).join(', ')}`)
  }],
  [(args) => typeof args.flags['set-sizes'] === 'string', async (loaded, args) => {
    const id = args.flags['set-sizes'] as string
    const sys = loaded.project.systems.find((s) => s.id === id)
    if (!sys) fail(`no system called ${id} — see \`warren systems ${loaded.path}\` for the ones this project has`)
    const sizesArg = typeof args.flags.sizes === 'string' ? args.flags.sizes : null
    if (!sizesArg) fail('usage: warren systems <file> --set-sizes <id> --sizes "a,b,c"')
    const sizes = sizesArg.split(',').map((v) => v.trim()).filter(Boolean)
    if (sizes.length === 0) fail('--sizes needs at least one value')
    // The suggestion list, not a constraint — an item can still carry any size text. This only
    // changes what the combo box offers and which one is pre-selected (always the first).
    sys.sizes = sizes
    sys.defaultSize = sizes[0]
    await persist(loaded)
    console.log(`${id}: sizes set to ${sizes.join(', ')} (default: ${sizes[0]})`)
  }],
  [(args) => typeof args.flags.merge === 'string', async (loaded, args) => {
    const { project } = loaded
    const into = typeof args.flags.into === 'string' ? args.flags.into : null
    if (!into) fail('usage: warren systems <file> --merge a,b --into c')
    const sources = (args.flags.merge as string).split(',').map((v) => v.trim()).filter(Boolean)
    if (sources.includes(into)) fail(`--into ${into} cannot also be in --merge`)

    const have = new Set(project.systems.map((s) => s.id))
    const unknown = sources.filter((id) => !have.has(id))
    if (unknown.length) fail(`this project has no system called ${unknown.join(', ')}`)

    if (!have.has(into)) {
      const seed = missingDefaults(project.systems).find((s) => s.id === into)
      if (!seed) fail(`no system called ${into}, and it is not one of the built-in defaults either`)
      project.systems.push(seed)
      console.log(`added ${into} from the defaults`)
    }

    let moved = 0
    for (const sheet of project.sheets) {
      for (const item of sheet.items) {
        if (!sources.includes(item.systemId)) continue
        item.systemId = into
        moved += 1
      }
    }
    project.systems = project.systems.filter((s) => !sources.includes(s.id))
    await persist(loaded)
    console.log(`moved ${moved} item(s) to ${into}, removed ${sources.join(', ')}`)
  }],
]

/**
 * A project carries its own catalogue, so one saved before a system existed does not have it.
 * The app offers this in the Systems editor; without it here, nothing headless could draw a
 * room in an older project.
 */
export async function cmdSystems(args: Args): Promise<void> {
  const loaded = await load(args)
  const { project } = loaded
  const missing = missingDefaults(project.systems)

  const mode = SYSTEMS_MODES.find(([test]) => test(args))
  if (mode) return void await mode[1](loaded, args)

  if (args.flags.json) {
    return void console.log(JSON.stringify({
      systems: project.systems.map((s) => ({
        id: s.id, name: s.name, category: s.category, sizes: s.sizes ?? null, assumeFlow: s.assumeFlow ?? false,
      })),
      missingDefaults: missing.map((s) => s.id),
    }, null, 2))
  }
  for (const sys of project.systems) {
    console.log(`${sys.id.padEnd(22)} ${sys.category.padEnd(8)} ${sys.name}`)
  }
  if (missing.length) console.log(`\n${missing.length} default system(s) missing: ${missing.map((s) => s.id).join(', ')} — add with --add-missing`)
}

/** The rules themselves, so they can be read and replaced without opening the app. */
export async function cmdRules(args: Args): Promise<void> {
  const loaded = await load(args)
  const { project, store } = loaded
  if (typeof args.flags.set === 'string') {
    const incoming: unknown = JSON.parse(readFileSync(args.flags.set, 'utf8'))
    const list = Array.isArray(incoming) ? incoming : (incoming as { rules?: unknown }).rules
    if (!Array.isArray(list)) fail('expected an array of rules, or {"rules": [...]}')
    project.rules = list as typeof project.rules
    await persist(loaded)
    return void console.log(`set ${list.length} rule(s)`)
  }
  const rules = rulesOf(store)
  if (args.flags.json) return void console.log(JSON.stringify(rules, null, 2))
  for (const r of rules) {
    console.log(`${r.id.padEnd(12)} ${r.enabled ? 'on ' : 'off'} ${r.place.padEnd(16)} ${r.systemId.padEnd(16)} ${r.uses?.join(',') ?? 'any room'}`)
  }
  console.log(`\n${project.rules ? 'from this project' : 'built-in defaults; --set rules.json to replace them'}`)
}
