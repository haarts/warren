---
name: warren-generate-vs-handplace
description: Decide whether a placement (socket, switch, detector, or similar repeated item) belongs to `warren generate` (a rule) or to hand-placed `apply` ops. Use this before adding sockets/switches/detectors/circuits so the same judgement call isn't re-litigated each time.
---

# Rule, or hand-placed?

This project went back and forth on this and landed somewhere specific — don't re-derive it,
use the answer:

**A rule (`warren generate`) only when the placement is fully determined by geometry that
already exists in the drawing.** Nothing about it requires knowing what the room is actually
used for beyond its `use` field.

- A light switch beside a door, on the unhinged (strike) side — determined entirely by the
  door's own two points and swing.
- A smoke detector near a room's centre — determined by the room polygon alone.
- Anything else that is "given the rooms and doors already drawn, there is only one sensible
  answer."

**Hand-placed via `apply`, stamped with `--as <who>`, when the placement requires judgement
about the real layout** that isn't and shouldn't be modeled in Warren:

- Kitchen sockets: where the worktop actually is, which sections get triples vs doubles, which
  appliance gets its own circuit — this depends on furniture layout, not room geometry. A
  generic "2 sockets per wall" rule was tried for this and explicitly rejected — it produced a
  wall of placements nobody wanted, for a decision that needed a human (or an AI actually
  looking at the plan and reasoning about appliances) to make.
- Anything routing to a piece of equipment not represented in the model (an island, an outdoor
  tap, a future EV charge point) — the routing choice is a judgement call about the building,
  not a derivation from drawn geometry.

**The tell:** if defending the placement requires saying "because that's where the sink/fridge/
worktop/entrance is," it's a judgement call — hand-place it. If defending it only requires
pointing at coordinates already in the file ("because that's the door's strike jamb"), it's a
rule.

## Why the split, not just "always hand-place" or "always generate"

Rules exist because "a light switch by every door" is real, valuable, repetitive work that a
person doing it by hand for a whole house will get tired of and start skipping — and because
getting it right doesn't need judgement, just doors. But extending rules into judgement territory
(worktop layout, appliance assignment) doesn't save real thought — it just moves a plausible
guess into code, where it's harder to see, override, or explain during e.g. a room-by-room
kitchen consultation.

**Do not add a new `generate` rule to cover a judgement-based placement just because it recurs
across rooms.** Recurring is not the same as geometry-determined — see the kitchen sockets
example. If a placement doesn't pass the tell above, it stays hand-placed even the tenth time.

## Practical notes

- Generated items carry a `generated: {rule, from}` stamp and render faint until "adopted" —
  editing one through `apply` un-stamps it, which is the intended way to correct a rule's
  placement without fighting the rule on the next run.
- Hand-placed items should still carry `--as ai:<something>` when you (not the human) placed
  them, for the same faint-until-reviewed treatment — see `warren-apply-ops`.
- `generate --dry-run --where <room>` before committing, always — it prints every placement it
  would make, and scoping to one room at a time (`--room`) matches how the human actually works
  through the house.
