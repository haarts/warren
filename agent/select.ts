import { choice, noul, type TypeSafeClient } from '@typesafe-ai/sdk'
import type { Candidate } from './catalog.ts'
import { problem } from './errors.ts'

/**
 * Turning "the light above the stairs" into an id.
 *
 * Warren cannot read a plan, so the person or model that traced it decides what each item
 * means. That leaves the drawing full of ids that say nothing, and no amount of string
 * matching finds the one a request is about. This is the semantic step: one Choice ranks every
 * candidate in the drawing, and one Noul asks whether anything matches at all. The two go in a
 * single call because all the questions see the same state and the extra one is nearly free.
 *
 * Choice probabilities always sum to one, so something ranks first even when nothing fits.
 * The Noul is what tells us to point at nothing.
 */

/** A Choice carries at most 255 options. Past that, a page of the drawing would have to be
 * chosen first - which needs the drawing's own structure to be reliable. Not yet. */
const MAX_OPTIONS = 255

/**
 * The Noul answer is a calibrated probability, so it is read in three bands rather than one
 * cut. Pointing writes nothing, which argues for acting on a weak match; pointing at the wrong
 * thing is still noise, which argues for saying so. The middle band does both: act, and flag it.
 */
/** Below this, no item on the drawing is what was asked for. */
const NONE_BELOW = 0.35
/** At or above this, the match is not in doubt. */
const CONFIDENT_AT = 0.7
/** Even when something matches, a flat distribution this low means no single item is meant. */
const TOP_MIN = 0.1

export interface Ranked {
  id: string
  probability: number
}

/** `uncertain` still points - pointing changes nothing - but says to look before trusting it. */
export type Verdict = 'match' | 'uncertain' | 'none'

export interface Selection {
  request: string
  /** The item to point at, or null when nothing should be. */
  chosenId: string | null
  verdict: Verdict
  /** The model's certainty in `chosenId`, across all candidates. */
  confidence: number
  /** Probability that any candidate matches the request. */
  matchProbability: number
  /** Every candidate, most likely first. */
  ranking: Ranked[]
  /** True whenever something should be pointed at, including a doubtful match. */
  matched: boolean
  /** Why nothing was chosen, when nothing was. */
  reason: string | null
  model: string
  usage: { input_tokens: number; output_tokens: number }
}

export async function selectItems(
  client: TypeSafeClient,
  request: string,
  candidates: Candidate[],
): Promise<Selection> {
  if (candidates.length === 0) throw problem('the drawing has no items to select')
  if (candidates.length > MAX_OPTIONS) {
    throw problem(
      `this drawing has ${candidates.length} items, more than one Choice can rank (${MAX_OPTIONS}). ` +
        'Scope the drawing first (a sheet or a system), then run again.',
    )
  }

  const state = {
    drawing: 'A house services drawing. Every entry in `items` is one object drawn on it.',
    request,
    items: candidates.map((c) => ({ id: c.id, description: c.description })),
  }

  const criteria: Record<string, string> = {}
  for (const c of candidates) criteria[c.id] = c.description

  const { answers, model, usage } = await client.systemOne({
    state,
    questions: {
      target: choice(
        'Which single entry in `items` is the thing the user asked to highlight? ' +
          'Choose the best match even if it is imperfect; each option carries its own description.',
        criteria,
      ),
      match: noul(
        'Does at least one entry in `items` describe the thing the user asked to highlight?',
        {
          true: 'An entry exists that the request clearly refers to',
          false: 'No entry in the drawing is the thing requested',
        },
      ),
    },
  })

  const ranking = Object.entries(answers.target.probabilities)
    .map(([id, probability]) => ({ id, probability }))
    .sort((a, b) => b.probability - a.probability)

  const top = ranking[0]
  const matchProbability = answers.match.noul

  if (matchProbability < NONE_BELOW) {
    return {
      request,
      chosenId: null,
      verdict: 'none',
      confidence: answers.target.confidence,
      matchProbability,
      ranking,
      matched: false,
      reason: 'no item in the drawing matches that',
      model,
      usage,
    }
  }
  if (!top || top.probability < TOP_MIN) {
    return {
      request,
      chosenId: null,
      verdict: 'none',
      confidence: answers.target.confidence,
      matchProbability,
      ranking,
      matched: false,
      reason: 'the request is too vague to pick one item',
      model,
      usage,
    }
  }

  return {
    request,
    chosenId: top.id,
    verdict: matchProbability >= CONFIDENT_AT ? 'match' : 'uncertain',
    confidence: answers.target.confidence,
    matchProbability,
    ranking,
    matched: true,
    reason: null,
    model,
    usage,
  }
}
