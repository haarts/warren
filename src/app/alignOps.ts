/**
 * Lining floors up: two clicks on this sheet at the two spots every floor shares, and then the
 * question nobody else can answer - when two floors' calibrations disagree about how far apart
 * those spots are, which one is right.
 */
import type { Pt } from '../geom.ts'
import { CALIBRATION_TOLERANCE, calibrationAgreement, placeByClicks, scaleFromAlignment } from '../align.ts'
import type { Sheet } from '../model/types.ts'
import { formatMetres } from '../units.ts'
import { cancelMeasurement } from '../interact/pointer.ts'
import { askText, chooseDialog } from '../ui/modal.ts'
import type { App } from '../app.ts'

/** The two points, as the people working on the plan call them - or just A and B. */
export function alignPointNames(app: App): [string, string] {
  const names = app.store.project.alignNames
  return [names?.[0] || 'A', names?.[1] || 'B']
}

/** Other sheets that are aligned, the ones a point on this sheet can be carried to. */
export function alignedOthers(app: App, sheet: Sheet = app.store.sheet): Sheet[] {
  return app.store.project.sheets.filter((s) => s.id !== sheet.id && s.align)
}

/** Other floors whose pair is two spots somebody clicked - the ones a click here must match. */
export function clickedOthers(app: App, sheet: Sheet = app.store.sheet): Sheet[] {
  return alignedOthers(app, sheet).filter((s) => !s.align!.byEye)
}

export function startAlign(app: App): void {
  app.editor.setTool('align')
  const [a] = alignPointNames(app)
  const clicked = clickedOthers(app)
  app.editor.flash(clicked.length === 0
    ? 'Click a spot you can find on every floor - a grid-line crossing, a stair corner, a shaft'
    : `Click ${a} - the same spot you clicked on ${clicked[0].name}`)
}

/** Fired by the align tool once both points are clicked. */
export async function completeAlignment(app: App, a: Pt, b: Pt): Promise<void> {
  const { store, editor } = app
  const sheet = store.sheet
  const first = clickedOthers(app).length === 0 && !store.project.alignNames

  let names: [string, string] | null = null
  if (first) {
    const typed = await askText({
      title: 'What did you click?',
      label: 'The two spots',
      placeholder: 'A1, C4   or   stair corner, shaft',
      hint: 'Optional, comma-separated. On the next floor Warren asks for these two by name, ' +
        'so you click the same spots there.',
    })
    if (typed === null) {
      cancelMeasurement(editor)
      return
    }
    const parts = typed.split(',').map((s) => s.trim())
    if (parts[0] || parts[1]) names = [parts[0] ?? '', parts[1] ?? '']
  }

  // Before the change: which floors a click has to agree with, rather than carry along.
  const clicked = clickedOthers(app)
  editor.edit(null, () => {
    placeByClicks(store.project.sheets, sheet, a, b)
    if (names) store.project.alignNames = names
  })
  cancelMeasurement(editor)
  editor.setTool('select')

  const others = clicked
  if (others.length === 0) {
    editor.flash(alignedOthers(app).length
      ? `${sheet.name} has its two reference points; floors lined up by eye stay where they were`
      : `${sheet.name} has its two reference points. Now click the same two spots on another floor, or line one up by eye.`)
    app.refresh()
    return
  }
  // The floor this one is checked against: a calibrated one if there is one.
  const reference = others.find((s) => s.mmPerPoint) ?? others[0]
  editor.ghostSheetId = reference.id
  await reconcileScale(app, sheet, reference)
  editor.flash(`${sheet.name} now lines up with ${others.map((s) => s.name).join(', ')} — shown faintly underneath`)
  app.refresh()
}

/**
 * Two floors, one physical distance between the reference points. When their calibrations
 * disagree about it by more than a percent, one of them is wrong, and only the person who
 * clicked them can say which. An uncalibrated sheet can simply take the other's word for it.
 */
async function reconcileScale(app: App, sheet: Sheet, reference: Sheet): Promise<void> {
  const { store } = app
  const setScale = (target: Sheet, mmPerPoint: number): void => {
    store.mutate(() => { target.mmPerPoint = mmPerPoint })
  }

  if (!sheet.mmPerPoint && reference.mmPerPoint) {
    const scale = scaleFromAlignment(sheet, reference)
    if (!scale) return
    const take = await chooseDialog('Calibrate from the other floor?',
      `${sheet.name} has no scale yet. ${reference.name} puts the two points ` +
      `${formatMetres(distOf(reference) * reference.mmPerPoint, 2)} apart; taking that ` +
      `gives ${sheet.name} 1 pt = ${scale.toFixed(3)} mm.`,
      [{ label: `Use ${reference.name}'s scale`, value: true, primary: true }])
    if (take) setScale(sheet, scale)
    return
  }

  const agree = calibrationAgreement(sheet, reference)
  if (!agree || agree.off <= CALIBRATION_TOLERANCE) return
  const pct = (agree.off * 100).toFixed(1)
  const choice = await chooseDialog('The two floors disagree about the scale',
    `The two points are ${formatMetres(agree.bMm, 2)} apart on ${reference.name}, but ` +
    `${formatMetres(agree.aMm, 2)} on ${sheet.name} - ${pct}% off. Both are the same two spots in the ` +
    'building, so one of the calibrations is wrong. Which one do you trust?',
    [
      { label: `${reference.name} is right`, value: 'reference' as const, primary: true },
      { label: `${sheet.name} is right`, value: 'this' as const },
    ])
  if (choice === 'reference') setScale(sheet, scaleFromAlignment(sheet, reference)!)
  else if (choice === 'this') setScale(reference, scaleFromAlignment(reference, sheet)!)
  else app.editor.flash(`Left as it is — ${sheet.name} and ${reference.name} still disagree by ${pct}%; warren check reports it`)
}

function distOf(sheet: Sheet): number {
  const { a, b } = sheet.align!
  return Math.hypot(b.x - a.x, b.y - a.y)
}
