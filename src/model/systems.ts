import type { System } from './types.ts'

/**
 * 16 preset colours. Kept deliberately small and print-safe: no near-white, no pastels that
 * vanish on a grey architect plan, and hues spread far enough apart to survive a mediocre
 * colour printer. Colour alone never carries meaning here - every system also has a dash
 * pattern, a width and a label.
 */
export const PALETTE: { name: string; hex: string }[] = [
  { name: 'Blue', hex: '#2563eb' },
  { name: 'Navy', hex: '#1e3a8a' },
  { name: 'Cyan', hex: '#0891b2' },
  { name: 'Teal', hex: '#0f766e' },
  { name: 'Green', hex: '#16a34a' },
  { name: 'Olive', hex: '#4d7c0f' },
  { name: 'Amber', hex: '#ca8a04' },
  { name: 'Orange', hex: '#ea580c' },
  { name: 'Brown', hex: '#b45309' },
  { name: 'Red', hex: '#dc2626' },
  { name: 'Pink', hex: '#db2777' },
  { name: 'Magenta', hex: '#a21caf' },
  { name: 'Violet', hex: '#7c3aed' },
  { name: 'Purple', hex: '#6b21a8' },
  { name: 'Slate', hex: '#475569' },
  { name: 'Black', hex: '#171717' },
]

export const DASH_PRESETS: { name: string; dash: number[] }[] = [
  { name: 'Solid', dash: [] },
  { name: 'Dashed', dash: [7, 4] },
  { name: 'Dotted', dash: [1.2, 3] },
  { name: 'Dash-dot', dash: [9, 3, 1.2, 3] },
  { name: 'Long dash', dash: [14, 5] },
  { name: 'Dash-dot-dot', dash: [9, 3, 1.2, 3, 1.2, 3] },
]

const D = {
  solid: [] as number[],
  dash: [7, 4],
  dot: [1.2, 3],
  dashdot: [9, 3, 1.2, 3],
  long: [14, 5],
  dashdotdot: [9, 3, 1.2, 3, 1.2, 3],
}

type Seed = Omit<System, 'visible' | 'locked' | 'defaultSize'>

/**
 * Default catalogue for an all-electric Dutch new-build with rainwater reuse and a
 * recirculating hob: no gas, no cooker-hood duct, and non-potable water as a first-class
 * system. Everything here is editable in the app - this is a starting point, not a schema.
 *
 * `sizes` are suggestions, not a constraint: the size field stays free text, because the one
 * spec you need is always the one nobody listed. The first entry is what a new run gets.
 * Electrical sizes follow NEN 1010 practice - 3×1.5 for lighting, 3×2.5 for sockets and
 * dedicated appliances on a 16 A group, 5×2.5 for a 3×16 A hob or an 11 kW charge point,
 * 5×6 for 3×32 A (22 kW).
 */
const SEEDS: Seed[] = [
  // --- Fresh water -------------------------------------------------------------------
  { id: 'water.cold', category: 'water', name: 'Cold water (KW)', color: '#2563eb', dash: D.solid, width: 1.8, sizes: ['Ø16', 'Ø20', 'Ø25', 'Ø32'] },
  { id: 'water.hot', category: 'water', name: 'Hot water (WW)', color: '#dc2626', dash: D.solid, width: 1.8, sizes: ['Ø16', 'Ø20', 'Ø25'] },
  { id: 'water.circ', category: 'water', name: 'DHW circulation', color: '#dc2626', dash: D.dash, width: 1.3, sizes: ['Ø12', 'Ø16'], assumeFlow: true },
  { id: 'water.soft', category: 'water', name: 'Softened water', color: '#0891b2', dash: D.solid, width: 1.8, sizes: ['Ø16', 'Ø20', 'Ø25'] },
  { id: 'water.outdoor', category: 'water', name: 'Outdoor / garden tap', color: '#0f766e', dash: D.dash, width: 1.5, sizes: ['Ø16', 'Ø20'] },
  { id: 'water.fill', category: 'water', name: 'Heating fill loop', color: '#0891b2', dash: D.dot, width: 1.2, sizes: ['Ø12', 'Ø16'] },

  // --- Rainwater reuse (non-potable) -------------------------------------------------
  { id: 'reuse.supply', category: 'reuse', name: 'Tank → pump suction', color: '#4d7c0f', dash: D.dashdot, width: 2.2, sizes: ['Ø32', 'Ø25', 'Ø40'], tag: 'NON-POTABLE', assumeFlow: true },
  { id: 'reuse.dist', category: 'reuse', name: 'Non-potable distribution', color: '#4d7c0f', dash: D.solid, width: 1.8, sizes: ['Ø16', 'Ø20', 'Ø25'], tag: 'NON-POTABLE' },
  { id: 'reuse.topup', category: 'reuse', name: 'Mains top-up (air gap)', color: '#2563eb', dash: D.dashdot, width: 1.5, sizes: ['Ø16', 'Ø20'] },
  { id: 'reuse.overflow', category: 'reuse', name: 'Tank overflow', color: '#4d7c0f', dash: D.long, width: 2.4, sizes: ['Ø110', 'Ø75', 'Ø125'], assumeFlow: true },

  // --- Drainage ----------------------------------------------------------------------
  { id: 'drain.soil', category: 'drain', name: 'Soil / black water', color: '#b45309', dash: D.solid, width: 3.0, sizes: ['Ø110', 'Ø125', 'Ø160'], assumeFlow: true },
  { id: 'drain.waste', category: 'drain', name: 'Waste / grey water', color: '#b45309', dash: D.solid, width: 2.0, sizes: ['Ø50', 'Ø32', 'Ø40', 'Ø75'], assumeFlow: true },
  { id: 'drain.vent', category: 'drain', name: 'Vent / stack vent', color: '#b45309', dash: D.dashdot, width: 1.5, sizes: ['Ø75', 'Ø50', 'Ø110'], assumeFlow: true },
  { id: 'drain.rain', category: 'drain', name: 'Rainwater downpipe (HWA)', color: '#1e3a8a', dash: D.solid, width: 2.4, sizes: ['Ø80', 'Ø70', 'Ø100', 'Ø110', 'Ø125'], assumeFlow: true },
  { id: 'drain.condensate', category: 'drain', name: 'Condensate drain', color: '#0891b2', dash: D.dot, width: 1.3, sizes: ['Ø20', 'Ø25', 'Ø32'], assumeFlow: true },

  // --- Heating / heat pump ------------------------------------------------------------
  { id: 'heat.ufh', category: 'heat', name: 'Underfloor heating loop', color: '#ea580c', dash: D.solid, width: 1.4, sizes: ['Ø16', 'Ø17', 'Ø20'] },
  { id: 'heat.flow', category: 'heat', name: 'Heating flow', color: '#dc2626', dash: D.long, width: 2.2, sizes: ['Ø22', 'Ø16', 'Ø28', 'Ø35'], assumeFlow: true },
  { id: 'heat.return', category: 'heat', name: 'Heating return', color: '#7c3aed', dash: D.long, width: 2.2, sizes: ['Ø22', 'Ø16', 'Ø28', 'Ø35'], assumeFlow: true },
  { id: 'heat.hp', category: 'heat', name: 'Heat pump line set', color: '#a21caf', dash: D.dash, width: 2.4, sizes: ['2×Ø28', '2×Ø35', '1/4"+3/8"', '1/4"+5/8"', '3/8"+5/8"'] },

  // --- Ventilation --------------------------------------------------------------------
  { id: 'air.supply', category: 'air', name: 'Supply air (toevoer)', color: '#0891b2', dash: D.solid, width: 3.4, sizes: ['Ø125', 'Ø75', 'Ø90', 'Ø100', 'Ø160', 'Ø180'], assumeFlow: true },
  { id: 'air.extract', category: 'air', name: 'Extract air (afvoer)', color: '#ca8a04', dash: D.solid, width: 3.4, sizes: ['Ø125', 'Ø75', 'Ø90', 'Ø100', 'Ø160', 'Ø180'], assumeFlow: true },
  { id: 'air.outside', category: 'air', name: 'Outside air / exhaust', color: '#475569', dash: D.solid, width: 3.8, sizes: ['Ø160', 'Ø125', 'Ø180', 'Ø200'], assumeFlow: true },
  { id: 'air.dryer', category: 'air', name: 'Tumble dryer exhaust', color: '#475569', dash: D.dash, width: 2.8, sizes: ['Ø100', 'Ø125', 'Ø150'], assumeFlow: true },

  // --- Power --------------------------------------------------------------------------
  { id: 'power.light', category: 'power', name: '230V lighting group', color: '#ca8a04', dash: D.solid, width: 1.4, sizes: ['3×1.5mm²', '4×1.5mm²', '5×1.5mm²', '3×2.5mm²'] },
  { id: 'power.socket', category: 'power', name: '230V socket group', color: '#ea580c', dash: D.solid, width: 1.7, sizes: ['3×2.5mm²', '3×1.5mm²', '3×4mm²'] },
  { id: 'power.appliance', category: 'power', name: '230V dedicated appliance', color: '#ea580c', dash: D.dash, width: 2.0, sizes: ['3×2.5mm²', '3×4mm²', '3×6mm²'] },
  { id: 'power.3ph', category: 'power', name: '400V 3-phase', color: '#dc2626', dash: D.dashdot, width: 2.4, sizes: ['5×2.5mm²', '5×4mm²', '5×6mm²', '5×10mm²', '5×16mm²'] },
  { id: 'power.earth', category: 'power', name: 'Earthing / bonding', color: '#16a34a', dash: D.solid, width: 1.9, sizes: ['6mm²', '4mm²', '10mm²', '16mm²'] },
  { id: 'power.pv', category: 'power', name: 'PV DC string', color: '#dc2626', dash: D.dot, width: 1.5, sizes: ['2×6mm²', '2×4mm²', '2×10mm²'] },
  { id: 'power.conduit', category: 'power', name: 'Empty conduit (loze leiding)', color: '#475569', dash: D.dot, width: 1.8, sizes: ['Ø19', 'Ø16', 'Ø25', 'Ø40', 'Ø50'] },
  { id: 'power.smoke', category: 'power', name: 'Smoke detectors (interlinked)', color: '#db2777', dash: D.dashdotdot, width: 1.4, sizes: ['3×1.5mm² + interlink', '4×1.5mm²', '3×1.5mm² (RF interlink)'] },
  { id: 'power.outdoor', category: 'power', name: 'Outdoor / outbuilding feed', color: '#4d7c0f', dash: D.dash, width: 2.0, sizes: ['XMvK 4×6mm²', 'XMvK 3×2.5mm²', 'XMvK 5×2.5mm²', 'XMvK 5×6mm²', 'XMvK 5×10mm²'] },

  // --- Data / low voltage --------------------------------------------------------------
  { id: 'data.cat6', category: 'data', name: 'CAT6A', color: '#7c3aed', dash: D.solid, width: 1.3, sizes: ['CAT6A', 'CAT6', '2×CAT6A', 'CAT7'] },
  { id: 'data.fiber', category: 'data', name: 'Fiber / ISP entry', color: '#6b21a8', dash: D.dashdot, width: 1.3, sizes: ['duplex OS2', 'G.657.A2'] },
  { id: 'data.coax', category: 'data', name: 'Coax', color: '#b45309', dash: D.dot, width: 1.1, sizes: ['RG6', 'RG11'] },
  { id: 'data.sensor', category: 'data', name: 'Sensor / bus (KNX, 1-Wire)', color: '#db2777', dash: D.solid, width: 1.1, sizes: ['KNX 2×2×0.8', '2×0.8mm', '4×0.8mm', 'CAT6A'] },
  { id: 'data.speaker', category: 'data', name: 'Speaker', color: '#db2777', dash: D.dot, width: 1.1, sizes: ['2×1.5mm²', '2×2.5mm²', '4×1.5mm²'] },
  { id: 'data.security', category: 'data', name: 'Alarm / camera', color: '#a21caf', dash: D.dash, width: 1.3, sizes: ['CAT6A (PoE)', '6×0.22mm', '8×0.22mm'] },

  // --- Structure / coordination ---------------------------------------------------------
  { id: 'struct.penetration', category: 'struct', name: 'Penetration (sparing)', color: '#171717', dash: D.solid, width: 1.5, sizes: ['Ø110', 'Ø50', 'Ø75', 'Ø125', 'Ø160', '200×200'] },
  { id: 'struct.shaft', category: 'struct', name: 'Shaft / chase', color: '#475569', dash: D.long, width: 1.8 },
  { id: 'struct.nodrill', category: 'struct', name: 'No-drill zone', color: '#dc2626', dash: D.dashdotdot, width: 1.4 },
  { id: 'struct.airtight', category: 'struct', name: 'Airtightness penetration', color: '#db2777', dash: D.dot, width: 1.5 },
  { id: 'struct.note', category: 'struct', name: 'General note', color: '#ca8a04', dash: D.solid, width: 1.2 },
  { id: 'struct.room', category: 'struct', name: 'Room', color: '#0f766e', dash: D.solid, width: 1.0 },
  { id: 'struct.door', category: 'struct', name: 'Door', color: '#7c3aed', dash: D.solid, width: 1.6 },
]

export function defaultSystems(): System[] {
  return SEEDS.map((seed) => {
    const system: System = { ...seed, dash: [...seed.dash], visible: true, locked: false }
    if (seed.sizes?.length) {
      system.sizes = [...seed.sizes]
      system.defaultSize = seed.sizes[0]
    } else {
      delete system.sizes
    }
    if (seed.tag === undefined) delete system.tag
    return system
  })
}

/**
 * Seeded systems this project does not have. The catalogue is stored per project, so a
 * project saved before a system existed will not have it - but silently merging new defaults
 * back in on load would resurrect systems you deliberately deleted. The Systems editor offers
 * this instead, so it stays your decision.
 */
export function missingDefaults(systems: System[]): System[] {
  const present = new Set(systems.map((s) => s.id))
  return defaultSystems().filter((seed) => !present.has(seed.id))
}

export const FALLBACK_SYSTEM: System = {
  id: '__missing__',
  category: 'struct',
  name: 'Unknown system',
  color: '#94a3b8',
  dash: [4, 4],
  width: 1.5,
  visible: true,
  locked: false,
}
