# Warren

*a maze of burrows and passages*

Draw pipes, ducts and circuits on top of your architect's floor plan PDFs.

A small, local, offline drawing tool for planning the services in a house build: fresh water,
rainwater reuse, drainage, heat pump, ventilation, power and data. It is deliberately not CAD —
it is a marked-up plan you can hand to an installer, and a material takeoff you can order from.

![toolbar → canvas → panel](docs/screenshot.png)

## Run it

```bash
npm install
npm run dev          # opens http://localhost:5173
```

Then `File → Import PDF page → this sheet`, pick a page, and calibrate.
There is a sample plan in `samples/sample-floorplan.pdf` if you want to try it before touching
your real drawings — its printed `10000` dimension calibrates to exactly 20 mm per point.

Other scripts:

```bash
npm run check        # typecheck
npm test             # unit tests (node --test, no framework)
npm run test:browser # end-to-end: drives the real app in headless Chromium
npm run build        # static site in dist/ - open it with any web server
```

`test:browser` starts the dev server itself and needs a Chromium binary; set `CHROME_PATH` if
it cannot find one. It covers what unit tests cannot: PDF rendering, canvas hit-testing,
pointer drags, calibration, IndexedDB autosave, PNG export and the print view.

Chrome or Edge give you real in-place saving (File System Access API), but only on a secure
origin — `http://localhost` counts, a LAN address like `http://192.168.1.20:5173` does not.
Firefox has no such API at all. Where it is missing, Save downloads a fresh copy each time and
the File menu tells you which of the two cases you are in.

## The two ideas that shape everything

**Style belongs to the system, not to the shape.** You pick "Cold water" or "400V 3-phase" and
the colour, dash pattern, line width and default size come with it. That is why a drawing made
over two years still agrees with itself, why the legend is trustworthy, and why the takeoff can
add anything up. Per-shape colour override exists, but you should rarely need it.

**A run is one object.** A duct with four corners is a single polyline, not four line segments.
Click any part of it and you select the whole thing; drag it and every corner moves together.

## Working with it

| | |
|---|---|
| **Draw a run** | `L`, then click each corner. `Enter` or double-click finishes, `Backspace` removes the last corner, `Esc` cancels. Hold `Shift` for 45° lock |
| **Select** | `V`. Click a run to select all of it. Shift-click to add. Drag on empty space for a rubber band |
| **Move** | Drag the selection. Arrow keys nudge (`Shift` = 10×) |
| **Edit corners** | Drag a corner handle to move it. `Alt`+click a segment to insert a corner, `Alt`+click a corner to remove it. Double-click a segment also inserts |
| **Equipment** | `R` draws a box — HRV unit, manifold, distribution board |
| **Markers** | `M` places a riser, drain, cleanout or penetration |
| **Notes** | `N` drops a sticky note. Type into Properties; drag the bottom-right handle for width, the height follows the text |
| **Measure** | `D` |
| **Calibrate** | `K`, then click the two ends of a dimension printed on the plan and type its real length in mm |
| **Pan / zoom** | Space-drag or middle-drag to pan, wheel to zoom, `F` to fit |
| **Undo** | `Ctrl+Z` / `Ctrl+Shift+Z`, 100 deep |
| **Save** | `Ctrl+S`, or `Ctrl+Shift+S` for Save as… |
| **Rename** | Click the project title in the toolbar |

## Calibrate first

Nothing measures anything until you calibrate the sheet. Click `K`, click the two ends of a
dimension **printed on the plan**, and type its real length. Use a printed dimension rather than
the stated scale: PDFs are routinely scaled to fit paper, so "1:100" in the title block is often
a lie by a few percent.

After that you get live lengths while drawing, a length per run, a scale bar, and the Takeoff
tab.

## Layers and levels — two different things

**Layers** are the systems, grouped into disciplines. Toggle a whole discipline or a single
system; hidden systems are also unclickable and excluded from exports and prints. The padlock in
the Layers tab freezes a whole system: still visible and still printed, but no longer in the way
of your cursor. The Lock button in Properties does the same for one item.

Locked things cannot be clicked — that is the point — so there are two ways back: hovering one
says so in the status bar, and Properties grows an **Unlock all (n)** button whenever the sheet
has any.

**Level** is where something sits in the building fabric: crawl space, in floor, on floor, in
wall, on wall, in ceiling, above ceiling, roof. It is a property of each item, not a layer, and
the toolbar filter shows one level at a time. A top-down plan cannot show height, so without
this a busy drawing is unreadable — the duct at ceiling level and the pipe in the screed cross
on paper and never touch in reality.

The `in` / `on` pairs carry two different facts. Runs are buried *in* something; equipment is
mounted *on* something — the board hangs on a wall, the cylinder and the rainwater pump stand
on the floor. Surface-run conduit in a garage uses "on wall" too.

## Direction

Anything that falls, is pumped or is blown — drains, rainwater, ventilation, heating flow and
return, the DHW loop — takes its direction from the order you drew it in, because that is
usually the direction you were thinking in.

Usually, not always: draw a drain from the stack outward instead of from the fixture inward and
the guess comes out backwards. So a guessed direction is drawn **faintly** and stays marked as a
guess until you say otherwise. Select the run and either confirm it or flip it; both count as
confirmation. `warren check` reports how many are still assumed, and a print carrying any says
so on the sheet — a confidently wrong fall direction on a drawing somebody builds from is worse
than no arrow at all.

Systems where an arrow would just be noise — socket circuits, CAT6, empty conduit — get none.
That is the `assumeFlow` flag in the catalogue, and it is yours to change.

## Sizes

The **Size / spec** field is a combo box: click it for the sizes that system normally uses, or
just type. The list is a suggestion, never a constraint — the one spec you need is always the
one nobody thought to list.

Electrical defaults follow NEN 1010 practice: `3×1.5mm²` for lighting, `3×2.5mm²` for socket
and dedicated-appliance groups on a 16 A group, `5×2.5mm²` for a 3×16 A hob or an 11 kW charge
point, `5×6mm²` for 3×32 A (22 kW). Pipe and duct systems carry their own lists the same way.

Edit any of them in **Systems…** — the Sizes column is comma-separated, and the first entry is
what new runs get.

## Notes

`N` drops a yellow sticky anywhere on the plan — "air gap on the mains top-up, confirm before
first fill", the kind of thing you will not remember in eight months.

A note belongs to a system like everything else, and the coloured stripe down its left edge
tells you which. Hide ventilation and the notes about ventilation go with it. Notes that belong
to no discipline can use **General note** in the structure group.

The **Notes** button in the toolbar hides all of them at once, for a clean print. Hidden notes
are unclickable as well as invisible, so you cannot drag one you cannot see. Notes never appear
in the takeoff — they are annotations, not material.

## The takeoff

The Takeoff tab totals metres per system, for the sheet or the whole project.

A plan length is not a material length: drops down walls, rises into ceilings, bends and service
loops are all invisible from above. The **slack %** (default 10) covers that globally; the
per-run **extra length** field covers a specific run that needs more. Order from the right-hand
column.

## Saving

**Name the project first.** Click the title next to "Warren" in the toolbar (or File → Rename
project…). That name is the print heading and the suggested file name, and Save as… on a still
-untitled project adopts whatever file name you type.

Your project is a `*.warren.json` file that **references** the plan PDF rather than containing
it, and the PDF is written out beside it. That matters more than it sounds: with the plan
embedded, a real project was 24.4 MB of which 24.38 MB was base64 — 99.8% of the file was
something no diff, grep, script or person could see past. By reference the same project is
53 KB, and `git log` becomes a readable history of the design.

```bash
git init && git add my-house.warren.json plan.pdf && git commit -m "services, first pass"
```

The browser keeps its own copy of the plan, keyed by content hash, so opening a project on the
machine that drew it needs nothing extra. On a different machine it asks for the PDF once and
checks the hash, so it cannot attach the wrong plan by mistake.

For mailing or archiving, `File → Export self-contained bundle…` writes one file with the plan
inside. `warren split` and `warren bundle` convert between the two forms.

There is also a 30-second autosave to IndexedDB, but that is a **crash net, not a save**.
Browser storage gets cleared by updates and cleanup tools, and does not follow you to another
machine. Save to a file.

## Rooms and doors

A room is an outline with a **name** and a **use** — kitchen, bedroom, hall. A door records its
two jambs, **hinge first**, and which way it swings. Both are architecture rather than services,
so they sit under everything else and a level filter never hides them: they are the context you
read the rest against.

This is not drawing for its own sake. What a room is *for* is what lets rules act on it: a
bedroom wants sockets and a smoke detector, a toilet wants neither, and a light switch belongs
by the strike jamb rather than behind the door. Recording the building once turns the
repetitive half of an electrical layout into something that can be generated instead of typed.

Rooms show their computed floor area, which is also how a traced outline checks itself — Dutch
architect's plans print the area of every room, so `warren apply` accepts an `expectM2` on a
room and refuses the op if the polygon disagrees by more than 8%.

## Generating the repetitive half

Two sockets on each wall of every room, a switch by each door on the side it opens, a detector
in the halls. That is not design work, it is typing — and it is why the electrical layer starts
as a blank page you do not want to look at.

`File → Generate from rooms…`, or `warren generate`, runs a set of placement rules over the
rooms and doors and puts them all down at once. It shows you what it will do first.

**The rules are data, not code.** "Two sockets per wall" is an opinion about one house, so
Warren executes a rule set rather than believing one — `warren rules --set mine.json` replaces
them wholesale. Three placements exist: `along-walls`, `at-door-strike`, `centre`. Each rule
says which room uses it applies to, which system and level the result belongs to, and the
distances involved.

Generated items are **drawn faintly** and stamped with the rule that made them. Move or change
one and it becomes yours: the stamp comes off, and re-running the rule leaves it exactly where
you put it. That holds whoever does the editing — the app, or `warren apply`. Ids are derived
from the rule and the room rather than being random, so re-running produces the same file
instead of a diff full of new identifiers.

What Warren will never do is decide *which room is the kitchen*. That is understanding, and it
comes from you or from something you point at the drawing — see below.

## Working with an AI

Warren is meant to be a thing a person and an AI both work on, and it stays deliberately dumb
so that is possible. It knows how to hold a drawing, place things by arithmetic, and check
claims rigorously. It knows nothing about reading a floor plan.

That boundary is the useful part. An agent can render a page of the PDF, decide that *this*
rectangle is the kitchen and *that* arc is a door hinged on the left, and hand the result over
as ops:

```bash
warren systems house.warren.json --add-missing   # a project can predate a system
warren apply   house.warren.json rooms.json      # rooms and doors, validated
warren generate house.warren.json                # the repetitive half, by rule
warren check   house.warren.json                 # a second pair of eyes
```

Warren cannot trace a room, but it can grade one. Dutch plans print the area of every room, so
a room op takes an `expectM2` and the whole batch is refused if the polygon disagrees by more
than 8%. Tracing three rooms off a real plan came out at 15.3/15.2, 29.3/29.2 and 10.8/10.9 m²,
with a deliberately wrong fourth caught at 62% out.

## Connections

Nothing records what is joined to what — it is read from the drawing. Endpoints snap while you
draw, so runs that meet already share a coordinate, and storing a second editable copy of that
fact would only give it a way to disagree with the picture.

The tolerance is deliberately tiny (5 mm of real world). Measured on a real drawing, genuinely
connected endpoints sit at *exactly* the same coordinate and the next nearest pair is 35 mm
away — so a generous tolerance does not find more connections, it invents them. Two things that
look joined but are not will show up as loose ends, which is the honest answer: they are not
joined.

Select a run and Properties tells you what it is joined to, how many loose ends it has, and
offers **Select all n joined** — the quick way to grab a whole circuit or a whole drain line and
move it. A branch landing part way along a main is recorded as a *tee* rather than a joint,
because the difference matters.

## Checks

Behind the **Check** tab, and nowhere else. It runs when you open it and not before: nothing
badges you, nothing blocks a tool, and a half-finished drawing is allowed to look half-finished.
Findings are grouped as *worth fixing*, *worth a look* and *just so you know*, and clicking one
selects and zooms to what it is about.

The rigour is aimed at whatever writes to the file without looking at it. `warren check` runs
the same rules from a terminal and exits non-zero on errors, so it can sit in CI or in front of
an agent. The parser is forgiving by design — it repairs damage so a file you wrote 18 months
ago still opens — and that is right for a person and dangerous for a machine, so `check` fails
where the parser forgives: a run with one vertex, coordinates in millimetres where points
belong, a system id that does not exist.

One rule is an error rather than a suggestion: **non-potable water may never reach drinking
water**. That is derived from the geometry, so it holds whether or not anyone remembered to
label anything.

## The `warren` command

Everything the app computes is available from a terminal, running the same modules — so a
length reported here is the length the drawing means, not a second implementation that can
drift.

```bash
warren summary house.warren.json            # sheets, scale, counts, total metres
warren items   house.warren.json --system 'power.*' --level wall
warren takeoff house.warren.json --csv
warren check   house.warren.json --strict   # exits 1 on errors, so CI can use it
warren systems house.warren.json            # the catalogue; --add-missing fills in newer defaults
warren rules   house.warren.json            # the placement rules; --set replaces them
warren generate house.warren.json           # run the rules over the rooms and doors
warren graph   house.warren.json            # derived networks, junctions, loose ends
warren trace   house.warren.json --id run_x # what one run is joined to, and what it reaches
warren split   house.warren.json            # move the PDF out beside the file
warren bundle  house.warren.json            # one self-contained file
warren apply   house.warren.json ops.json   # validated batch edits
```

Add `--json` to any of them for machine-readable output. **Everything speaks metres** — the
file stores PDF points and a per-sheet scale, and converting at the boundary is the tool's job,
not the caller's.

`apply` takes a list of ops and validates all of them before writing any, so a
half-understood instruction cannot leave the drawing half-changed:

```json
{ "ops": [
  { "op": "add", "sheet": "Ground floor", "item": {
      "kind": "run", "systemId": "power.smoke", "level": "ceiling",
      "pointsM": [[3.0, 4.0], [7.5, 4.0]], "label": "detectors hall" } },
  { "op": "set",  "id": "run_abc", "patch": { "size": "3×4mm²" } },
  { "op": "move", "id": "run_abc", "byM": [0.5, 0] },
  { "op": "delete", "id": "mk_xyz" }
] }
```

`check` exists because the file parser is deliberately forgiving — it repairs damage so a file
you wrote 18 months ago still opens. That is right for a person and dangerous for a machine: a
run written with one vertex, or coordinates in millimetres where points belong, gets quietly
turned into something plausible and wrong. `check` fails where the parser forgives, and
enforces the one rule worth enforcing above all others — non-potable water may never share an
endpoint with drinking water.

## Printing

`File → Print / PDF…` renders the sheet, adds a legend of only the systems actually drawn plus
the takeoff table, and opens the browser print dialog — choose "Save as PDF".

Untick disciplines first to produce a sheet per trade. The electrician does not need your drain
falls.

## What it deliberately does not do

No 3D, no isometrics, no pipe sizing or load calculation, no DWG, no collaboration, no cloud.
Those are what makes real MEP software cost real money and take real training. This stays a
drawing you can read.

## Layout

```
bin/warren.ts      the command line, over the same modules the app runs on
src/
  geom.ts          pure geometry (distances, ortho snap, polyline walking)
  topology.ts      what is joined to what, read from the geometry
  check.ts         the rules, shared by the Check tab and `warren check`
  generate.ts      placement rules: arithmetic here, opinions in the data
  takeoff.ts       metres per system
  units.ts         metric formatting
  model/           types, the systems catalogue, the document store + undo
  io/              pdf.js import, project file, autosave, PNG export, print
  render/          camera, background raster cache, the scene painter
  interact/        hit testing, snapping, the pointer/tool state machine
  ui/              toolbar, side panel, dialogs
docs/systems-checklist.md   what to draw, and what people forget
```

Three runtime dependencies: `vite`, `typescript`, `pdfjs-dist`. That is on purpose — this has to
still open in five years.
