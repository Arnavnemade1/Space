/**
 * Launch vehicle and launch site database.
 *
 * ON THE NUMBERS: stage masses, thrusts and specific impulses for operational
 * vehicles are published or well-attested figures. Where a vehicle is not yet
 * flying, or where the operator has never published stage-level numbers, the
 * entry is marked `confidence: 'estimated'` and the payload figures come from
 * the operator's own published capability rather than from the stage model.
 *
 * This distinction matters. The ascent simulator will happily integrate an
 * estimated vehicle and produce a confident-looking trajectory; the
 * `confidence` field is what stops that from being mistaken for a prediction.
 * The UI surfaces it on every result.
 *
 * Mass units: kg. Thrust: N. Isp: s. Areas: m^2.
 */

/**
 * @typedef {object} Stage
 * @property {string} name
 * @property {number} dryMass          structural + engine mass at burnout [kg]
 * @property {number} propellantMass   usable propellant [kg]
 * @property {number} thrustSeaLevel   total sea-level thrust [N]
 * @property {number} thrustVacuum     total vacuum thrust [N]
 * @property {number} ispSeaLevel      sea-level specific impulse [s]
 * @property {number} ispVacuum        vacuum specific impulse [s]
 * @property {number} [minThrottle]    fraction of rated thrust, 1 = no throttle
 * @property {number} [engines]        engine count (for engine-out studies)
 */

/**
 * Nozzle exit area implied by the sea-level/vacuum thrust difference.
 *
 *   F_vac - F_sl = A_e * P_sl   =>   A_e = (F_vac - F_sl) / 101325
 *
 * This lets thrust be computed correctly at every altitude rather than being
 * switched between two constants. For a Falcon 9 first stage it recovers about
 * 6.1 m^2 of total exit area across nine engines, which is the right order for
 * a 0.92 m exit diameter Merlin.
 */
export function nozzleExitArea(stage) {
  return Math.max(0, (stage.thrustVacuum - stage.thrustSeaLevel) / 101325);
}

/**
 * Thrust at an ambient pressure, and the matching mass flow rate.
 *
 * Mass flow is fixed by the vacuum condition (the engine's turbopumps do not
 * know what the outside pressure is); thrust then falls by A_e * P_ambient.
 *
 * @param {Stage} stage
 * @param {number} ambientPressure [Pa]
 * @param {number} [throttle] 0..1
 * @returns {{thrust:number, massFlow:number, isp:number}}
 */
export function stageThrust(stage, ambientPressure, throttle = 1) {
  const massFlow = (stage.thrustVacuum * throttle) / (stage.ispVacuum * 9.80665);
  const ae = nozzleExitArea(stage);
  const thrust = Math.max(0, stage.thrustVacuum * throttle - ae * ambientPressure);
  const isp = massFlow > 0 ? thrust / (massFlow * 9.80665) : 0;
  return { thrust, massFlow, isp };
}

/** Ideal delta-v of a single stage carrying `payloadAbove` kg [m/s]. */
export function stageDeltaV(stage, payloadAbove, ispOverride) {
  const isp = ispOverride ?? stage.ispVacuum;
  const m0 = stage.dryMass + stage.propellantMass + payloadAbove;
  const mf = stage.dryMass + payloadAbove;
  return isp * 9.80665 * Math.log(m0 / mf);
}

/**
 * Total mass of a stage's strap-on boosters, propellant included [kg].
 * Returns 0 for stages without boosters.
 */
export function boosterMass(stage) {
  const b = stage.boosters;
  return b ? b.dryMass + b.propellantMass : 0;
}

/** Nozzle exit area of a stage's boosters, inferred as for the core. */
export function boosterExitArea(stage) {
  const b = stage.boosters;
  if (!b) return 0;
  return Math.max(0, (b.thrustVacuum - b.thrustSeaLevel) / 101325);
}

/**
 * Total liftoff thrust of a stage, boosters included [N].
 * Strap-ons dominate this for every vehicle that has them, which is the whole
 * reason they exist -- a hydrolox core alone usually cannot lift its own stack.
 */
export function liftoffThrust(stage, ambientPressure = 101325) {
  const b = stage.boosters;
  const throttle = b?.coreThrottle ?? 1;
  const core = Math.max(
    0,
    stage.thrustVacuum * throttle - nozzleExitArea(stage) * ambientPressure * throttle,
  );
  if (!b) return core;
  return core + Math.max(0, b.thrustVacuum - boosterExitArea(stage) * ambientPressure);
}

/**
 * Ideal (vacuum, no-loss) delta-v of a full stack.
 *
 * Stages with strap-on boosters are split into two phases, because averaging a
 * 450 s hydrolox core together with 270 s solids into one effective Isp badly
 * understates the vehicle: in reality the solids burn out early and are thrown
 * away, and the core then spends most of its propellant at its own high Isp.
 * Treating SLS that way costs it more than a kilometre per second of apparent
 * performance, which is the difference between reaching orbit and not.
 *
 * Always optimistic regardless: it ignores gravity, drag and steering losses,
 * which together cost 1.5-2.0 km/s on a real Earth ascent. The ascent
 * simulator computes those explicitly.
 */
export function idealDeltaV(vehicle, payloadMass) {
  let above = payloadMass + (vehicle.fairingMass ?? 0);
  let total = 0;

  for (let i = vehicle.stages.length - 1; i >= 0; i--) {
    const st = vehicle.stages[i];
    const b = st.boosters;

    if (!b) {
      total += stageDeltaV(st, above);
      above += st.dryMass + st.propellantMass;
      continue;
    }

    // Phase 1: core and boosters burning together, core possibly throttled.
    const coreThrottle = b.coreThrottle ?? 1;
    const mdotCore = (st.thrustVacuum * coreThrottle) / (st.ispVacuum * 9.80665);
    const mdotBoost = b.thrustVacuum / (b.ispVacuum * 9.80665);
    const boostDuration = b.propellantMass / mdotBoost;
    const coreUsedInBoost = Math.min(st.propellantMass, mdotCore * boostDuration);

    const ispCombined =
      (st.thrustVacuum * coreThrottle + b.thrustVacuum) /
      ((mdotCore + mdotBoost) * 9.80665);

    const m0 = above + st.dryMass + st.propellantMass + b.dryMass + b.propellantMass;
    const m1 = m0 - b.propellantMass - coreUsedInBoost;
    total += ispCombined * 9.80665 * Math.log(m0 / m1);

    // Phase 2: boosters jettisoned, core alone on its remaining propellant.
    const m2 = m1 - b.dryMass;
    const m3 = m2 - (st.propellantMass - coreUsedInBoost);
    if (m3 > 0) total += st.ispVacuum * 9.80665 * Math.log(m2 / m3);

    above += st.dryMass + st.propellantMass + b.dryMass + b.propellantMass;
  }
  return total;
}

/** Gross lift-off mass including payload and any strap-on boosters [kg]. */
export function grossMass(vehicle, payloadMass) {
  return (
    vehicle.stages.reduce(
      (s, st) => s + st.dryMass + st.propellantMass + boosterMass(st),
      0,
    ) +
    (vehicle.fairingMass ?? 0) +
    payloadMass
  );
}

/**
 * Bulk propellant densities [kg/m^3] -- the mixture density of fuel and
 * oxidiser at their flight mixture ratio, not either component alone.
 *
 * This is what sets how BIG a stage is for a given mass, and the spread is
 * enormous. Hydrolox is a third the density of kerolox, which is why a
 * hydrogen stage holding half the propellant mass can be twice the length.
 * SLS and Ariane 6 look the way they do entirely because of this number.
 */
export const PROPELLANT_DENSITY = {
  kerolox: 1030,   // RP-1 / LOX at ~2.56 O/F
  methalox: 830,   // CH4 / LOX at ~3.6 O/F
  hydrolox: 360,   // LH2 / LOX at ~6.0 O/F
  solid: 1770,     // HTPB / ammonium perchlorate composite
  hypergolic: 1200,
};

/**
 * Physical length of a stage's tankage [m], from propellant volume.
 * `ullageFactor` accounts for the volume tanks carry beyond usable propellant:
 * ullage space, residuals, common bulkhead geometry and domed ends.
 */
export function stageTankLength(stage, diameter, ullageFactor = 1.12) {
  const rho = PROPELLANT_DENSITY[stage.propellant ?? 'kerolox'];
  const volume = (stage.propellantMass / rho) * ullageFactor;
  return volume / (Math.PI * (diameter / 2) ** 2);
}

/**
 * Length of ONE strap-on booster [m].
 *
 * The stage's `propellantMass` is the total across all of them, so it has to be
 * divided by `count` before it becomes a single booster's volume -- otherwise a
 * Falcon Heavy side booster comes out 400 m long.
 */
export function boosterLength(stage, ullageFactor = 1.12) {
  const b = stage.boosters;
  if (!b) return 0;
  const rho = PROPELLANT_DENSITY[b.propellant ?? 'solid'];
  const perUnit = b.propellantMass / (b.count || 1);
  const volume = (perUnit / rho) * ullageFactor;
  return volume / (Math.PI * ((b.diameter ?? 2) / 2) ** 2);
}

// ---------------------------------------------------------------------------
// Vehicle database
// ---------------------------------------------------------------------------

/** @type {Record<string, object>} */
export const VEHICLES = {
  falcon9: {
    id: 'falcon9',
    name: 'Falcon 9 Block 5',
    operator: 'SpaceX',
    confidence: 'published',
    diameter: 3.7,
    fairingMass: 1900,
    // Published LEO capability, expendable and with booster recovery.
    payloadLeoExpendable: 22800,
    payloadLeoReusable: 17500,
    payloadGto: 8300,
    stages: [
      {
        name: 'S1 (9x Merlin 1D)',
        propellant: 'kerolox',
        engines: 9,
        dryMass: 25600,
        propellantMass: 411000,
        thrustSeaLevel: 7607000,
        thrustVacuum: 8227000,
        ispSeaLevel: 283,
        ispVacuum: 312,
        minThrottle: 0.4,
      },
      {
        name: 'S2 (1x Merlin Vacuum)',
        propellant: 'kerolox',
        engines: 1,
        dryMass: 3900,
        propellantMass: 107500,
        thrustSeaLevel: 934000,
        thrustVacuum: 981000,
        ispSeaLevel: 340,
        ispVacuum: 348,
        minThrottle: 0.4,
      },
    ],
    notes:
      'Recovery reserves roughly 30 t of first-stage propellant for boostback ' +
      'and landing, which is why the reusable payload is ~23% lower.',
  },

  falconHeavy: {
    id: 'falconHeavy',
    name: 'Falcon Heavy',
    operator: 'SpaceX',
    confidence: 'published',
    diameter: 3.7,
    fairingMass: 1900,
    payloadLeoExpendable: 63800,
    payloadLeoReusable: 30000,
    payloadGto: 26700,
    stages: [
      {
        name: 'Centre core (9x Merlin 1D)',
        propellant: 'kerolox',
        engines: 9,
        dryMass: 25600,
        propellantMass: 411000,
        thrustSeaLevel: 7607000,
        thrustVacuum: 8227000,
        ispSeaLevel: 283,
        ispVacuum: 312,
        minThrottle: 0.4,
        boosters: {
          name: '2x Falcon 9 side boosters',
          propellant: 'kerolox',
          count: 2,
          diameter: 3.7,
          dryMass: 51200,
          propellantMass: 822000,
          thrustSeaLevel: 15214000,
          thrustVacuum: 16454000,
          ispSeaLevel: 283,
          ispVacuum: 312,
          // Falcon Heavy throttles its centre core down hard while the side
          // boosters are burning, so the core still has roughly 40% of its
          // propellant left at separation. Without this the core runs dry at
          // the same instant as the boosters and the vehicle loses about
          // 1.5 km/s of apparent performance.
          coreThrottle: 0.55,
        },
      },
      {
        name: 'S2 (1x Merlin Vacuum)',
        engines: 1,
        dryMass: 3900,
        propellantMass: 107500,
        thrustSeaLevel: 934000,
        thrustVacuum: 981000,
        ispSeaLevel: 340,
        ispVacuum: 348,
        minThrottle: 0.4,
      },
    ],
    notes:
      'Side boosters are modelled as a true parallel burn and are jettisoned ' +
      'when their propellant runs out. The real vehicle also throttles the ' +
      'centre core deeply during the boost phase to save propellant for after ' +
      'separation; that is not modelled, so the core burns out earlier here ' +
      'than it does in flight.',
  },

  starship: {
    id: 'starship',
    name: 'Starship / Super Heavy',
    operator: 'SpaceX',
    confidence: 'estimated',
    diameter: 9,
    fairingMass: 0, // integrated payload bay
    payloadLeoExpendable: 150000,
    payloadLeoReusable: 100000,
    payloadGto: 21000,
    stages: [
      {
        name: 'Super Heavy (33x Raptor 2)',
        propellant: 'methalox',
        engines: 33,
        dryMass: 200000,
        propellantMass: 3400000,
        thrustSeaLevel: 74400000,
        thrustVacuum: 80000000,
        ispSeaLevel: 327,
        ispVacuum: 350,
        minThrottle: 0.4,
      },
      {
        name: 'Ship (3x Raptor SL + 3x Raptor Vac)',
        propellant: 'methalox',
        engines: 6,
        dryMass: 120000,
        propellantMass: 1200000,
        thrustSeaLevel: 12000000,
        thrustVacuum: 14700000,
        ispSeaLevel: 330,
        ispVacuum: 375,
        minThrottle: 0.4,
      },
    ],
    notes:
      'ESTIMATED. SpaceX has not published stage-level dry masses or propellant ' +
      'loads, and the vehicle is still evolving between blocks. Payload figures ' +
      'are stated targets, not demonstrated performance. Treat any Starship ' +
      'result here as a sensitivity study, not a prediction.',
  },

  electron: {
    id: 'electron',
    name: 'Electron',
    operator: 'Rocket Lab',
    confidence: 'published',
    diameter: 1.2,
    fairingMass: 50,
    payloadLeoExpendable: 320,
    payloadLeoReusable: 300,
    payloadGto: 0,
    stages: [
      {
        name: 'S1 (9x Rutherford)',
        propellant: 'kerolox',
        engines: 9,
        dryMass: 950,
        propellantMass: 9250,
        thrustSeaLevel: 162000,
        thrustVacuum: 192000,
        ispSeaLevel: 303,
        ispVacuum: 311,
        minThrottle: 0.6,
      },
      {
        name: 'S2 (1x Rutherford Vacuum)',
        propellant: 'kerolox',
        engines: 1,
        dryMass: 250,
        propellantMass: 2050,
        thrustSeaLevel: 21000,
        thrustVacuum: 25800,
        ispSeaLevel: 320,
        ispVacuum: 343,
        minThrottle: 0.6,
      },
    ],
    notes:
      'Included as a lower bound. At 320 kg to LEO an Electron cannot loft a ' +
      'meaningful datacenter module -- useful for showing why launch cadence ' +
      'alone does not solve mass-to-orbit.',
  },

  neutron: {
    id: 'neutron',
    name: 'Neutron',
    operator: 'Rocket Lab',
    confidence: 'estimated',
    diameter: 7,
    fairingMass: 0,
    payloadLeoExpendable: 15000,
    payloadLeoReusable: 13000,
    payloadGto: 5000,
    stages: [
      {
        name: 'S1 (9x Archimedes)',
        propellant: 'methalox',
        engines: 9,
        dryMass: 22000,
        propellantMass: 350000,
        thrustSeaLevel: 6570000,
        thrustVacuum: 7300000,
        ispSeaLevel: 320,
        ispVacuum: 345,
        minThrottle: 0.5,
      },
      {
        name: 'S2 (1x Archimedes Vacuum)',
        propellant: 'methalox',
        engines: 1,
        dryMass: 3000,
        propellantMass: 70000,
        thrustSeaLevel: 0,
        thrustVacuum: 890000,
        ispSeaLevel: 0,
        ispVacuum: 367,
        minThrottle: 0.5,
      },
    ],
    notes: 'ESTIMATED. Pre-flight vehicle; stage masses are inferred.',
  },

  newGlenn: {
    id: 'newGlenn',
    name: 'New Glenn',
    operator: 'Blue Origin',
    confidence: 'estimated',
    diameter: 7,
    fairingMass: 3500,
    payloadLeoExpendable: 45000,
    payloadLeoReusable: 45000,
    payloadGto: 13600,
    stages: [
      {
        name: 'S1 (7x BE-4)',
        propellant: 'methalox',
        engines: 7,
        dryMass: 68000,
        propellantMass: 1050000,
        thrustSeaLevel: 17100000,
        thrustVacuum: 19000000,
        ispSeaLevel: 310,
        ispVacuum: 340,
        minThrottle: 0.4,
      },
      {
        name: 'S2 (2x BE-3U)',
        propellant: 'hydrolox',
        engines: 2,
        dryMass: 14000,
        propellantMass: 160000,
        thrustSeaLevel: 0,
        thrustVacuum: 1400000,
        ispSeaLevel: 0,
        ispVacuum: 445,
        minThrottle: 0.5,
      },
    ],
    notes:
      'ESTIMATED stage masses. The hydrolox upper stage Isp of 445 s is the ' +
      'published BE-3U figure and is the reason its GTO performance is strong ' +
      'relative to its LEO number.',
  },

  vulcan: {
    id: 'vulcan',
    name: 'Vulcan Centaur (VC6)',
    operator: 'ULA',
    confidence: 'estimated',
    diameter: 5.4,
    fairingMass: 4000,
    payloadLeoExpendable: 27200,
    payloadLeoReusable: 27200,
    payloadGto: 14400,
    stages: [
      {
        name: 'Core (2x BE-4)',
        propellant: 'methalox',
        engines: 2,
        dryMass: 25000,
        propellantMass: 340000,
        thrustSeaLevel: 4800000,
        thrustVacuum: 5280000,
        ispSeaLevel: 310,
        ispVacuum: 340,
        minThrottle: 0.6,
        boosters: {
          name: '6x GEM-63XL solid',
          propellant: 'solid',
          count: 6,
          diameter: 1.6,
          dryMass: 30000,
          propellantMass: 285600,
          // Burn-average thrust, not the peak figure: a GEM-63XL peaks near
          // 2027 kN but averages about 1653 kN over its burn, and a constant-
          // thrust model that uses the peak overstates liftoff T/W by 25%.
          thrustSeaLevel: 9918000,
          thrustVacuum: 10900000,
          ispSeaLevel: 255,
          ispVacuum: 279,
        },
      },
      {
        name: 'Centaur V (2x RL10C)',
        propellant: 'hydrolox',
        engines: 2,
        dryMass: 5500,
        propellantMass: 54000,
        thrustSeaLevel: 0,
        thrustVacuum: 212000,
        ispSeaLevel: 0,
        ispVacuum: 453,
        minThrottle: 1,
      },
    ],
    notes:
      'ESTIMATED stage masses. The six GEM-63XL solids burn out and are ' +
      'jettisoned around T+100 s, after which the methalox core continues ' +
      'alone -- modelled as a real parallel burn rather than an averaged one.',
  },

  ariane6: {
    id: 'ariane6',
    name: 'Ariane 64',
    operator: 'ArianeGroup / ESA',
    confidence: 'estimated',
    diameter: 5.4,
    fairingMass: 3000,
    payloadLeoExpendable: 21650,
    payloadLeoReusable: 21650,
    payloadGto: 11500,
    stages: [
      {
        name: 'LLPM core (1x Vulcain 2.1)',
        propellant: 'hydrolox',
        engines: 1,
        dryMass: 14700,
        propellantMass: 140000,
        thrustSeaLevel: 960000,
        thrustVacuum: 1370000,
        ispSeaLevel: 320,
        ispVacuum: 431,
        minThrottle: 1,
        boosters: {
          name: '4x P120C solid',
          propellant: 'solid',
          count: 4,
          diameter: 3.4,
          dryMass: 44000,
          propellantMass: 568000,
          // Burn-average thrust per the same reasoning as Vulcan's GEM-63XL.
          thrustSeaLevel: 14800000,
          thrustVacuum: 16000000,
          ispSeaLevel: 255,
          ispVacuum: 278.5,
        },
      },
      {
        name: 'ULPM (Vinci)',
        propellant: 'hydrolox',
        engines: 1,
        dryMass: 5500,
        propellantMass: 31000,
        thrustSeaLevel: 0,
        thrustVacuum: 180000,
        ispSeaLevel: 0,
        ispVacuum: 457,
        minThrottle: 1,
      },
    ],
    notes:
      'ESTIMATED stage masses. The Vulcain 2.1 core cannot lift the stack on ' +
      'its own -- at 0.96 MN against an 800 t vehicle its thrust-to-weight is ' +
      'about 0.12. The four P120C solids provide 95% of liftoff thrust, which ' +
      'is exactly why the architecture exists.',
  },

  slsBlock1: {
    id: 'slsBlock1',
    name: 'SLS Block 1',
    operator: 'NASA',
    confidence: 'estimated',
    diameter: 8.4,
    fairingMass: 0,
    payloadLeoExpendable: 95000,
    payloadLeoReusable: 95000,
    payloadGto: 0,
    stages: [
      {
        name: 'Core stage (4x RS-25D)',
        propellant: 'hydrolox',
        engines: 4,
        dryMass: 85275,
        propellantMass: 979452,
        thrustSeaLevel: 7440000,
        thrustVacuum: 9116000,
        ispSeaLevel: 366,
        ispVacuum: 452.3,
        minThrottle: 0.67,
        boosters: {
          name: '2x 5-segment SRB',
          propellant: 'solid',
          count: 2,
          diameter: 3.71,
          dryMass: 197800,
          propellantMass: 1262370,
          thrustSeaLevel: 29000000,
          thrustVacuum: 32000000,
          ispSeaLevel: 242,
          ispVacuum: 269,
        },
      },
      {
        name: 'ICPS (1x RL10B-2)',
        propellant: 'hydrolox',
        engines: 1,
        dryMass: 3800,
        propellantMass: 27000,
        thrustSeaLevel: 0,
        thrustVacuum: 110000,
        ispSeaLevel: 0,
        ispVacuum: 462,
        minThrottle: 1,
      },
    ],
    notes:
      'ESTIMATED stage masses. The RS-25 core runs at 452 s vacuum Isp and the ' +
      'solids at 269 s; averaging the two into one stage understates the ' +
      'vehicle by well over a km/s, so they are modelled as a true parallel ' +
      'burn with the solids jettisoned at burnout. Included mainly for the ' +
      'cost comparison -- SLS is roughly two orders of magnitude more ' +
      'expensive per kg than the reusable options.',
  },
};

// ---------------------------------------------------------------------------
// Launch sites
// ---------------------------------------------------------------------------

/**
 * Launch sites with geodetic coordinates and achievable azimuth ranges.
 *
 * The azimuth limits are the operationally flown corridors, constrained by
 * overflight of populated areas -- they are the real reason a site cannot
 * reach every inclination, not physics. Minimum reachable inclination equals
 * the site latitude; a due-east launch (azimuth 90) achieves exactly that.
 */
export const LAUNCH_SITES = {
  ksc: {
    id: 'ksc',
    name: 'Kennedy Space Center LC-39A',
    country: 'USA',
    latitude: 28.6084,
    longitude: -80.6043,
    altitude: 3,
    azimuthMin: 35,
    azimuthMax: 120,
    notes: 'Eastern range. Dogleg required for high inclination.',
  },
  ccsfs: {
    id: 'ccsfs',
    name: 'Cape Canaveral SLC-40',
    country: 'USA',
    latitude: 28.5619,
    longitude: -80.5772,
    altitude: 3,
    azimuthMin: 35,
    azimuthMax: 120,
  },
  vandenberg: {
    id: 'vandenberg',
    name: 'Vandenberg SFB SLC-4E',
    country: 'USA',
    latitude: 34.632,
    longitude: -120.611,
    altitude: 100,
    azimuthMin: 158,
    azimuthMax: 201,
    notes: 'Southerly corridor over open ocean: the US polar/SSO site.',
  },
  starbase: {
    id: 'starbase',
    name: 'Starbase, Boca Chica',
    country: 'USA',
    latitude: 25.9971,
    longitude: -97.1554,
    altitude: 5,
    azimuthMin: 80,
    azimuthMax: 120,
    notes: 'Gulf of Mexico corridor is narrow; limits inclination options.',
  },
  kourou: {
    id: 'kourou',
    name: "Guiana Space Centre, Kourou",
    country: 'France (ESA)',
    latitude: 5.239,
    longitude: -52.768,
    altitude: 15,
    azimuthMin: -10.5,
    azimuthMax: 93.5,
    notes:
      'At 5.2 deg latitude this is the best equatorial site available to ' +
      'Western operators: 463 m/s of free eastward rotation and almost no ' +
      'plane change needed for GEO.',
  },
  baikonur: {
    id: 'baikonur',
    name: 'Baikonur Cosmodrome',
    country: 'Kazakhstan',
    latitude: 45.965,
    longitude: 63.305,
    altitude: 90,
    azimuthMin: 34,
    azimuthMax: 100,
    notes: 'High latitude drives the 51.6 deg ISS inclination.',
  },
  wenchang: {
    id: 'wenchang',
    name: 'Wenchang Space Launch Site',
    country: 'China',
    latitude: 19.614,
    longitude: 110.951,
    altitude: 10,
    azimuthMin: 90,
    azimuthMax: 175,
  },
  sriharikota: {
    id: 'sriharikota',
    name: 'Satish Dhawan Space Centre',
    country: 'India',
    latitude: 13.733,
    longitude: 80.235,
    altitude: 20,
    azimuthMin: 90,
    azimuthMax: 140,
  },
  mahia: {
    id: 'mahia',
    name: 'Rocket Lab LC-1, Mahia',
    country: 'New Zealand',
    latitude: -39.261,
    longitude: 177.865,
    altitude: 30,
    azimuthMin: 20,
    azimuthMax: 120,
    notes: 'Wide azimuth range over empty ocean: any inclination from 39 deg up.',
  },
};

/**
 * Launch azimuth needed to reach a target inclination from a given latitude,
 * ignoring Earth rotation.
 *
 *   cos(i) = cos(lat) * sin(azimuth)
 *
 * Returns NaN when |i| < |lat| -- the orbit plane must pass through the launch
 * site, so no direct launch can reach an inclination below the site latitude.
 * Reaching one requires a dogleg or an on-orbit plane change, both expensive.
 *
 * @param {number} latDeg site latitude [deg]
 * @param {number} incDeg target inclination [deg]
 * @returns {{azimuthDeg:number, retrogradeAzimuthDeg:number}|null}
 */
export function launchAzimuth(latDeg, incDeg) {
  const lat = (latDeg * Math.PI) / 180;
  const inc = (incDeg * Math.PI) / 180;
  const sinAz = Math.cos(inc) / Math.cos(lat);
  if (Math.abs(sinAz) > 1) return null;
  const az = Math.asin(sinAz);
  return {
    azimuthDeg: (az * 180) / Math.PI,
    retrogradeAzimuthDeg: 180 - (az * 180) / Math.PI,
  };
}

/**
 * Eastward velocity supplied free by Earth's rotation at a launch site [m/s].
 * 465.1 m/s at the equator, falling as cos(latitude).
 */
export function rotationBonus(latDeg, altitude = 0) {
  const OMEGA = 7.292115e-5;
  const RE = 6378137.0;
  const F = 1 / 298.257223563;
  const lat = (latDeg * Math.PI) / 180;
  const N = RE / Math.sqrt(1 - (2 * F - F * F) * Math.sin(lat) ** 2);
  return OMEGA * (N + altitude) * Math.cos(lat);
}

/**
 * Component of the rotation bonus actually useful for a given launch azimuth.
 * A due-east launch (azimuth 90) captures all of it; a polar launch captures
 * none and a retrograde launch pays it back twice.
 */
export function usefulRotationBonus(latDeg, azimuthDeg, altitude = 0) {
  return rotationBonus(latDeg, altitude) * Math.sin((azimuthDeg * Math.PI) / 180);
}
