/**
 * Lines floors up, the command-line half of the app's "Underneath" and by-eye pad. A floor is
 * placed against another - the same spot on its page, at the size the calibrations imply - and
 * then nudged: shifted, turned, sized. Points are carried between floors through that placement.
 *
 * Without --sheet it reports which floors are lined up, how each sits against the first, and
 * whether their calibrations agree about it.
 */
import { CALIBRATION_TOLERANCE, calibrationAgreement, ensurePlaced, floorMapping, nudgeAlignment } from '../../src/align.ts'
import type { Sheet } from '../../src/model/types.ts'
import { fail, type Args } from '../args.ts'
import { load, persist } from '../project.ts'
import { pointsFromMetres, round, sheetOf } from '../units.ts'

export async function cmdAlign(args: Args): Promise<void> {
  const loaded = await load(args)
  const { project } = loaded
  const flags = args.flags

  if (flags.sheet === undefined) {
    for (const f of ['under', 'shift', 'turn', 'grow', 'remove']) if (flags[f] !== undefined) fail(`which sheet? pass --sheet <n|name> with --${f}`)
    return report(project.sheets, Boolean(flags.json))
  }
  const one = (raw: unknown, flag: string): Sheet => {
    const found = sheetOf(project, raw as string)
    if (found.length !== 1) fail(`${flag} "${String(raw)}" matches ${found.length} sheets`)
    return found[0]
  }
  const sheet = one(flags.sheet, '--sheet')

  if (flags.remove) {
    delete sheet.align
    await persist(loaded)
    console.log(`${sheet.name}: no longer lined up`)
    return
  }

  let changed = false
  if (flags.under !== undefined) {
    const other = one(flags.under, '--under')
    if (other === sheet) fail('--under names the same sheet as --sheet')
    changed = ensurePlaced(sheet, other)
    if (!changed) console.log(`${sheet.name} and ${other.name} were already lined up; left as they were`)
  }

  const pair = (raw: unknown, flag: string): [number, number] => {
    const [x, y] = String(raw).split(',').map(Number)
    if (!isFinite(x) || !isFinite(y)) fail(`${flag} must be "x,y" in metres`)
    return [x, y]
  }
  const pt = (m: number, flag: string): number => {
    const v = pointsFromMetres(sheet, m)
    if (v === null) fail(`"${sheet.name}" has no scale, so ${flag} in metres means nothing there`)
    return v!
  }
  if (flags.shift !== undefined || flags.turn !== undefined || flags.grow !== undefined) {
    if (!sheet.align) fail(`"${sheet.name}" is not lined up with anything yet; start with --under <sheet>`)
    const [dx, dy] = flags.shift !== undefined ? pair(flags.shift, '--shift') : [0, 0]
    const turnDeg = flags.turn !== undefined ? Number(flags.turn) : 0
    const grow = flags.grow !== undefined ? Number(flags.grow) : 0
    if (!isFinite(turnDeg)) fail('--turn takes degrees, clockwise on screen')
    if (!isFinite(grow) || grow <= -100) fail('--grow takes a percentage, e.g. 0.3 or -0.3')
    const page = { w: sheet.pdf?.widthPt ?? 842, h: sheet.pdf?.heightPt ?? 595 }
    const [ax, ay] = flags.about !== undefined ? pair(flags.about, '--about') : [null, null]
    const pivot = ax === null ? { x: page.w / 2, y: page.h / 2 } : { x: pt(ax, '--about'), y: pt(ay!, '--about') }
    sheet.align = nudgeAlignment(sheet.align!, {
      dx: dx ? pt(dx, '--shift') : 0, dy: dy ? pt(dy, '--shift') : 0, turnDeg, factor: 1 + grow / 100, pivot,
    })
    changed = true
  }
  if (!changed && flags.under === undefined) fail('nothing to do: give --under, --shift, --turn, --grow or --remove')
  if (changed) await persist(loaded)
  report(project.sheets, false)
}

function report(sheets: Sheet[], json: boolean): void {
  const placed = sheets.filter((s) => s.align)
  const pairs: { sheets: [string, string]; offPct: number; agrees: boolean }[] = []
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const agree = calibrationAgreement(placed[i], placed[j])
      if (!agree) continue
      pairs.push({ sheets: [placed[i].name, placed[j].name], offPct: round(agree.off * 100, 2), agrees: agree.off <= CALIBRATION_TOLERANCE })
    }
  }
  const rows = sheets.map((s) => ({
    sheet: s.name,
    linedUp: Boolean(s.align),
    // How the other floors sit on this one: worth seeing when it is not ~0° and ~1.
    against: s.align && placed[0] && placed[0] !== s
      ? (() => { const m = floorMapping(placed[0], s)!; return { sheet: placed[0].name, turnDeg: round(m.turnDeg, 3), scale: round(m.scale, 4) } })()
      : null,
  }))
  if (json) return void console.log(JSON.stringify({ sheets: rows, calibration: pairs }, null, 2))
  for (const r of rows) {
    console.log(r.linedUp
      ? `  ${r.sheet}: lined up${r.against ? ` — ${r.against.sheet} sits on it turned ${r.against.turnDeg}°, ×${r.against.scale}` : ''}`
      : `  ${r.sheet}: not lined up — risers and copies cannot be placed between it and another floor`)
  }
  for (const p of pairs) {
    console.log(p.agrees
      ? `  ${p.sheets[0]} and ${p.sheets[1]} agree on the scale (${p.offPct}% apart)`
      : `  ${p.sheets[0]} and ${p.sheets[1]} DISAGREE on the scale by ${p.offPct}% — if the walls line up, one calibration is wrong`)
  }
}
