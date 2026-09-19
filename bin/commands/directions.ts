/**
 * Which way is which - one answer for the whole project, since every sheet is drawn the same way
 * round or nothing passing between floors would line up. Usually one compass rose with four
 * named tips, set once from whatever the plan shows and reused after that instead of re-derived
 * by eye each time; the one-off list is for a bearing the rose does not cover. Reads go through
 * `directionsOf`, the same accessor the app uses.
 *
 * `directions` dispatches on which flag was given — --compass, --remove-compass, --set, --remove,
 * --resolve and --toward are mutually exclusive modes, so a table of {test → mode} stands in for
 * the if-chain that would otherwise re-check flags already ruled out.
 */
import { directionsOf, pointToward, resolveDirection, splitNames, tipBearing } from '../../src/directions.ts'
import type { CompassRose, Project, Sheet } from '../../src/model/types.ts'
import { fail, type Args } from '../args.ts'
import { load, persist, type Loaded } from '../project.ts'
import { metres, pointsFromMetres, round, sheetOf } from '../units.ts'

type Mode = (loaded: Loaded, args: Args, scaleSheet: () => Sheet) => Promise<void>

const DIRECTIONS_MODES: [test: (args: Args) => boolean, run: Mode][] = [
  [(args) => Boolean(args.flags.compass), async (loaded, args, scaleSheet) => {
    const { project } = loaded
    const rose: CompassRose = project.compass
      ? { ...project.compass, tips: [...project.compass.tips] as CompassRose['tips'] }
      : { x: 0, y: 0, rotationDeg: 0, tips: ['', '', '', ''] }
    if (!project.compass) {
      // Where it lands only matters to the eye: the middle of the first page is as good as anywhere.
      const page = project.sheets[0]?.pdf
      rose.x = (page?.widthPt ?? 0) / 2
      rose.y = (page?.heightPt ?? 0) / 2
    }
    if (args.flags.rotation !== undefined) {
      if (typeof args.flags.rotation !== 'string' || !isFinite(Number(args.flags.rotation))) fail('--rotation needs a number of degrees')
      rose.rotationDeg = ((Number(args.flags.rotation) % 360) + 360) % 360
    }
    if (args.flags.tips !== undefined) {
      if (typeof args.flags.tips !== 'string') fail('--tips needs a value: "north,noord; east; south,tuin; west"')
      const parts = (args.flags.tips as string).split(';')
      if (parts.length !== 4) fail(`--tips replaces all four tips, so it needs exactly four, separated by ";" — got ${parts.length}. To change one, use --tip <n> --names "..."`)
      rose.tips = parts.map((part) => splitNames(part).join(', ')) as CompassRose['tips']
    }
    if (args.flags.tip !== undefined) {
      const n = Number(args.flags.tip)
      if (![1, 2, 3, 4].includes(n)) fail('--tip is 1, 2, 3 or 4')
      if (typeof args.flags.names !== 'string') fail('--tip needs --names "a, b" — every name for that tip, as it should read afterwards')
      rose.tips[n - 1] = splitNames(args.flags.names as string).join(', ')
    }
    if (args.flags.at !== undefined) {
      const [xM, yM] = String(args.flags.at).split(',').map(Number)
      if (!isFinite(xM) || !isFinite(yM)) fail('--at must be "xM,yM"')
      const sheet = scaleSheet()
      const x = pointsFromMetres(sheet, xM)
      const y = pointsFromMetres(sheet, yM)
      if (x === null || y === null) fail(`sheet "${sheet.name}" has no scale, so --at in metres means nothing there`)
      rose.x = x!
      rose.y = y!
    }
    project.compass = rose
    await persist(loaded)
    console.log(describeCompass(project))
  }],
  [(args) => Boolean(args.flags['remove-compass']), async (loaded) => {
    const { project } = loaded
    const had = !!project.compass
    delete project.compass
    await persist(loaded)
    console.log(had ? 'removed the compass rose' : 'there was no compass rose')
  }],
  [(args) => typeof args.flags.set === 'string', async (loaded, args) => {
    const { project } = loaded
    const id = args.flags.set as string
    if (typeof args.flags.bearing !== 'string' || !isFinite(Number(args.flags.bearing))) {
      fail('usage: warren directions <file> --set <id> --bearing <deg> [--aliases "a,b,c"]')
    }
    const bearingDeg = ((Number(args.flags.bearing) % 360) + 360) % 360
    const aliases = typeof args.flags.aliases === 'string' ? splitNames(args.flags.aliases) : []
    const list = project.directions ?? (project.directions = [])
    const existing = list.find((d) => d.id === id)
    if (existing) { existing.bearingDeg = bearingDeg; existing.aliases = aliases }
    else list.push({ id, bearingDeg, aliases })
    await persist(loaded)
    console.log(`${id}: ${round(bearingDeg, 1)}°, aliases: ${aliases.join(', ') || '(none)'}`)
  }],
  [(args) => typeof args.flags.remove === 'string', async (loaded, args) => {
    const { project } = loaded
    const id = args.flags.remove as string
    const before = project.directions?.length ?? 0
    project.directions = (project.directions ?? []).filter((d) => d.id !== id)
    const removed = before - project.directions.length
    if (project.directions.length === 0) delete project.directions
    await persist(loaded)
    console.log(removed
      ? `removed "${id}"`
      : `no one-off direction called "${id}" — a compass rose tip is renamed with --compass --tip <n> --names, not removed here`)
  }],
  [(args) => typeof args.flags.resolve === 'string', async (loaded, args) => {
    const dir = resolveDirection(loaded.project, args.flags.resolve as string)
    if (!dir) {
      const known = directionsOf(loaded.project).flatMap((d) => d.aliases.length ? d.aliases : [d.id])
      fail(`"${args.flags.resolve}" matches no direction. Known: ${known.join(', ') || '(none set)'}`)
    }
    const from = dir!.source === 'compass' ? `compass rose tip ${dir!.tip! + 1}` : 'one-off direction'
    console.log(`"${args.flags.resolve}" → ${dir!.id}: ${round(dir!.bearingDeg, 1)}°, ${from}`)
  }],
  [(args) => typeof args.flags.toward === 'string', async (loaded, args, scaleSheet) => {
    const sheet = scaleSheet()
    const fromArg = typeof args.flags.from === 'string' ? args.flags.from : null
    const distanceM = typeof args.flags.distanceM === 'string' ? Number(args.flags.distanceM) : NaN
    if (!fromArg || !isFinite(distanceM)) {
      fail('usage: warren directions <file> --toward <term> --from <xM,yM> --distanceM <d> [--sheet <n|name>]')
    }
    const [fxM, fyM] = fromArg.split(',').map(Number)
    if (!isFinite(fxM) || !isFinite(fyM)) fail('--from must be "xM,yM"')
    const fx = pointsFromMetres(sheet, fxM)
    const fy = pointsFromMetres(sheet, fyM)
    if (fx === null || fy === null) fail(`sheet "${sheet.name}" has no scale, so metres mean nothing here`)
    const distancePt = pointsFromMetres(sheet, distanceM)!
    const target = pointToward(loaded.project, { x: fx!, y: fy! }, args.flags.toward as string, distancePt)
    if (!target) fail(`"${args.flags.toward}" matches no direction`)
    console.log(JSON.stringify({ xM: round(metres(sheet, target!.x)!), yM: round(metres(sheet, target!.y)!) }))
  }],
]

export async function cmdDirections(args: Args): Promise<void> {
  const loaded = await load(args)
  const { project } = loaded
  // Only needed to turn metres into points: the rose's position and --toward's arithmetic.
  const scaleSheet = (): Sheet => sheetOf(project, args.flags.sheet)[0]

  const mode = DIRECTIONS_MODES.find(([test]) => test(args))
  if (mode) return void await mode[1](loaded, args, scaleSheet)

  if (args.flags.json) {
    return void console.log(JSON.stringify({
      compass: project.compass
        ? { rotationDeg: round(project.compass.rotationDeg, 1), tips: project.compass.tips }
        : null,
      directions: directionsOf(project).map((d) => ({ ...d, bearingDeg: round(d.bearingDeg, 1) })),
    }, null, 2))
  }
  console.log(describeCompass(project))
  const others = project.directions ?? []
  if (others.length) console.log('other directions:')
  for (const d of others) {
    console.log(`  ${d.id.padEnd(14)} ${`${round(d.bearingDeg, 1)}°`.padStart(7)}  ${d.aliases.join(', ')}`)
  }
}

function describeCompass(project: Project): string {
  const rose = project.compass
  if (!rose) return 'no compass rose'
  const lines = [`compass rose (every sheet), tip 1 at ${round(rose.rotationDeg, 1)}°`]
  rose.tips.forEach((names, tip) => {
    const b = tipBearing(rose, tip)
    lines.push(`  tip ${tip + 1} ${`${round(b, 1)}°`.padStart(7)}  ${names || '(unnamed)'}`)
  })
  return lines.join('\n')
}
