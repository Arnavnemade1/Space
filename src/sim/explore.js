/**
 * Parameter-space exploration.
 *
 * Everything here is about running MANY configurations and comparing them,
 * rather than examining one. That is a different job from the single-case
 * simulators and it needs different machinery: a cartesian product over named
 * axes, a flat row of comparable metrics per case, and ranking that does not
 * quietly collapse a multi-objective question into one number.
 *
 * The Pareto front matters more than any single ranking. "Cheapest" and
 * "lightest" and "longest-lived" are different designs, and a scalar score
 * hides the trade rather than showing it.
 */

import { designDatacenter, launchCampaign } from './datacenter.js';
import { compare, LAUNCH_COSTS } from './economics.js';
import { simulateAscent } from './ascent.js';
import { VEHICLES, LAUNCH_SITES } from './vehicles.js';
import { DEG } from './constants.js';

/**
 * Cartesian product of named axes.
 *
 * @param {Record<string, any[]>} axes
 * @param {number} [cap] hard limit on generated combinations
 * @returns {Array<Record<string, any>>}
 */
export function cartesian(axes, cap = 200000) {
  const keys = Object.keys(axes);
  if (keys.length === 0) return [{}];

  const total = keys.reduce((n, k) => n * axes[k].length, 1);
  if (total > cap) {
    throw new RangeError(
      `Parameter matrix has ${total.toLocaleString()} combinations, above the cap of ` +
      `${cap.toLocaleString()}. Reduce an axis or raise the cap deliberately.`,
    );
  }

  let rows = [{}];
  for (const k of keys) {
    const next = [];
    for (const row of rows) for (const v of axes[k]) next.push({ ...row, [k]: v });
    rows = next;
  }
  return rows;
}

/** Number of combinations an axis set would produce, without building them. */
export const matrixSize = (axes) =>
  Object.values(axes).reduce((n, v) => n * v.length, 1);

// ---------------------------------------------------------------------------
// Datacenter design sweeps
// ---------------------------------------------------------------------------

/**
 * Evaluate a matrix of orbital datacenter designs.
 *
 * Every axis name is a `designDatacenter` parameter, so the sweep spec reads
 * exactly like the single-case call it generalises.
 *
 * @param {object} spec
 * @param {Record<string, any[]>} spec.axes
 * @param {object} [spec.base]              parameters held fixed
 * @param {string} [spec.launchVehicle]     key into LAUNCH_COSTS for the costing
 * @param {(row:object)=>boolean} [spec.filter]
 */
export function exploreDesigns(spec) {
  const { axes, base = {}, launchVehicle = 'starshipEarly', filter, cap } = spec;
  const combos = cartesian(axes, cap);
  const rows = [];

  for (const combo of combos) {
    const cfg = { ...base, ...combo };
    let design;
    let cost;
    try {
      design = designDatacenter(cfg);
      cost = compare(design, { launchVehicle });
    } catch (err) {
      rows.push({ ...combo, error: err.message, viable: false });
      continue;
    }

    const row = {
      ...combo,
      viable: design.viable,
      fatalIssues: design.issues.filter((i) => i.severity === 'fatal').length,
      warnings: design.issues.filter((i) => i.severity === 'warning').length,
      blockedBy: design.issues.find((i) => i.severity === 'fatal')?.subsystem ?? '',

      totalMassT: design.mass.total / 1000,
      radiatorArea: design.thermal.area,
      arrayArea: design.power.array.area,
      radiatorMassT: design.mass.radiator / 1000,
      batteryMassT: design.mass.battery / 1000,

      totalPowerMW: design.power.totalPower / 1e6,
      eclipseFraction: design.orbit.eclipseFraction,
      decayYears: design.orbit.decayYears,
      stationKeepingDvPerYear: design.orbit.stationKeepingDvPerYear,

      kradPerYear: design.radiation.kradPerYear,
      radiationLifeYears: design.radiation.lifetimeYears,
      seuPerDay: design.radiation.seu.rawUpsetsPerDay,

      downlinkGbps: design.comms.downlink.averageRateBps / 1e9,
      linkMarginDb: design.comms.link.linkMarginDb,

      petaflops: design.compute.petaflops,
      petaflopsPerTonne: design.compute.petaflopsPerTonne,

      launches: cost.orbital.launchesNeeded,
      costUsd: cost.orbital.total,
      costPerPflopYear: cost.orbital.perPetaflopYear,
      terrestrialUsd: cost.terrestrial.total,
      costRatio: cost.ratio,
      breakevenLaunchUsdPerKg: cost.breakevenLaunchPricePerKg,

      _design: design,
      _cost: cost,
    };

    if (!filter || filter(row)) rows.push(row);
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Launch sweeps
// ---------------------------------------------------------------------------

/**
 * Evaluate a matrix of launches.
 *
 * `vehicle` and `site` axes accept database KEYS (strings), which keeps sweep
 * specs terse and serialisable.
 */
export function exploreLaunches(spec) {
  const { axes, base = {}, filter, cap } = spec;
  const combos = cartesian(axes, cap);
  const rows = [];

  for (const combo of combos) {
    const cfg = { ...base, ...combo };
    const vehicle = typeof cfg.vehicle === 'string' ? VEHICLES[cfg.vehicle] : cfg.vehicle;
    const site = typeof cfg.site === 'string' ? LAUNCH_SITES[cfg.site] : cfg.site;
    if (!vehicle || !site) continue;

    let res;
    try {
      res = simulateAscent({ ...cfg, vehicle, site, sampleInterval: cfg.sampleInterval ?? 5 });
    } catch (err) {
      rows.push({ ...combo, error: err.message, success: false });
      continue;
    }

    const d = res.summary.deltaV;
    const row = {
      ...combo,
      success: res.success,
      status: res.status,
      stableOrbit: res.stableOrbit,
      onTarget: res.onTarget,

      achievedAltitudeKm: res.achievedAltitude / 1000,
      altitudeErrorPct: res.altitudeError * 100,
      perigeeKm: res.summary.perigeeAltitude / 1000,
      apogeeKm: res.summary.apoapsisAltitude / 1000,
      eccentricity: res.summary.eccentricity,
      inclinationDeg: res.summary.inclinationDeg,
      azimuthDeg: res.azimuthDeg,
      azimuthInCorridor: res.azimuthInCorridor,

      liftoffTW: res.liftoffTW,
      maxQkPa: res.summary.maxDynamicPressure / 1000,
      maxQAltKm: res.summary.maxQAltitude / 1000,
      maxG: res.summary.maxAxialG,
      maxMach: res.summary.maxMach,
      maxQAlpha: res.summary.maxQAlpha,
      flyable: res.summary.structurallyFlyable,

      dvIdeal: d.ideal,
      dvGravityLoss: d.gravityLoss,
      dvDragLoss: d.dragLoss,
      dvSteeringLoss: d.steeringLoss,
      dvRotationBonus: d.rotationBonus,
      flightTimeS: res.summary.flightTime,

      _result: res,
    };

    if (!filter || filter(row)) rows.push(row);
  }

  return rows;
}

/**
 * Maximum payload a vehicle can deliver to an orbit, by bisection on the full
 * integrated trajectory.
 *
 * Slower than a rocket-equation estimate and more honest: gravity and drag
 * losses scale with the vehicle's changing thrust-to-weight, so a closed-form
 * shortcut mis-ranks vehicles against each other.
 */
export function maxPayload(cfg, opts = {}) {
  const { tolerance = 100, maxIterations = 18 } = opts;
  const vehicle = typeof cfg.vehicle === 'string' ? VEHICLES[cfg.vehicle] : cfg.vehicle;
  const site = typeof cfg.site === 'string' ? LAUNCH_SITES[cfg.site] : cfg.site;

  const fly = (m) =>
    simulateAscent({ ...cfg, vehicle, site, payloadMass: m, sampleInterval: 8 });

  if (!fly(10).success) return { payload: 0, feasible: false, iterations: 1 };

  let lo = 10;
  let hi = vehicle.payloadLeoExpendable * 1.8 + 1000;
  let iterations = 0;
  let best = null;

  while (hi - lo > tolerance && iterations < maxIterations) {
    const mid = (lo + hi) / 2;
    const res = fly(mid);
    iterations++;
    if (res.success) { lo = mid; best = res; } else { hi = mid; }
  }

  return { payload: lo, feasible: true, iterations, result: best };
}

// ---------------------------------------------------------------------------
// Ranking and trade-off analysis
// ---------------------------------------------------------------------------

/**
 * Sort rows by an objective.
 * @param {string} key
 * @param {'min'|'max'} direction
 */
export function rank(rows, key, direction = 'min') {
  const sign = direction === 'min' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    const aBad = !Number.isFinite(av);
    const bBad = !Number.isFinite(bv);
    if (aBad && bBad) return 0;
    if (aBad) return 1;   // non-finite always sorts last
    if (bBad) return -1;
    return sign * (av - bv);
  });
}

/**
 * Pareto-optimal subset: rows that no other row beats on every objective.
 *
 * This is the honest answer to "what works". Collapsing mass, cost, lifetime
 * and radiation into a single weighted score buries the actual decision inside
 * whatever weights were picked; the front shows the real menu instead.
 *
 * @param {object[]} rows
 * @param {Array<[string, 'min'|'max']>} objectives
 */
export function paretoFront(rows, objectives) {
  const usable = rows.filter((r) =>
    objectives.every(([k]) => Number.isFinite(r[k])));

  const dominates = (a, b) => {
    let strictlyBetter = false;
    for (const [k, dir] of objectives) {
      const av = a[k];
      const bv = b[k];
      const aBetter = dir === 'min' ? av < bv : av > bv;
      const aWorse = dir === 'min' ? av > bv : av < bv;
      if (aWorse) return false;
      if (aBetter) strictlyBetter = true;
    }
    return strictlyBetter;
  };

  return usable.filter((r) => !usable.some((o) => o !== r && dominates(o, r)));
}

/**
 * Group rows and summarise a metric within each group.
 * Useful for questions like "which launch site gives the best success rate".
 */
export function groupBy(rows, key, metric) {
  const groups = new Map();
  for (const r of rows) {
    const g = String(r[key]);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }

  return [...groups].map(([value, members]) => {
    const vals = members.map((m) => m[metric]).filter(Number.isFinite);
    const viable = members.filter((m) => m.viable ?? m.success).length;
    vals.sort((a, b) => a - b);
    return {
      value,
      count: members.length,
      viableCount: viable,
      viableFraction: members.length ? viable / members.length : 0,
      min: vals[0],
      median: vals.length ? vals[Math.floor(vals.length / 2)] : NaN,
      max: vals[vals.length - 1],
      mean: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN,
    };
  }).sort((a, b) => b.viableFraction - a.viableFraction);
}

/**
 * Sensitivity of a metric to each axis, measured as the spread of the metric
 * when that axis varies and everything else is held fixed.
 *
 * Answers "which knob actually matters", which is usually the first thing
 * worth knowing about a parameter space and rarely the thing people guess.
 */
export function sensitivity(rows, axes, metric) {
  const out = [];
  for (const axis of Object.keys(axes)) {
    const others = Object.keys(axes).filter((k) => k !== axis);
    const buckets = new Map();
    for (const r of rows) {
      const key = others.map((k) => String(r[k])).join('|');
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(r);
    }

    const spreads = [];
    for (const members of buckets.values()) {
      const vals = members.map((m) => m[metric]).filter(Number.isFinite);
      if (vals.length < 2) continue;
      const lo = Math.min(...vals);
      const hi = Math.max(...vals);
      if (lo > 0) spreads.push(hi / lo);
      else if (hi !== lo) spreads.push(Infinity);
    }

    spreads.sort((a, b) => a - b);
    out.push({
      axis,
      levels: axes[axis].length,
      medianFoldChange: spreads.length ? spreads[Math.floor(spreads.length / 2)] : 1,
      maxFoldChange: spreads.length ? spreads[spreads.length - 1] : 1,
    });
  }
  return out.sort((a, b) => b.medianFoldChange - a.medianFoldChange);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Rows to CSV. Underscore-prefixed keys (raw objects) are omitted. */
export function toCsv(rows) {
  if (!rows.length) return '';
  const keys = Object.keys(rows[0]).filter((k) => !k.startsWith('_'));
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    keys.join(','),
    ...rows.map((r) => keys.map((k) => esc(r[k])).join(',')),
  ].join('\n');
}

/** Rows to plain JSON, stripping the attached raw simulation objects. */
export function toJson(rows, pretty = true) {
  const clean = rows.map((r) => {
    const o = {};
    for (const [k, v] of Object.entries(r)) if (!k.startsWith('_')) o[k] = v;
    return o;
  });
  return JSON.stringify(clean, null, pretty ? 2 : 0);
}

// ---------------------------------------------------------------------------
// Ready-made studies
// ---------------------------------------------------------------------------

/**
 * A set of pre-built sweeps covering the questions this simulator exists to
 * answer. Each returns `{ axes, base, ... }` ready to hand to the explorers.
 */
export const STUDIES = {
  orbitBand: {
    name: 'Where can an orbital datacenter actually live?',
    kind: 'design',
    spec: () => ({
      axes: {
        altitude: [300e3, 400e3, 500e3, 600e3, 700e3, 800e3, 1000e3, 1500e3,
          2000e3, 3000e3, 5000e3, 8000e3, 12000e3, 20200e3, 35786e3],
        inclination: [0, 28.5, 51.6, 97.6],
      },
      base: { itPower: 10e6, missionYears: 10, betaAngle: 60 * DEG },
    }),
    objectives: [['totalMassT', 'min'], ['decayYears', 'max']],
  },

  powerScaling: {
    name: 'How does the design scale with compute load?',
    kind: 'design',
    spec: () => ({
      axes: {
        itPower: [1e5, 3e5, 1e6, 3e6, 1e7, 3e7, 1e8, 3e8, 1e9],
        betaAngle: [0, 45 * DEG, 90 * DEG],
      },
      base: { altitude: 700e3, inclination: 97.9, missionYears: 10 },
    }),
    objectives: [['costPerPflopYear', 'min'], ['totalMassT', 'min']],
  },

  thermalTrade: {
    name: 'What does running the silicon hotter buy?',
    kind: 'design',
    spec: () => ({
      axes: {
        junctionTemp: [330, 345, 358.15, 375, 390, 400],
        computeProfile: ['denseAccelerator', 'generalCompute', 'storageHeavy'],
      },
      base: { itPower: 10e6, altitude: 700e3, inclination: 97.9, betaAngle: 60 * DEG },
    }),
    objectives: [['radiatorArea', 'min'], ['totalMassT', 'min']],
  },

  shieldingTrade: {
    name: 'How much shielding is worth carrying?',
    kind: 'design',
    spec: () => ({
      axes: {
        shieldingMm: [1, 2.54, 5, 10, 20, 40],
        altitude: [500e3, 800e3, 2000e3, 35786e3],
        electronicsClass: ['commercialCots', 'upscreenedCots', 'radTolerant'],
      },
      base: { itPower: 10e6, inclination: 45, missionYears: 10, betaAngle: 60 * DEG },
    }),
    objectives: [['totalMassT', 'min'], ['radiationLifeYears', 'max']],
  },

  fleetComparison: {
    name: 'Which launcher and pad for a given orbit?',
    kind: 'launch',
    spec: () => ({
      axes: {
        vehicle: Object.keys(VEHICLES),
        site: ['ksc', 'vandenberg', 'kourou', 'baikonur', 'mahia'],
        targetAltitude: [400e3, 800e3],
      },
      base: { targetInclination: 51.6, payloadMass: 8000 },
    }),
    objectives: [['dvIdeal', 'min']],
  },

  inclinationCost: {
    name: 'What does inclination cost from each pad?',
    kind: 'launch',
    spec: () => ({
      axes: {
        site: Object.keys(LAUNCH_SITES),
        targetInclination: [0, 28.5, 45, 51.6, 70, 90, 97.6, 120],
      },
      base: { vehicle: 'falcon9', payloadMass: 10000, targetAltitude: 500e3 },
    }),
    objectives: [['dvIdeal', 'min']],
  },
};
