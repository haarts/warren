/**
 * A suggestion is a marker someone other than the person put on the drawing - a model working
 * through `warren apply --as <who>` - that nobody has looked at yet. It is drawn faintly, so it
 * never passes for the person's own work, and it becomes theirs the moment they touch it.
 */
import type { Item, Suggestion } from './types.ts'

export function suggestedBy(item: Item): Suggestion | undefined {
  return item.kind === 'marker' ? item.suggested : undefined
}

/** A person edited it, so it is theirs now: no longer drawn as somebody else's suggestion. */
export function adopt(item: Item): void {
  if (item.kind === 'marker') delete item.suggested
}
