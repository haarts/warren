/**
 * Lines floors up, the command-line half of the app's Align tool. Each sheet records where the
 * same two physical spots are on it - grid-line crossings, a stair corner - and from those two
 * pairs every point can be carried between floors, however each page was placed or scaled.
 *
 * Without --sheet it reports: which sheets are aligned, and whether their calibrations agree
 * about the distance between the two spots. With --sheet, --a and --b it records them.
 */
import { CALIBRATION_TOLERANCE, calibrationAgreement, floorMapping, placeByClicks } from '../../src/align.ts'
import type { Pt } from '../../src/geom.ts'
import type { Sheet } from '../../src/model/types.ts'
import { fail, type Args } from '../args.ts'
import { load, persist } from '../project.ts'
import { pointAtM, pointsFromMetres, round, sheetOf } from '../units.ts'

export async function cmdAlign(args: Args): Promise<void> {
  const loaded = await load(args)
  const { project } = loaded

  if (args.flags.sheet === undefined) {
    if (args.flags.a !== undefined || args.flags.b !== undefined) fail('which sheet? pass --sheet <n|name> with --a and --b')
    return report(project.sheets, project.alignNames, Boolean(args.flags.json))
  }

  const targets = sheetOf(project, args.flags.sheet as string)
  if (targets.length !== 1) fail(`--sheet "${String(args.flags.sheet)}" matches ${targets.length} sheets`)
  const sheet = targets[0]

  if (args.flags.remove) {
    delete sheet.align
    await persist(loaded)
    console.log(`${sheet.name}: alignment removed`)
    return
  }
  if (args.flags.a === undefined || args.flags.b === undefined) fail('give both --a and --b: the two reference points on this sheet')
  const inPoints = Boolean(args.flags.points)
  const read = (flag: 'a' | 'b'): Pt => {
    const [x, y] = String(args.flags[flag]).split(',').map(Number)
    if (!isFinite(x) || !isFinite(y)) fail(`--${flag} must be "x,y"`)
    if (inPoints) return { x, y }
    const px = pointsFromMetres(sheet, x)
    const py = pointsFromMetres(sheet, y)
    if (px === null || py === null) fail(`"${sheet.name}" has no scale, so --${flag} in metres means nothing there; pass --points to give PDF points`)
    return { x: px!, y: py! }
  }
  const a = read('a')
  const b = read('b')
  if (a.x === b.x && a.y === b.y) fail('--a and --b are the same point; they need to be two spots, as far apart as the plan allows')
  // Floors lined up by eye keep their placement relative to this one; see placeByClicks.
  placeByClicks(project.sheets, sheet, a, b)
  if (typeof args.flags.names === 'string') {
    const [n1 = '', n2 = ''] = args.flags.names.split(',').map((s) => s.trim())
    project.alignNames = [n1, n2]
  }
  await persist(loaded)
  console.log(`${sheet.name}: aligned`)
  report(project.sheets, project.alignNames, false)
}

function report(sheets: Sheet[], names: [string, string] | undefined, json: boolean): void {
  const aligned = sheets.filter((s) => s.align)
  const pairs: { sheets: [string, string]; aM: number; bM: number; offPct: number; agrees: boolean }[] = []
  for (let i = 0; i < aligned.length; i++) {
    for (let j = i + 1; j < aligned.length; j++) {
      const agree = calibrationAgreement(aligned[i], aligned[j])
      if (!agree) continue
      pairs.push({
        sheets: [aligned[i].name, aligned[j].name], aM: round(agree.aMm / 1000, 3), bM: round(agree.bMm / 1000, 3),
        offPct: round(agree.off * 100, 2), agrees: agree.off <= CALIBRATION_TOLERANCE,
      })
    }
  }
  const rows = sheets.map((s) => ({
    sheet: s.name,
    aligned: Boolean(s.align),
    byEye: s.align?.byEye === true,
    a: s.align ? pointAtM(s, s.align.a) : null,
    b: s.align ? pointAtM(s, s.align.b) : null,
    // How this floor sits against the first aligned one: worth seeing when it is not ~0° and ~1.
    against: s.align && aligned[0] && aligned[0] !== s
      ? (() => { const m = floorMapping(s, aligned[0])!; return { sheet: aligned[0].name, turnDeg: round(m.turnDeg, 2), scale: round(m.scale, 4) } })()
      : null,
  }))
  if (json) {
    console.log(JSON.stringify({ names: names ?? null, sheets: rows, calibration: pairs }, null, 2))
    return
  }
  if (names) console.log(`reference points: ${names[0] || 'A'}, ${names[1] || 'B'}`)
  for (const r of rows) {
    console.log(r.aligned
      ? `  ${r.sheet}: ${r.byEye ? 'lined up by eye' : 'aligned'}${r.a ? ` — A at ${r.a.join(', ')} m, B at ${r.b!.join(', ')} m` : ''}${r.against ? `; against ${r.against.sheet}: turned ${r.against.turnDeg}°, ×${r.against.scale}` : ''}`
      : `  ${r.sheet}: not aligned — risers and copies cannot be placed between it and another floor`)
  }
  for (const p of pairs) {
    console.log(p.agrees
      ? `  ${p.sheets[0]} and ${p.sheets[1]} agree on the scale (${p.offPct}% apart)`
      : `  ${p.sheets[0]} and ${p.sheets[1]} DISAGREE: the points are ${p.aM} m vs ${p.bM} m apart (${p.offPct}%) — one calibration is wrong`)
  }
}
