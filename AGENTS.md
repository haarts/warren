# Working on a Warren project

Warren draws the services in a house — pipes, ducts and circuits — on top of the architect's
floor plan PDF. A project is one `*.warren.json` file that references the plan beside it.

There is a browser app for a person, and a command line for you. They run the same modules, so
a length reported by one is the length the other means.

## Start here

```bash
node bin/warren.ts help --json     # every command, flag, op shape and enum, in one call
node bin/warren.ts help apply      # the write path, in prose
```

`help --json` is the contract. Its enums come from the same constants the validators use, so a
value listed there is a value that will be accepted — prefer it to anything written here or in
the README, which are prose and can age.

Installed as a package the command is `warren`; in this repo it is `node bin/warren.ts`. There
is an `npm run warren -- <args>` too, but npm prints a banner on stdout that will corrupt any
`--json` you try to parse — use `npm run --silent warren`, or just call node directly.

## What Warren will and will not do

It holds a drawing, places things by arithmetic, and checks claims rigorously.

**It cannot read a floor plan.** Deciding that *this* rectangle is the kitchen and *that* arc is
a door hinged on the left is understanding, and it has to come from you — render a page of the
PDF, look at it, and hand the result over as ops. That boundary is deliberate: it is what keeps
the file honest about which parts are measured and which are someone's judgement.

So the useful division is: you read the plan, Warren grades what you read. A room op takes an
`expectM2` — Dutch plans print the area of every room — and the whole batch is refused if your
traced polygon disagrees by more than 8%.

## The loop

```bash
warren summary  house.warren.json --json          # is the sheet calibrated? what is here?
warren systems  house.warren.json --add-missing   # a project can predate a system
warren apply    house.warren.json ops.json --dry-run
warren apply    house.warren.json ops.json
warren check    house.warren.json --strict        # always, after any write
```

`warren generate` does the repetitive half — two sockets per wall, a switch by each door, a
detector in the halls — once rooms and doors exist. Look before you leap:
`--dry-run --where` prints every placement it would make.

## Rules

**Write through `warren apply`, never by editing the JSON.** The parser is forgiving on purpose,
so it repairs damage rather than refusing an old file — which is right for a person and
dangerous for you. `apply` validates everything before it writes anything, so a half-understood
instruction cannot leave the drawing half-changed. Direct edits skip all of it.

**Everything is metres.** The file stores PDF points and a per-sheet scale; converting at the
boundary is the tool's job, not yours. Use `pointsM` / `xM` / `yM` in ops and read `lengthM` /
`atM` back out. An uncalibrated sheet reports `null` rather than a guess — check `summary`
first, because nothing dimensional works until a sheet has a scale.

**Every item names a system, and style comes from the system** — colour, dash, width, default
size. Do not set `colorOverride` to make something look right; pick the correct `systemId`, and
run `systems --add-missing` if the one you want is not in the catalogue yet.

**A run is one object.** A duct with four corners is a single polyline, not four segments.

**Connections are read from the geometry, not recorded.** Endpoints that meet share a
coordinate, within 5 mm of real world. If you want two things joined, give them the same point —
`graph` and `trace` will then agree they are joined. Nothing else makes it so.

**Do not fight the generator.** Generated items are stamped with the rule that made them and
their ids are derived, so re-running is idempotent. Editing one through `apply` un-stamps it and
re-running leaves it alone — that is the intended way to correct a placement.

## Exit codes

| | |
|---|---|
| `0` | it worked |
| `1` | the project was read, but the answer is bad news — `check` found errors, or an ops file did not validate and **nothing was written** |
| `2` | the command line was wrong — unknown command, or a missing or unreadable file |

`check --strict` exiting 1 is the signal to stop and look, not to retry.

## The repo

```
bin/warren.ts     the command line, over the same modules the app runs on
src/model/        the document: types, systems catalogue, ids
src/check.ts      the rules behind `warren check` and the app's Check tab
src/generate.ts   placement rules, and running them over rooms
src/takeoff.ts    metres per system
src/topology.ts   connections, derived from coordinates
test/             node --test, no framework. `npm test`
```

`npm run check` typechecks, `npm test` runs the unit tests, `npm run test:browser` drives the
real app in headless Chromium. Run the first two before you call anything done.

The README is the human's document and explains *why* the design is the way it is. It is worth
reading before you change how something works, rather than just how it is spelled.
