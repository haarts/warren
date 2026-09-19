---
name: warren-apply-ops
description: Construct or debug an ops.json file for `warren apply` against a *.warren.json project (add/set/move/delete operations — runs, rooms, doors, markers, notes). Use this whenever writing ops for `warren apply`, before guessing the shape from memory.
---

# Writing ops for `warren apply`

The schema below is a shortcut, not the source of truth. If a field, enum, or op type isn't
covered here, run this first — it's cheap and it's the actual contract:

```bash
node bin/warren.ts help --json      # every op shape, field, and enum, generated from the validators
node bin/warren.ts help apply       # the write path in prose
node bin/warren.ts systems <file> --json   # this project's system ids, sizes, symbols
```

Guessing instead of checking is exactly how ops files fail validation — the two most common
mistakes are below.

## File shape

```json
{ "ops": [ { "op": "add", "item": { ... } }, { "op": "set", "id": "...", "patch": { ... } } ] }
```

`apply` validates every op before writing any of them (exit 1, nothing written, if any op is
bad). Use `--dry-run` first for anything nontrivial, and `--as <who>` to stamp provenance on
what you add or edit (e.g. `--as ai:conduits`) so it renders faint until a human touches it.

## `add` — the most-missed detail

**Every field of the new item goes inside `item`, not on the op itself.** `systemId` on the
op (not inside `item`) is the single most common mistake — it validates as "not in this
project's catalogue" no matter how correct the id is, because the checker never looks there.

```json
{
  "op": "add",
  "sheet": "Beneden verdieping",
  "item": {
    "kind": "run",
    "systemId": "power.conduit",
    "level": "crawl",
    "label": "Loze leiding EV-lader 1",
    "size": "Ø50",
    "pointsM": [[13.40, 11.39], [13.40, 11.20], [6.41, 11.20]]
  }
}
```

- `sheet` is optional (1-based number or name substring; defaults to the first sheet) and is
  the only field that stays outside `item`.
- The field is **`systemId`**, never `system` — and it must already be in the project's
  catalogue (`warren systems <file> --json`; add one with `systems --add-missing` first if not).
- Shaped items (`run`, `room`, `door`) take `item.pointsM` (metres) or `item.points` (raw PDF
  points) — a run needs 2+, a room 3+, a door exactly 2 (hinge jamb first).
- Positioned items (`marker`, `note`) take `item.xM`/`item.yM` (or `item.x`/`item.y`).
- `item.level` defaults to `wall` if omitted — set it explicitly for `crawl`/`ceiling`/roof runs.
- A room can carry `item.expectM2`: the plan's printed area. The whole batch is refused if the
  traced polygon is more than 8% off — this is a self-check, use it whenever the plan prints
  an area.
- A marker's `item.symbol` must be one of the system's allowed symbols (see `systems --json`).

## `set` / `move` / `delete`

```json
{ "op": "set", "id": "run_abc123", "patch": { "size": "5×6mm²", "label": "..." } }
{ "op": "move", "id": "run_abc123", "byM": [0.2, 0] }
{ "op": "delete", "id": "run_abc123" }
```

`set.patch` only accepts the patchable fields listed in `help --json`; setting `systemId` there
must also match an existing catalogue id. Editing an item via `apply` un-stamps any `generated`
provenance it had, which is the intended way to correct a rule-placed item.

## Connections are geometry, not a field

To join two items, give them the exact same point (within 5mm) — there's no `connectsTo` field.
Verify with `warren trace <file> --id <id> --json` after applying, not by eyeballing coordinates.

## Connecting a new item to an existing run

"Run this straight up/over to X" is a common instruction, but the target's coordinate rarely
lands exactly on the existing run — check before assuming a straight line will actually touch it:

```bash
node bin/warren.ts items <file> --id run_abc123 --json   # read the run's real endpoint, don't eyeball the plan
```

- If the new point already shares an x (or y) with the run's endpoint within ~5mm: one straight
  segment is enough — `pointsM: [[newX, newY], [runEndX, runEndY]]`.
- If it doesn't (e.g. a marker is 0.76m off from where the run actually ends): route an L-shape
  instead of stretching the run to meet it — `pointsM: [[start], [start.x, run.y], [run.x, run.y]]`
  (or the x/y-swapped version). Don't silently extend or bend the *existing* run to close the
  gap; that changes something the human already drew. Say the discrepancy out loud rather than
  papering over it.
- Re-`trace` the new item afterwards and confirm the connection count matches what you expect
  (usually 2: what it starts at, what it ends at) — a stray extra connection usually means a
  point landed within 5mm of something you didn't intend to join.

## If `warren serve` is running

`apply` auto-detects it and routes the read and write through the server, so the change lands
live in the browser. Read immediately before writing, keep batches small, and expect a 409 (=
"drawing changed underneath you") if the human edited in the meantime — re-read and redo rather
than retrying blind. Use `warren select <file> --id ... --say "..."` to point at what you did
instead of describing coordinates in prose.
