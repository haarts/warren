/**
 * Sets a sheet's scale without the app: from a number, from the scale printed on the page, or
 * by copying another sheet's. The app's two-click calibration measures a dimension; this is for
 * when the answer is already known - two pages of one drawing set, printed at one scale on one
 * paper size, should not disagree because each was clicked separately.
 */
import { fail, type Args } from '../args.ts'
import { load, persist } from '../project.ts'
import { sheetOf } from '../units.ts'

/** Millimetres of paper per PDF point: a point is 1/72 inch. */
const PAPER_MM_PER_POINT = 25.4 / 72

export async function cmdCalibrate(args: Args): Promise<void> {
  const loaded = await load(args)
  const { project } = loaded
  const targets = sheetOf(project, args.flags.sheet as string | true | undefined)
  if (args.flags.sheet === undefined && project.sheets.length > 1) fail('which sheet? pass --sheet <n|name>')
  if (targets.length !== 1) fail(`--sheet "${String(args.flags.sheet)}" matches ${targets.length} sheets: ${targets.map((s) => s.name).join(', ')}`)
  const sheet = targets[0]

  const given = ['mm-per-point', 'scale', 'like'].filter((f) => args.flags[f] !== undefined)
  if (given.length !== 1) fail('give exactly one of --mm-per-point <n>, --scale 1:<n> or --like <sheet>')

  let mmPerPoint: number | null = null
  let how = ''
  if (args.flags['mm-per-point'] !== undefined) {
    mmPerPoint = Number(args.flags['mm-per-point'])
    how = 'as given'
  } else if (args.flags.scale !== undefined) {
    const match = /^1\s*:\s*(\d+(?:\.\d+)?)$/.exec(String(args.flags.scale))
    if (!match) fail('--scale is written 1:<n>, e.g. 1:100')
    mmPerPoint = PAPER_MM_PER_POINT * Number(match![1])
    how = `from ${args.flags.scale} at the page's own paper size`
  } else {
    const from = sheetOf(project, args.flags.like as string)
    if (from.length !== 1) fail(`--like "${String(args.flags.like)}" matches ${from.length} sheets`)
    if (from[0] === sheet) fail('--like names the same sheet')
    mmPerPoint = from[0].mmPerPoint
    if (mmPerPoint === null) fail(`"${from[0].name}" is not calibrated either`)
    how = `copied from "${from[0].name}"`
  }
  if (!(mmPerPoint! > 0) || !isFinite(mmPerPoint!)) fail('the scale must be a positive number')

  const before = sheet.mmPerPoint
  sheet.mmPerPoint = mmPerPoint
  await persist(loaded)
  const change = before ? ` (was ${before.toFixed(4)}, ${(((mmPerPoint! / before) - 1) * 100).toFixed(2)}%)` : ''
  console.log(`${sheet.name}: 1 pt = ${mmPerPoint!.toFixed(4)} mm, ${how}${change}`)
  // Items are stored in points, so they stay put on the plan; what they measure is what moves.
  if (before && sheet.items.length) console.log(`  its ${sheet.items.length} item(s) stay where they are drawn; their lengths in metres change with the scale`)
}
