#!/usr/bin/env node
/**
 * Mission campaign runner.
 *
 *   node tools/mission.mjs                     # run the built-in scenarios
 *   node tools/mission.mjs --json out.json     # dump structured results
 *   node tools/mission.mjs --only sso          # run one scenario
 *
 * Scenarios live in SCENARIOS below. Each is a plain object handed straight to
 * `simulateMission`, which is pure and independent -- so scaling this from two
 * scenarios to several hundred fanned out across agents needs no change to the
 * model, only a longer list.
 */

import { writeFileSync } from 'node:fs';
import { simulateMission } from '../src/sim/mission.js';
import { DEG } from '../src/sim/constants.js';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

export const SCENARIOS = {
  sso: {
    name: 'Dawn–dusk sun-synchronous',
    subtitle: '10 MW · 700 km · 98.2° · Starship from Vandenberg',
    rationale:
      'The architecture the physics actually favours. A dawn–dusk sun-synchronous ' +
      'orbit is sunlit continuously for most of the year, which deletes the battery ' +
      'mass entirely, and 700 km is above the drag regime but below the inner belt.',
    itPower: 10e6,
    altitude: 700e3,
    inclination: 98.2,
    missionYears: 12,
    vehicleId: 'starship',
    siteId: 'vandenberg',
    costVehicle: 'starshipEarly',
    design: {
      betaAngle: 88 * DEG,
      shieldingMm: 8,
      electronicsClass: 'radTolerant',
      solarTech: 'rosaFlexible',
      groundStations: 12,
    },
  },

  overheat: {
    name: 'Thermal runaway',
    subtitle: '10 MW · 700 km · radiator sized at beginning-of-life',
    rationale:
      'Identical to the nominal SSO except for two decisions: the radiator is sized ' +
      'at beginning-of-life absorptivity instead of end-of-life, and the panels sit ' +
      '45° off edge-on rather than 78°. Z93 white paint darkens from alpha 0.17 to ' +
      '0.30 over the mission, and a radiator with no margin for that cannot shed the ' +
      'heat its own computers produce.',
    itPower: 10e6, altitude: 700e3, inclination: 98.2, missionYears: 12,
    vehicleId: 'starship', siteId: 'vandenberg', costVehicle: 'starshipEarly',
    design: {
      betaAngle: 88 * DEG, shieldingMm: 8, electronicsClass: 'radTolerant',
      sizeForEndOfLife: false, radiatorSunIncidenceDeg: 45, radiatorTiltFromNadirDeg: 45,
    },
  },

  reentry: {
    name: 'Uncontrolled reentry',
    subtitle: '10 MW · 400 km · 51.6° · below the drag line',
    rationale:
      'A 400 km orbit looks attractive — cheap to reach, short light-delay, benign ' +
      'radiation. But 40,000 m² of array and radiator at that altitude is an enormous ' +
      'sail. The station holds altitude only as long as it can keep thrusting, and ' +
      'when the tanks run dry the orbit decays into the atmosphere.',
    itPower: 10e6, altitude: 400e3, inclination: 51.6, missionYears: 12,
    vehicleId: 'starship', siteId: 'ksc', costVehicle: 'starshipEarly',
    design: { betaAngle: 0, shieldingMm: 8, electronicsClass: 'radTolerant' },
  },

  belt: {
    name: 'Radiation kill',
    subtitle: '10 MW · 2 500 km · inside the inner proton belt',
    rationale:
      'The altitude between roughly 1 000 and 10 000 km is the inner Van Allen belt. ' +
      'Dose there runs two orders of magnitude above LEO, and no realistic shielding ' +
      'mass closes the gap. Upscreened commercial parts reach their total-dose limit ' +
      'in under a year.',
    itPower: 10e6, altitude: 2500e3, inclination: 20, missionYears: 12,
    vehicleId: 'starship', siteId: 'ksc', costVehicle: 'starshipEarly',
    design: { betaAngle: 60 * DEG, shieldingMm: 8, electronicsClass: 'upscreenedCots' },
  },

  leo: {
    name: 'Mid-inclination LEO',
    subtitle: '10 MW · 550 km · 51.6° · Falcon Heavy from Kennedy',
    rationale:
      'The intuitive choice, and a much worse one. A 51.6° orbit at 550 km is ' +
      'eclipsed for 35% of every 96-minute lap, so it has to carry batteries for ' +
      'the dark half — and the drag at that altitude is a permanent tax.',
    itPower: 10e6,
    altitude: 550e3,
    inclination: 51.6,
    missionYears: 12,
    vehicleId: 'falconHeavy',
    siteId: 'ksc',
    costVehicle: 'falconHeavy',
    design: {
      betaAngle: 0,
      shieldingMm: 8,
      electronicsClass: 'radTolerant',
      solarTech: 'rosaFlexible',
      groundStations: 12,
    },
  },
};

// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const only = flag('only');
const chosen = only ? { [only]: SCENARIOS[only] } : SCENARIOS;
if (only && !SCENARIOS[only]) {
  console.error(`Unknown scenario "${only}". Available: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(1);
}

const fmtMass = (kg) => kg >= 1e6 ? (kg / 1e6).toFixed(2) + ' kt'
  : kg >= 1000 ? (kg / 1000).toFixed(1) + ' t' : kg.toFixed(0) + ' kg';
const fmtMoney = (v) => Math.abs(v) >= 1e9 ? '$' + (v / 1e9).toFixed(2) + 'B'
  : Math.abs(v) >= 1e6 ? '$' + (v / 1e6).toFixed(0) + 'M' : '$' + v.toFixed(0);
const fmtArea = (m2) => m2 >= 1e6 ? (m2 / 1e6).toFixed(2) + ' km²'
  : Math.round(m2).toLocaleString() + ' m²';

const results = {};

for (const [key, scenario] of Object.entries(chosen)) {
  const m = simulateMission(scenario);
  results[key] = m;

  const d = m.design;
  const p = m.projection;

  console.log(`\n${C.bold('═'.repeat(74))}`);
  console.log(`${C.bold(m.name)}   ${C.dim(scenario.subtitle)}`);
  console.log(C.bold('═'.repeat(74)));
  console.log(C.dim(scenario.rationale.replace(/(.{72}\s)/g, '$1\n')));

  console.log(`\n${C.cyan('▸ VERDICT')}  ${m.feasible ? C.green('MISSION CLOSES') : C.red('DOES NOT CLOSE')}`);
  for (const b of m.blockers) console.log(`  ${C.red('✗')} ${b}`);

  console.log(`\n${C.cyan('▸ SPACECRAFT')}`);
  console.log(`  Launch mass          ${fmtMass(d.mass.total)}`);
  for (const [label, mass] of d.mass.breakdown) {
    const pct = (mass / d.mass.total) * 100;
    const bar = '█'.repeat(Math.round(pct / 3));
    console.log(`    ${label.padEnd(24)} ${fmtMass(mass).padStart(9)}  ${C.dim(bar)} ${pct.toFixed(0)}%`);
  }
  console.log(`  Radiator             ${fmtArea(d.thermal.area)}  (${Math.sqrt(d.thermal.area).toFixed(0)} m square)`);
  console.log(`  Solar array          ${fmtArea(d.power.array.area)}  (${Math.sqrt(d.power.array.area).toFixed(0)} m square)`);
  console.log(`  Eclipse per orbit    ${(d.orbit.eclipseFraction * 100).toFixed(1)}%`);
  console.log(`  Compute              ${d.compute.petaflops.toFixed(0)} PFLOPS across ${Math.round(d.compute.rackCount)} racks`);

  console.log(`\n${C.cyan('▸ DEPLOYMENT')}`);
  console.log(`  Vehicle              ${m.deployment.vehicle.name} from ${m.deployment.site.name.split(',')[0]}`);
  console.log(`  Delivered per flight ${fmtMass(m.deployment.deliverablePerFlight)}  ${C.dim('(flown to this orbit, not the quoted figure)')}`);
  console.log(`  Flights              ${m.deployment.flightsNeeded}  ${C.dim(`(${m.deployment.expectedAttempts.toFixed(1)} attempts at ${(100 * 0.97).toFixed(0)}% reliability)`)}`);
  console.log(`  Full capability      ${m.deployment.deploymentYears.toFixed(2)} years after first launch`);

  console.log(`\n${C.cyan('▸ OPERATIONS')}`);
  console.log(`  Mission ends         ${p.endYears.toFixed(1)} yr — ${C.yellow(p.endReason)}`);
  console.log(`  Delivered compute    ${Math.round(p.totalPflopYears).toLocaleString()} PFLOP-years`);
  console.log(`  Realised fraction    ${(m.programme.realisedFraction * 100).toFixed(1)}%  ${C.dim('of nameplate × mission duration')}`);
  const last = p.rows[p.rows.length - 1];
  console.log(`  End-of-life output   ${(last.effective * 100).toFixed(0)}% of day-one`);
  console.log(`    array ${(last.arrayFactor * 100).toFixed(0)}%   battery ${(last.batteryFactor * 100).toFixed(0)}%   dose ${(last.doseFactor * 100).toFixed(0)}%`);

  console.log(`\n${C.cyan('▸ DISPOSAL')}`);
  console.log(`  Natural decay        ${m.disposal.naturalDecayYears > 400 ? '>400' : m.disposal.naturalDecayYears.toFixed(1)} yr  ${m.disposal.compliantNaturally ? C.green('(compliant)') : C.yellow('(must be flown down)')}`);
  console.log(`  Deorbit ΔV           ${m.disposal.deorbitDeltaV.toFixed(0)} m/s → ${fmtMass(m.disposal.disposalPropellantKg)} of propellant`);
  console.log(`  Mass penalty         ${(m.disposal.massPenaltyFraction * 100).toFixed(1)}% of the vehicle`);

  console.log(`\n${C.cyan('▸ PROGRAMME')}`);
  console.log(`  Launch cost          ${fmtMoney(m.programme.launchCost)}`);
  console.log(`  Total cost           ${fmtMoney(m.programme.totalCost)}`);
  console.log(`  Cost per PFLOP-year  ${fmtMoney(m.programme.costPerPflopYear)}`);
  console.log(`  Terrestrial equiv.   ${fmtMoney(m.programme.terrestrialPerPflopYear)}`);
  const adv = m.programme.costAdvantage;
  console.log(`  Verdict              ${adv >= 1 ? C.green(`${adv.toFixed(2)}× cheaper in orbit`) : C.red(`${(1 / adv).toFixed(2)}× more expensive in orbit`)}`);

  console.log(`\n  ${C.dim('yr   online  array  batt  dose   net   PFLOPS   alt km   prop%')}`);
  for (const r of p.rows.filter((_, i) => i % 12 === 0)) {
    console.log(`  ${r.years.toFixed(0).padStart(3)} ${(r.capability * 100).toFixed(0).padStart(6)}% ${(r.arrayFactor * 100).toFixed(0).padStart(6)}% ${(r.batteryFactor * 100).toFixed(0).padStart(4)}% ${(r.doseFactor * 100).toFixed(0).padStart(4)}% ${(r.effective * 100).toFixed(0).padStart(5)}% ${Math.round(r.petaflops).toString().padStart(8)} ${r.altitudeKm.toFixed(0).padStart(8)} ${(r.propellantFraction * 100).toFixed(0).padStart(7)}`);
  }
  console.log(C.dim(`\n  simulated in ${m.runtimeMs} ms`));
}

if (flag('json')) {
  // Strip the heavy trajectory samples; keep everything a report needs.
  const slim = Object.fromEntries(Object.entries(results).map(([k, m]) => [k, {
    name: m.name, subtitle: SCENARIOS[k].subtitle, rationale: SCENARIOS[k].rationale,
    config: { ...m.config, design: undefined },
    feasible: m.feasible, blockers: m.blockers,
    mass: m.design.mass, thermal: {
      area: m.design.thermal.area, radiatorTemp: m.design.thermal.radiatorTemp,
      netPerArea: m.design.thermal.netPerArea, heatLoad: m.design.thermal.heatLoad,
    },
    power: {
      itPower: m.design.power.itPower, totalPower: m.design.power.totalPower,
      arrayArea: m.design.power.array.area, batteryMass: m.design.mass.battery,
      eclipseFraction: m.design.orbit.eclipseFraction,
    },
    orbit: m.design.orbit,
    radiation: {
      kradPerYear: m.design.radiation.kradPerYear, band: m.design.radiation.band,
      lifetimeYears: m.design.radiation.lifetimeYears,
    },
    compute: m.design.compute,
    deployment: {
      vehicle: m.deployment.vehicle?.name, site: m.deployment.site?.name,
      deliverablePerFlight: m.deployment.deliverablePerFlight,
      flightsNeeded: m.deployment.flightsNeeded,
      expectedAttempts: m.deployment.expectedAttempts,
      deploymentYears: m.deployment.deploymentYears,
      manifest: m.deployment.manifest,
    },
    ascent: m.deployment.reference ? {
      maxQ: m.deployment.reference.summary.maxDynamicPressure,
      maxQAltitude: m.deployment.reference.summary.maxQAltitude,
      maxG: m.deployment.reference.summary.maxAxialG,
      deltaV: m.deployment.reference.summary.deltaV,
      flightTime: m.deployment.reference.summary.flightTime,
      events: m.deployment.reference.events,
      samples: m.deployment.reference.samples
        .filter((_, i) => i % 4 === 0)
        .map((s) => ({
          t: s.t, altitude: s.altitude, speed: s.speed, q: s.dynamicPressure,
          mass: s.mass, gamma: s.flightPathAngle, burning: s.burning,
        })),
    } : null,
    projection: m.projection.rows.map((r) => ({
      years: r.years, capability: r.capability, arrayFactor: r.arrayFactor,
      batteryFactor: r.batteryFactor, doseFactor: r.doseFactor,
      effective: r.effective, petaflops: r.petaflops,
      cumulativePflopYears: r.cumulativePflopYears,
      altitudeKm: r.altitudeKm, propellantFraction: r.propellantFraction,
      doseFraction: r.doseFraction,
    })),
    projectionSummary: {
      endReason: m.projection.endReason, endYears: m.projection.endYears,
      totalPflopYears: m.projection.totalPflopYears,
    },
    disposal: m.disposal,
    programme: m.programme,
    economics: {
      orbital: m.economics.orbital, terrestrial: m.economics.terrestrial,
      breakevenLaunchPricePerKg: m.economics.breakevenLaunchPricePerKg,
    },
  }]));

  writeFileSync(flag('json'), JSON.stringify(slim, null, 2));
  console.log(C.green(`\n✓ wrote ${flag('json')}`));
}

console.log('');
