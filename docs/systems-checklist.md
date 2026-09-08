# What to draw — services checklist

For an **all-electric Dutch new-build** with a heat pump, HRV/WTW ventilation, a **recirculating
hob**, and **rainwater harvesting reused indoors** (outdoor tank → indoor pump → toilets and
washing machine).

⚠ marks the things that are expensive or impossible to add once the concrete is poured or the
plasterwork is up. Those are the ones worth drawing *before* anyone starts building.

The systems catalogue in the app is seeded from this list. Delete what does not apply, add
what is missing, and keep the two in step.

---

## Fresh water (drinking)

- [ ] Service entry, meter, main stopcock
- [ ] Cold water distribution
- [ ] Hot water distribution
- [ ] ⚠ Hot-water **circulation loop** — a third pipe. Decide before any pipework goes in;
      retrofitting it means opening floors
- [ ] Water softener in / out / bypass, plus a hard-water tap for drinking and the garden
- [ ] ⚠ Manifold (verdeler) versus branched layout — this decision changes the entire drawing
- [ ] Outdoor frost-proof taps, garden irrigation
- [ ] Heating fill loop

## Rainwater — collection (outside, largely out of scope)

- [ ] Gutters and downpipes to the tank
- [ ] Leaf / first-flush filter
- [ ] ⚠ Tank **overflow** route: infiltration crates, soakaway or separate sewer. It *will*
      overflow — decide where the water goes
- [ ] Flat-roof emergency overflow

## Rainwater — reuse indoors (non-potable)

- [ ] Suction line from the tank into the building (a wall penetration below ground)
- [ ] ⚠ Pump position — noise and vibration isolation; it runs at night
- [ ] Pump power circuit and its own group
- [ ] Pressure vessel and filter, with maintenance access
- [ ] Non-potable distribution to toilet cisterns and the washing machine tap
- [ ] ⚠ **Mains top-up with an air gap / backflow protection.** Mandatory. The two systems must
      never be able to cross-connect
- [ ] Tank level sensor cable back to the pump controller
- [ ] ⚠ Mark every non-potable pipe and outlet. Whoever opens this wall in 20 years will
      assume a water pipe is drinking water unless you tell them otherwise

## Heating and cooling (heat pump)

- [ ] ⚠ Underfloor heating loops and manifold(s), one per floor. Loop lengths have a maximum —
      this is exactly what the calibrated length readout is for
- [ ] Heating flow and return to any radiators or towel rails
- [ ] Heat pump line set between outdoor and indoor unit (refrigerant if split, insulated water
      if monobloc)
- [ ] ⚠ Outdoor unit **defrost / condensate drain** — it produces water all winter
- [ ] Buffer tank and DHW cylinder positions
- [ ] ⚠ **Condensate drains** for the indoor unit, the HRV and any AC. Each needs a trapped
      route to a drain. Forgotten in most self-builds
- [ ] Thermostat, room sensor and zone-valve wiring

## Ventilation (HRV / WTW)

- [ ] HRV unit position, plus service clearance and filter access
- [ ] Supply ducts to living spaces and bedrooms
- [ ] Extract ducts from wet rooms
- [ ] The two ducts to outside: fresh intake and exhaust, with their roof or wall terminals
- [ ] Duct sizes and the plenum / manifold box
- [ ] ⚠ **Kitchen extract valve and duct.** With a recirculating hob the HRV is your *only*
      kitchen extraction — do not undersize it
- [ ] Tumble dryer exhaust, or a condensate drain if it is a heat-pump dryer
- [ ] Crawl space ventilation
- [ ] ⚠ Soil vent pipe to the roof — an "air" line that belongs to the drainage system
- [ ] Roof and wall penetrations for all of the above

*(No flue, no combustion air, no cooker-hood duct — all-electric with a recirculating hob.)*

## Drainage

- [ ] Soil (black) versus waste (grey) — different pipe sizes and fall
- [ ] All drainage needs **fall**. A plan cannot show slope: use the flow arrow for direction
      and the slope field for the gradient
- [ ] ⚠ Vent pipes and air admittance valves
- [ ] ⚠ Cleanouts / rodding eyes — put them where you can still reach them afterwards
- [ ] Floor gullies, shower drain (line or point), washing machine standpipe
- [ ] Condensate tie-ins from the heat pump and HRV
- [ ] Sewer connection at the property boundary, and its invert level

## Power

- [ ] Meter cupboard and the incoming service
- [ ] Distribution board(s) and ⚠ **the group number on every circuit** — write it in the label
- [ ] 230 V lighting groups, per room or zone
- [ ] 230 V socket groups
- [ ] Dedicated appliance groups: washing machine, dryer, dishwasher, oven, fridge
- [ ] 400 V 3-phase: hob, EV charger, heat pump, workshop
- [ ] ⚠ Earthing and equipotential bonding: main earth terminal, foundation earth or earth rod,
      bonding to metal pipework
- [ ] Switch legs and two-way switching
- [ ] Outdoor lighting, garden power
- [ ] PV: DC strings → inverter → AC to the board, plus the inverter comms cable; battery
- [ ] ⚠ EV charger **including the load-balancing sensor cable back to the meter**
- [ ] Doorbell transformer
- [ ] Motorised blinds and screens, garage door, gate
- [ ] ⚠ Mains-powered, interlinked smoke detectors
- [ ] ⚠ **Empty conduits (loze leidingen)** — the cheapest insurance in the whole build. Give
      them their own layer and be generous
- [ ] ⚠ Feeds to the shed, garage or outbuilding — power, water and data, dug once

## Data and low voltage

- [ ] CAT6A home runs to a patch location — count the drops per room, then add two
- [ ] PoE for cameras and ceiling Wi-Fi access points
- [ ] ⚠ Fiber / ISP entry point, and where the modem lives
- [ ] Coax, if you still want it
- [ ] Speakers, in-ceiling or wall
- [ ] Intercom / video doorbell
- [ ] Alarm contacts, door and window sensors
- [ ] KNX / Modbus / DALI bus, if you are going that way
- [ ] Thermostat and sensor cable
- [ ] ⚠ **P1 cable from the smart meter to wherever the home server lives.** Forgotten in
      almost every build, trivial to lay now
- [ ] Cameras
- [ ] Heat pump and inverter comms

## Structure and coordination

- [ ] ⚠ **Wall and floor penetrations (sparingen)** — marked *before* the pour. This is the
      single highest-value thing in this whole document
- [ ] ⚠ Shafts and chases for vertical routes between floors
- [ ] Fire collars at rated penetrations
- [ ] Crawl space access hatch
- [ ] Dropped-ceiling zones — i.e. where duct space actually exists
- [ ] Joist and beam no-drill zones
- [ ] ⚠ Every penetration of the **airtightness layer**. Each one has to be taped or
      grommeted; marking them is what makes the blower-door test survivable

## Worth marking while you are at it

- [ ] Water leak sensors and an automatic shutoff valve
- [ ] Sump pump
- [ ] Central vacuum, if you want it
- [ ] Charging point for e-bikes in the shed

---

## Two habits that pay off

**Tag the level.** Every run gets `in floor / in wall / in ceiling / above ceiling / crawl /
roof`. On a top-down plan a duct at ceiling level and a pipe in the screed cross constantly and
never touch. Without the level tag, a busy drawing becomes unreadable and you cannot tell an
installer anything useful.

**Photograph before closing up.** Every wall and floor, before the plasterboard and the screed,
with something in frame for scale. The drawing says what you intended; the photos say what
actually got built. You will want both when you drill a hole in 2031.
