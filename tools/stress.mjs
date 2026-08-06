/**
 * Stress harness.
 *
 * Sweeps the whole reachable parameter space and asserts invariants that must
 * hold for ANY input, not just the nominal ones. This is deliberately separate
 * from the unit tests: those check that specific cases match published values,
 * this checks that nothing anywhere produces NaN, contradicts itself, or
 * violates conservation.
 *
 *   node tools/stress.mjs            # full sweep
 *   node tools/stress.mjs --quick    # smaller matrix
 */

import { VEHICLES, LAUNCH_SITES, idealDeltaV, grossMass, nozzleExitArea, launchAzimuth, liftoffThrust, boosterMass } from '../src/sim/vehicles.js';
import { simulateAscent } from '../src/sim/ascent.js';
import { designDatacenter } from '../src/sim/datacenter.js';
import { compare } from '../src/sim/economics.js';
import { SOLAR_TECH, BATTERY_TECH } from '../src/sim/power.js';
import { COMPUTE_PROFILES } from '../src/sim/datacenter.js';
import { DOSE_TOLERANCE } from '../src/sim/radiation.js';
import { BANDS } from '../src/sim/comms.js';
import { atmosphere } from '../src/sim/atmosphere.js';
import { rvToElements, elementsToRv, orbitalLifetime, sunlitFraction } from '../src/sim/orbit.js';
import { R_EARTH_EQ, DEG, AU } from '../src/sim/constants.js';
import * as V from '../src/sim/vec3.js';

const quick = process.argv.includes('--quick');

let checks = 0;
const failures = [];

function check(cond, label, detail) {
  checks++;
  if (!cond) failures.push({ label, detail });
}

/** Every numeric leaf of an object must be finite. Catches NaN propagation. */
function allFinite(obj, path = '', seen = new Set()) {
  const bad = [];
  const walk = (o, p) => {
    if (o === null || o === undefined) return;
    if (typeof o === 'number') {
      // Infinity is a legitimate sentinel in several places (infeasible
      // radiator area, non-decaying orbit); NaN never is.
      if (Number.isNaN(o)) bad.push(p);
      return;
    }
    if (typeof o !== 'object') return;
    if (seen.has(o)) return;
    seen.add(o);
    if (Array.isArray(o)) o.forEach((v, i) => walk(v, `${p}[${i}]`));
    else for (const [k, v] of Object.entries(o)) walk(v, p ? `${p}.${k}` : k);
  };
  walk(obj, path);
  return bad;
}

const relErr = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);

// ===========================================================================
console.log('── atmosphere ──────────────────────────────────────────────');
// ===========================================================================
{
  for (let z = -2000; z <= 2_000_000; z += quick ? 5000 : 500) {
    for (const f107 of [65, 150, 250]) {
      const a = atmosphere(z, { f107, ap: 15 });
      check(Number.isFinite(a.density) && a.density >= 0,
        'atmosphere density finite and non-negative', `z=${z} f107=${f107} -> ${a.density}`);
    }
  }
  // Density must decrease monotonically with altitude everywhere. A
  // non-monotonic patch would mean a bad model junction and would make drag
  // and decay behave bizarrely.
  let prev = Infinity;
  for (let z = 0; z <= 1_000_000; z += 250) {
    const d = atmosphere(z).density;
    check(d <= prev * 1.0000001, 'density monotonically decreasing', `z=${z}: ${d} > ${prev}`);
    prev = d;
  }
}

// ===========================================================================
console.log('── vehicles ────────────────────────────────────────────────');
// ===========================================================================
for (const v of Object.values(VEHICLES)) {
  for (const [i, s] of v.stages.entries()) {
    check(s.thrustVacuum >= s.thrustSeaLevel,
      'vacuum thrust >= sea level thrust', `${v.id} stage ${i}`);
    check(s.ispVacuum >= s.ispSeaLevel,
      'vacuum Isp >= sea level Isp', `${v.id} stage ${i}`);
    check(s.dryMass > 0 && s.propellantMass > 0,
      'positive stage masses', `${v.id} stage ${i}`);
    check(Number.isFinite(nozzleExitArea(s)) && nozzleExitArea(s) >= 0,
      'nozzle exit area sane', `${v.id} stage ${i}`);
    // Mass ratio sanity: a stage with a structural fraction above ~25% could
    // not close any real design, and below ~2% is not buildable.
    const sf = s.dryMass / (s.dryMass + s.propellantMass);
    check(sf > 0.01 && sf < 0.30,
      'stage structural fraction plausible', `${v.id} stage ${i}: ${(sf * 100).toFixed(1)}%`);
  }

  const dv = idealDeltaV(v, v.payloadLeoExpendable);
  check(dv > 8000 && dv < 14000,
    'ideal dV in a plausible band at rated payload', `${v.id}: ${dv.toFixed(0)} m/s`);

  // Liftoff thrust must include strap-on boosters. Measured on the core alone
  // Ariane 6 comes out at 0.12 -- its Vulcain genuinely cannot lift the stack,
  // which is the entire reason the P120C solids are bolted to the side.
  const tw = liftoffThrust(v.stages[0]) / (grossMass(v, v.payloadLeoExpendable) * 9.80665);
  check(tw > 1.05 && tw < 2.2,
    'liftoff T/W above 1 and below 2.2', `${v.id}: ${tw.toFixed(2)}`);

  // A core that cannot lift itself must be carrying boosters.
  const coreTw = v.stages[0].thrustSeaLevel / (grossMass(v, v.payloadLeoExpendable) * 9.80665);
  check(coreTw > 1.05 || !!v.stages[0].boosters,
    'a core with T/W below 1 has strap-on boosters', `${v.id}: core T/W ${coreTw.toFixed(2)}`);
}

// ===========================================================================
console.log('── launch azimuth ──────────────────────────────────────────');
// ===========================================================================
for (const site of Object.values(LAUNCH_SITES)) {
  for (let inc = 0; inc <= 180; inc += 2.5) {
    const az = launchAzimuth(site.latitude, inc);
    const reachable = Math.abs(inc) >= Math.abs(site.latitude) - 1e-9 &&
      Math.abs(inc) <= 180 - Math.abs(site.latitude) + 1e-9;
    if (reachable) {
      check(az !== null, 'azimuth exists when inclination >= latitude',
        `${site.id} inc=${inc}`);
      if (az) {
        // The azimuth must reproduce the requested inclination.
        const back = Math.acos(Math.cos(site.latitude * DEG) * Math.sin(az.azimuthDeg * DEG)) / DEG;
        check(relErr(back, inc) < 1e-6 || Math.abs(back - inc) < 1e-6,
          'azimuth inverts back to the requested inclination',
          `${site.id} inc=${inc} -> az=${az.azimuthDeg.toFixed(3)} -> ${back.toFixed(3)}`);
      }
    } else {
      check(az === null, 'no azimuth when inclination < latitude', `${site.id} inc=${inc}`);
    }
  }
}

// ===========================================================================
console.log('── orbital elements round trip ─────────────────────────────');
// ===========================================================================
{
  const As = [6600e3, 7000e3, 12000e3, 26600e3, 42164e3];
  const Es = [0, 1e-9, 0.001, 0.05, 0.3, 0.72, 0.95];
  const Is = [0, 1e-9, 0.001, 28.5, 51.6, 90, 97.6, 145, 180 - 1e-9];
  for (const a of As) {
    for (const e of Es) {
      for (const iDeg of Is) {
        if (a * (1 - e) < R_EARTH_EQ * 0.5) continue;
        const el = { a, e, i: iDeg * DEG, raan: 1.1, argp: 2.2, nu: 0.7, p: a * (1 - e * e) };
        const { r, v } = elementsToRv(el);
        check(allFinite({ r, v }).length === 0, 'elementsToRv finite',
          `a=${a} e=${e} i=${iDeg}`);
        const back = rvToElements(r, v);
        check(allFinite(back).length === 0, 'rvToElements finite',
          `a=${a} e=${e} i=${iDeg} -> ${allFinite(back).join(',')}`);
        check(relErr(back.a, a) < 1e-8, 'semi-major axis round trips',
          `a=${a} e=${e} i=${iDeg}: got ${back.a}`);
        check(Math.abs(back.e - e) < 1e-8, 'eccentricity round trips',
          `a=${a} e=${e} i=${iDeg}: got ${back.e}`);
        check(Math.abs(back.i - iDeg * DEG) < 1e-8, 'inclination round trips',
          `a=${a} e=${e} i=${iDeg}: got ${back.i / DEG}`);
        // Reconstructing position from the recovered elements must land back
        // on the same point, including in the degenerate circular/equatorial
        // cases where raan and argp are individually undefined.
        const { r: r2 } = elementsToRv(back);
        check(V.norm(V.sub(r2, r)) < 1.0, 'position reconstructs from recovered elements',
          `a=${a} e=${e} i=${iDeg}: off by ${V.norm(V.sub(r2, r)).toFixed(3)} m`);
      }
    }
  }
}

// ===========================================================================
console.log('── eclipse ─────────────────────────────────────────────────');
// ===========================================================================
{
  const sun = [AU, 0, 0];
  for (const alt of [200e3, 500e3, 2000e3, 20000e3, 35786e3]) {
    const r = R_EARTH_EQ + alt;
    for (let k = 0; k < 720; k++) {
      const th = (k / 720) * 2 * Math.PI;
      for (const incl of [0, 45 * DEG, 90 * DEG]) {
        const p = [
          r * Math.cos(th),
          r * Math.sin(th) * Math.cos(incl),
          r * Math.sin(th) * Math.sin(incl),
        ];
        const f = sunlitFraction(p, sun);
        check(Number.isFinite(f) && f >= 0 && f <= 1,
          'sunlit fraction in [0,1]', `alt=${alt} th=${th.toFixed(2)} -> ${f}`);
      }
    }
  }
}

// ===========================================================================
console.log('── ascent matrix ───────────────────────────────────────────');
// ===========================================================================
{
  const vehicles = quick ? ['falcon9', 'starship'] : Object.keys(VEHICLES);
  const sites = quick ? ['ksc', 'vandenberg'] : Object.keys(LAUNCH_SITES);
  const altitudes = quick ? [400e3] : [200e3, 400e3, 800e3, 1500e3];

  let runs = 0;
  for (const vid of vehicles) {
    const veh = VEHICLES[vid];
    for (const sid of sites) {
      const site = LAUNCH_SITES[sid];
      for (const alt of altitudes) {
        for (const incFactor of [1.0, 1.6, 3.0]) {
          const inc = Math.min(144, Math.abs(site.latitude) * incFactor);
          for (const frac of [0.05, 0.5, 1.0, 1.6]) {
            const payload = Math.max(10, veh.payloadLeoExpendable * frac);
            let res;
            try {
              res = simulateAscent({
                vehicle: veh, site, payloadMass: payload,
                targetAltitude: alt, targetInclination: inc,
                sampleInterval: 5,
              });
            } catch (err) {
              failures.push({
                label: 'ascent threw',
                detail: `${vid}/${sid} alt=${alt / 1000}km inc=${inc.toFixed(1)} pl=${payload.toFixed(0)}: ${err.message}`,
              });
              checks++;
              continue;
            }
            runs++;

            const nan = allFinite(res.summary);
            check(nan.length === 0, 'ascent summary has no NaN',
              `${vid}/${sid} alt=${alt / 1000} pl=${payload.toFixed(0)}: ${nan.join(', ')}`);

            const d = res.summary.deltaV;
            // Drag and steering losses are non-negative by construction.
            // Gravity loss is NOT: it is the integral of -(g . v_hat), which
            // goes negative whenever the vehicle is descending, because gravity
            // is then adding speed rather than taking it. That is a real
            // signature of a badly lofted trajectory, not an arithmetic error,
            // so it is checked as a trajectory-quality flag on successful
            // flights rather than as an invariant on all of them.
            check(d.ideal >= 0 && d.dragLoss >= -1 && d.steeringLoss >= -1,
              'drag and steering losses non-negative',
              `${vid}/${sid}: d=${d.dragLoss.toFixed(0)} s=${d.steeringLoss.toFixed(0)}`);
            if (res.success) {
              check(d.gravityLoss > 0,
                'successful flights do not gain net energy from gravity',
                `${vid}/${sid}: g=${d.gravityLoss.toFixed(0)}`);
            }

            // The exact loss decomposition identity.
            const predicted = d.rotationBonus + d.ideal - d.gravityLoss - d.dragLoss - d.steeringLoss;
            check(relErr(predicted, d.achieved) < 0.02,
              'delta-v identity closes',
              `${vid}/${sid} alt=${alt / 1000} pl=${payload.toFixed(0)}: predicted ${predicted.toFixed(0)} vs achieved ${d.achieved.toFixed(0)}`);

            // Mass must never increase and never go below the final stage dry mass.
            for (let i = 1; i < res.samples.length; i++) {
              if (res.samples[i].mass > res.samples[i - 1].mass + 1e-6) {
                check(false, 'mass monotonically decreasing',
                  `${vid}/${sid} at t=${res.samples[i].t}`);
                break;
              }
            }
            check(res.samples.every((s) => s.mass > 0), 'mass stays positive', `${vid}/${sid}`);

            // Altitude must never be absurdly negative (a few metres of
            // numerical slop at the pad is fine).
            const minAlt = Math.min(...res.samples.map((s) => s.altitude));
            check(minAlt > -200, 'altitude never far below the ellipsoid',
              `${vid}/${sid}: min ${minAlt.toFixed(1)} m`);

            // A success claim must be internally consistent.
            if (res.success) {
              check(res.summary.perigeeAltitude > 99e3,
                'successful mission has perigee above 100 km',
                `${vid}/${sid} alt=${alt / 1000} pl=${payload.toFixed(0)}: rp=${(res.summary.perigeeAltitude / 1000).toFixed(1)} km`);
              check(res.summary.eccentricity < 0.05,
                'successful mission is near circular',
                `${vid}/${sid}: e=${res.summary.eccentricity.toFixed(4)}`);
              check(Math.abs(res.summary.apoapsisAltitude - alt) < 0.25 * alt,
                'successful mission lands near the requested altitude',
                `${vid}/${sid} wanted ${alt / 1000} km got ${(res.summary.apoapsisAltitude / 1000).toFixed(0)} km`);
              // Inclination should match the request when the site can reach it.
              if (res.reachableInclination) {
                check(Math.abs(res.summary.inclinationDeg - inc) < 3,
                  'achieved inclination matches request',
                  `${vid}/${sid} wanted ${inc.toFixed(1)} got ${res.summary.inclinationDeg.toFixed(1)}`);
              }
            }

            // Monotonic payload: heavier payload must never do BETTER.
            check(res.summary.maxAxialG < 12, 'axial load bounded',
              `${vid}/${sid}: ${res.summary.maxAxialG.toFixed(1)} g`);
          }
        }
      }
    }
  }
  console.log(`   ${runs} ascents flown`);
}

// ===========================================================================
console.log('── payload monotonicity ────────────────────────────────────');
// ===========================================================================
{
  // Adding payload can never increase achievable altitude for the same vehicle.
  // If it does, the guidance or the cutoff logic is unstable.
  for (const vid of quick ? ['falcon9'] : ['falcon9', 'falconHeavy', 'newGlenn']) {
    const veh = VEHICLES[vid];
    let lastSuccess = true;
    for (const frac of [0.2, 0.4, 0.6, 0.8, 1.0, 1.2, 1.5]) {
      const res = simulateAscent({
        vehicle: veh, site: LAUNCH_SITES.ksc,
        payloadMass: veh.payloadLeoExpendable * frac,
        targetAltitude: 400e3, targetInclination: 28.6, sampleInterval: 5,
      });
      if (!res.success) lastSuccess = false;
      else check(lastSuccess, 'success is monotonic in payload',
        `${vid}: succeeded at ${frac} after failing at a lighter payload`);
    }
  }
}

// ===========================================================================
console.log('── datacenter matrix ───────────────────────────────────────');
// ===========================================================================
{
  const powers = quick ? [1e6, 100e6] : [1e4, 1e5, 1e6, 1e7, 1e8, 1e9];
  const alts = quick ? [550e3, 35786e3] : [300e3, 550e3, 800e3, 2000e3, 5000e3, 20200e3, 35786e3];
  const incs = quick ? [0, 97.6] : [0, 28.5, 51.6, 90, 97.6, 144];
  const betas = quick ? [0, 1.4] : [0, 0.5, 1.0, 1.4, Math.PI / 2];

  let runs = 0;
  for (const itPower of powers) {
    for (const altitude of alts) {
      for (const inclination of incs) {
        for (const betaAngle of betas) {
          let d;
          try {
            d = designDatacenter({
              itPower, altitude, inclination, betaAngle, missionYears: 10,
            });
          } catch (err) {
            failures.push({
              label: 'designDatacenter threw',
              detail: `P=${itPower} alt=${altitude / 1000} inc=${inclination} beta=${betaAngle}: ${err.message}`,
            });
            checks++;
            continue;
          }
          runs++;

          const nan = allFinite(d, '', new Set());
          check(nan.length === 0, 'design has no NaN',
            `P=${itPower} alt=${altitude / 1000} inc=${inclination} beta=${betaAngle.toFixed(2)}: ${nan.slice(0, 6).join(', ')}`);

          // Mass budget must close against its own breakdown.
          const sum = d.mass.breakdown.reduce((a, [, v]) => a + v, 0);
          check(relErr(sum, d.mass.total) < 1e-9, 'mass budget closes',
            `P=${itPower} alt=${altitude / 1000}: sum ${sum.toFixed(0)} vs total ${d.mass.total.toFixed(0)}`);

          // Conservation of energy: heat load equals electrical load exactly.
          check(d.thermal.heatLoad === d.power.totalPower,
            'heat load equals electrical load',
            `P=${itPower}: ${d.thermal.heatLoad} vs ${d.power.totalPower}`);

          check(d.power.totalPower > d.power.itPower, 'overhead is positive', `P=${itPower}`);
          check(d.mass.total > 0 && Number.isFinite(d.mass.total),
            'total mass positive and finite',
            `P=${itPower} alt=${altitude / 1000} -> ${d.mass.total}`);
          check(d.orbit.eclipseFraction >= 0 && d.orbit.eclipseFraction <= 1,
            'eclipse fraction in [0,1]', `${d.orbit.eclipseFraction}`);
          check(d.power.array.area > 0, 'array area positive', `P=${itPower}`);
          check(d.radiation.kradPerYear >= 0, 'dose non-negative', `alt=${altitude / 1000}`);

          // Battery mass must be zero exactly when there is no eclipse.
          if (d.orbit.eclipseFraction === 0) {
            check(d.mass.battery === 0, 'no battery without eclipse',
              `alt=${altitude / 1000} beta=${betaAngle.toFixed(2)} -> ${d.mass.battery}`);
          } else {
            check(d.mass.battery > 0, 'battery present when eclipsed',
              `alt=${altitude / 1000} beta=${betaAngle.toFixed(2)}`);
          }

          // Issues must be well-formed.
          for (const i of d.issues) {
            check(['fatal', 'warning'].includes(i.severity), 'issue severity valid', i.severity);
            check(typeof i.message === 'string' && i.message.length > 0,
              'issue has a message', i.subsystem);
          }
          check(d.viable === !d.issues.some((i) => i.severity === 'fatal'),
            'viable flag agrees with fatal issues', `P=${itPower} alt=${altitude / 1000}`);

          // Economics must not blow up.
          const c = compare(d, { launchVehicle: 'starshipEarly' });
          const cn = allFinite(c, '', new Set());
          check(cn.length === 0, 'comparison has no NaN',
            `P=${itPower} alt=${altitude / 1000}: ${cn.slice(0, 5).join(', ')}`);
          check(c.orbital.launchesNeeded >= 1, 'at least one launch',
            `P=${itPower} -> ${c.orbital.launchesNeeded}`);
        }
      }
    }
  }
  console.log(`   ${runs} designs evaluated`);
}

// ===========================================================================
console.log('── subsystem option coverage ───────────────────────────────');
// ===========================================================================
{
  for (const computeProfile of Object.keys(COMPUTE_PROFILES)) {
    for (const solarTech of Object.keys(SOLAR_TECH)) {
      for (const batteryTech of Object.keys(BATTERY_TECH)) {
        for (const electronicsClass of Object.keys(DOSE_TOLERANCE)) {
          for (const band of Object.keys(BANDS)) {
            const d = designDatacenter({
              itPower: 10e6, altitude: 600e3, inclination: 97.8,
              betaAngle: 1.2, missionYears: 10,
              computeProfile, solarTech, batteryTech, electronicsClass, band,
            });
            const nan = allFinite(d, '', new Set());
            check(nan.length === 0, 'all subsystem combinations produce finite results',
              `${computeProfile}/${solarTech}/${batteryTech}/${electronicsClass}/${band}: ${nan.slice(0, 4).join(', ')}`);
          }
        }
      }
    }
  }
}

// ===========================================================================
console.log('── monotonic physical trends ───────────────────────────────');
// ===========================================================================
{
  const base = { itPower: 10e6, altitude: 600e3, inclination: 45, betaAngle: 0.8, missionYears: 10 };

  // More power must mean more radiator, more array, more mass.
  let prevArea = 0; let prevMass = 0;
  for (const p of [1e6, 3e6, 1e7, 3e7, 1e8]) {
    const d = designDatacenter({ ...base, itPower: p });
    check(d.thermal.area > prevArea, 'radiator grows with power', `P=${p}`);
    check(d.mass.total > prevMass, 'mass grows with power', `P=${p}`);
    prevArea = d.thermal.area; prevMass = d.mass.total;
  }

  // Hotter silicon must mean a smaller radiator.
  let prevRad = Infinity;
  for (const T of [320, 340, 360, 380, 400]) {
    const d = designDatacenter({ ...base, junctionTemp: T });
    check(d.thermal.area < prevRad, 'hotter junction shrinks the radiator', `T=${T}`);
    prevRad = d.thermal.area;
  }

  // More shielding must mean less dose.
  let prevDose = Infinity;
  for (const mm of [1, 2.54, 5, 10, 20, 40]) {
    const d = designDatacenter({ ...base, shieldingMm: mm });
    check(d.radiation.kradPerYear < prevDose, 'more shielding lowers dose', `${mm} mm`);
    prevDose = d.radiation.kradPerYear;
  }

  // Higher orbit must decay more slowly.
  let prevDecay = -Infinity;
  for (const alt of [300e3, 400e3, 500e3, 600e3, 800e3]) {
    const d = designDatacenter({ ...base, altitude: alt });
    check(d.orbit.decayYears > prevDecay, 'higher orbit decays slower', `${alt / 1000} km`);
    prevDecay = d.orbit.decayYears;
  }

  // Longer mission must never reduce total cost.
  let prevCost = -Infinity;
  for (const y of [1, 5, 10, 20]) {
    const d = designDatacenter({ ...base, missionYears: y });
    const c = compare(d, { launchVehicle: 'falcon9' });
    check(c.orbital.total > prevCost, 'longer mission costs more', `${y} yr`);
    prevCost = c.orbital.total;
  }
}

// ===========================================================================
console.log('── orbital lifetime edge cases ─────────────────────────────');
// ===========================================================================
{
  for (const alt of [120e3, 150e3, 200e3, 400e3, 1000e3, 2000e3]) {
    for (const B of [1, 10, 50, 200, 1000]) {
      const r = orbitalLifetime(alt, B);
      check(Number.isFinite(r.years) && r.years >= 0,
        'lifetime finite and non-negative', `alt=${alt / 1000} B=${B} -> ${r.years}`);
      check(r.profile.length >= 2, 'lifetime returns a profile', `alt=${alt / 1000} B=${B}`);
    }
  }
  check(orbitalLifetime(100e3, 50).years === 0, 'below reentry altitude decays immediately');
}

// ===========================================================================
// Report
// ===========================================================================
console.log('');
console.log('═'.repeat(62));
if (failures.length === 0) {
  console.log(`✓ ALL CLEAR — ${checks.toLocaleString()} invariant checks passed`);
} else {
  // Group identical labels so one systemic bug does not print 4000 lines.
  const byLabel = new Map();
  for (const f of failures) {
    if (!byLabel.has(f.label)) byLabel.set(f.label, []);
    byLabel.get(f.label).push(f.detail);
  }
  console.log(`✗ ${failures.length.toLocaleString()} FAILURES across ${byLabel.size} distinct invariants (${checks.toLocaleString()} checks run)`);
  console.log('');
  for (const [label, details] of [...byLabel].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ✗ ${label}  ×${details.length}`);
    for (const d of details.slice(0, 4)) console.log(`      ${d}`);
    if (details.length > 4) console.log(`      … and ${details.length - 4} more`);
  }
  process.exitCode = 1;
}
