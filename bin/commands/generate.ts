/**
 * Runs the placement rules. Warren supplies the arithmetic; the rules supply the opinion, and
 * the rooms supply the understanding — which came from a person or an AI, not from here.
 */
import { basename } from 'node:path'
import { applyGenerated, generate, rulesOf, type GenerateRule } from '../../src/generate.ts'
import { fail, type Args } from '../args.ts'
import { load, persist } from '../project.ts'
import { pointAtM, sheetOf } from '../units.ts'

export async function cmdGenerate(args: Args): Promise<void> {
  const loaded = await load(args)
  const { project, store, path } = loaded
  const only = typeof args.flags.rule === 'string' ? args.flags.rule : null
  const rooms = typeof args.flags.room === 'string' ? args.flags.room.split(',') : undefined
  const clear = args.flags.clear === true
  const dryRun = args.flags['dry-run'] === true
  const sheets = sheetOf(project, args.flags.sheet)

  const rules = rulesOf(store)
    .filter((r) => r.enabled || only)
    .filter((r) => !only || r.id === only)
    .map((r) => applyOverrides(r, args.flags.set))
  if (only && rules.length === 0) {
    fail(`no rule called "${only}". Rules: ${rulesOf(store).map((r) => r.id).join(', ')}`)
  }
  if (args.flags.save) {
    if (!only) fail('--save needs --rule, so it is clear which rule is being changed')
    project.rules = rulesOf(store).map((r) => (r.id === only ? rules[0] : r))
  }

  const report: Record<string, unknown>[] = []
  for (const sheet of sheets) {
    for (const rule of rules) {
      const result = generate(sheet, rule, { rooms })
      // --clear wipes this rule's output for the scope and puts nothing back.
      const effective = clear ? { ...result, create: [] } : result
      report.push({
        sheet: sheet.name,
        rule: rule.id,
        wouldCreate: effective.create.length,
        replacing: effective.replace.length,
        leftAlone: effective.adopted.length,
        rooms: effective.rooms,
        placed: effective.create.map((i) => ({
          id: i.id, symbol: i.symbol, atM: pointAtM(sheet, { x: i.x, y: i.y }),
        })),
      })
      if (!dryRun) applyGenerated(sheet, effective)
    }
  }

  if (args.flags.json) return void console.log(JSON.stringify(report, null, 2))
  for (const r of report) {
    const verb = clear ? 'cleared' : 'placed'
    const where = (r.rooms as string[]).length ? `  in ${(r.rooms as string[]).join(', ')}` : ''
    console.log(`${String(r.sheet).padEnd(22)} ${String(r.rule).padEnd(12)} ${String(r.wouldCreate).padStart(4)} ${verb}, `
      + `${String(r.replacing).padStart(3)} replaced, ${String(r.leftAlone).padStart(3)} left alone${where}`)
    if (args.flags.where) {
      for (const p of r.placed as { symbol: string; atM: [number, number] | null }[]) {
        console.log(`    ${p.symbol.padEnd(10)} ${p.atM ? `${p.atM[0]}, ${p.atM[1]} m` : 'uncalibrated'}`)
      }
    }
  }
  if (dryRun) return void console.log('nothing written')
  await persist(loaded)
  console.log(`written to ${basename(path)}${args.flags.save ? ` (rule "${only}" saved)` : ''}`)
}

/**
 * Trial changes to a rule for one run: `--set perWall=3,insetMm=600`. Nothing is written back
 * unless --save says so, so a parameter can be tried on one room and thrown away.
 */
function applyOverrides(rule: GenerateRule, raw: string | true | undefined): GenerateRule {
  if (typeof raw !== 'string') return rule
  const out = { ...rule } as unknown as Record<string, unknown>
  for (const pair of raw.split(',')) {
    const at = pair.indexOf('=')
    if (at < 0) fail(`--set wants key=value, got "${pair}"`)
    const key = pair.slice(0, at).trim()
    const value = pair.slice(at + 1).trim()
    if (!(key in rule)) {
      fail(`a rule has no "${key}". Fields: ${Object.keys(rule).filter((k) => k !== 'id').join(', ')}`)
    }
    const was = (rule as unknown as Record<string, unknown>)[key]
    if (typeof was === 'number') {
      const n = Number(value)
      if (!isFinite(n)) fail(`${key} wants a number, got "${value}"`)
      out[key] = n
    } else if (typeof was === 'boolean') {
      out[key] = value === 'true'
    } else if (Array.isArray(was)) {
      out[key] = value === '' ? [] : value.split('|')
    } else {
      out[key] = value
    }
  }
  return out as unknown as GenerateRule
}
