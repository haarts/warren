---
name: warren-read-plan
description: Trace rooms, doors, and geometry from the architect's rendered PDF plan into Warren ops — including how to handle real ambiguity in the drawing (orientation, which wall is which) instead of guessing silently or escalating unnecessarily.
---

# Reading the plan

Warren cannot read a floor plan — that's the whole point of the split (see AGENTS.md, "What
Warren will and will not do"). This skill is about doing that reading carefully enough that the
ops you hand to `apply` are trustworthy, and about what to do when the plan genuinely doesn't
answer the question you need.

## Tracing a room

1. Render the relevant PDF page (or reuse an already-rendered image) and read the room's printed
   name and, on Dutch plans, its printed area in m².
2. Trace the polygon corners in the image, convert to the sheet's coordinate frame, and pass
   both the points and `item.expectM2` (the printed area) in the `add` op — see the
   `warren-apply-ops` skill for the op shape. The batch is refused if your trace is off by more
   than 8%, so a passing `apply` is real evidence the trace is right, not just a plausible guess.
3. If it fails the check, don't nudge points until it passes — re-look at the image. A polygon
   that "passes" only after cosmetic adjustment isn't verified, it's fitted.

## Tracing a door

A door is exactly two points: **the hinge jamb first, then the strike jamb**, plus `item.swing`
(`1` or `-1`) for which way it opens. Getting hinge-vs-strike backwards silently breaks any rule
that places a switch at "the unhinged side" (see `warren-generate-vs-handplace`) — if you're not
confident which jamb is which from the image, say so rather than picking one.

## Orientation and ambiguity

Plans carry orientation cues — a north arrow, entrance markers (e.g. "merk A"), grid column/row
labels along the edges. Use them before falling back to "left as drawn on screen" for anything
that depends on the building's relationship to the street, garden, or parking — those are not
the same thing, and a plan crop that doesn't show a north arrow or street context does not
resolve which is which.

**Check what is already recorded first, and record what you work out — don't re-derive it.**
A project carries one compass rose, shared by every sheet: four tips a quarter-turn apart,
turned to match the building, each named however people say that way. The human usually sets
it by dragging it in the app; you read it, or set it once it is confirmed:

```bash
warren directions house.warren.json                                   # what is set
warren directions house.warren.json --resolve straatzijde             # what a name means
warren directions house.warren.json --compass --rotation 12 --tips "north, straatzijde; east; south, tuin; west"
warren directions house.warren.json --compass --tip 4 --names "west, links, voorkant"   # one tip, the rest untouched
warren directions house.warren.json --toward straatzijde --from 12.87,11.39 --distanceM 6.5   # -> {"xM":..,"yM":..} for an `add` op
```

`--tips` replaces all four and refuses anything but four; to add a name to one tip, read it
first and pass its full list with `--tip <n> --names`.

Every later instruction ("route it to the street side", "toward noord") then resolves to the
same bearing instead of a fresh eyeball each time. A bearing the rose does not cover — a facade
at an angle — is a one-off: `--set <id> --bearing <deg> --aliases "..."`.

**When the plan genuinely doesn't settle the question:**

- Don't spend an `advisor()` call on it — the answer is almost always "make the plausible
  reading, do the (cheap, reversible) work, and flag the assumption" per AGENTS.md's own
  philosophy of supporting rather than blocking. That's cheaper for both of you than a call
  that re-derives a convention you already have.
- Don't silently pick one reading and stay quiet about it, and don't record an unconfirmed guess
  as a named direction either — that turns "probably" into a fact the next session will trust
  outright. Say which reading you used, in one line, when you report the result.
  `warren select <file> --id ... --say "..."` is the way to surface it against the actual items
  rather than in prose alone; save `directions --compass`/`--set` for once it's actually confirmed.
- Reserve an actual question to the human for when the two readings would produce **materially
  different, expensive-to-undo work** — not for a routing choice that's one `delete` away from
  being redone.

## Verifying wall position, not just room shape

A traced room polygon can pass its `expectM2` check while a specific edge you care about (e.g.
"the left exterior wall") is still assumed rather than confirmed — the area check validates the
whole shape, not that edge specifically. Before terminating a run or placing a penetration
marker at a wall, check that the coordinate you're using is shared by more than one room's
boundary in the way an exterior wall would be (an interior partition only borders the rooms on
either side of it; an exterior wall is the edge of the building envelope). If unsure, look at
the rendered image again rather than trusting the polygon's bounding box alone.
