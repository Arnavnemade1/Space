/**
 * Configuration and results panels.
 *
 * Every control here maps directly onto a parameter of one of the physics
 * modules; there are no cosmetic knobs. Where a parameter is genuinely
 * uncertain (the radiation model, the cost assumptions) the panel says so
 * next to the control rather than in documentation nobody reads.
 */

import {
  el, group, select, slider, checkbox, stat, stackedBar, issueList, note, empty,
  fmtSI, fmtMass, fmtMoney, fmtArea, fmtTime, fmtYears, areaComparison, squareSide,
} from './widgets.js';

import { VEHICLES, LAUNCH_SITES } from '../sim/vehicles.js';
import { COMPUTE_PROFILES } from '../sim/datacenter.js';
import { SOLAR_TECH, BATTERY_TECH } from '../sim/power.js';
import { DOSE_TOLERANCE } from '../sim/radiation.js';
import { BANDS } from '../sim/comms.js';
import { LAUNCH_COSTS } from '../sim/economics.js';
import { STUDIES, matrixSize } from '../sim/explore.js';
import { DEG, G0 } from '../sim/constants.js';

const MASS_PALETTE = ['#4dd0e1', '#e8eef6', '#2a6fb0', '#c98fff', '#ff8f6b', '#5ee08a', '#ffc75a'];

// ===========================================================================
// Configuration
// ===========================================================================

export function buildConfig(state, set, tab) {
  const frag = document.createDocumentFragment();

  if (tab === 'launch') {
    frag.appendChild(group('LAUNCH VEHICLE', [
      select('Vehicle',
        Object.values(VEHICLES).map((v) => [v.id, `${v.name}${v.confidence === 'estimated' ? ' *' : ''}`]),
        state.vehicleId, (v) => set({ vehicleId: v })),
      vehicleSummary(VEHICLES[state.vehicleId]),
      checkbox('Recover booster (reserves 25% of stage-1 propellant)',
        state.reusableBooster, (v) => set({ reusableBooster: v })),
    ]));

    frag.appendChild(group('LAUNCH SITE', [
      select('Site',
        Object.values(LAUNCH_SITES).map((s) => [s.id, `${s.name.split(',')[0]} (${s.latitude.toFixed(1)}°)`]),
        state.siteId, (v) => set({ siteId: v })),
      siteSummary(LAUNCH_SITES[state.siteId], state.targetInclination),
    ]));

    frag.appendChild(group('TARGET ORBIT', [
      slider('Payload mass', {
        min: 100, max: 200000, log: true, value: state.payloadMass,
        format: (v) => fmtMass(v), onInput: (v) => set({ payloadMass: v }, false),
      }),
      slider('Circular altitude', {
        min: 160, max: 2000, step: 10, value: state.targetAltitude / 1000, unit: ' km',
        format: (v) => v.toFixed(0), onInput: (v) => set({ targetAltitude: v * 1000 }, false),
      }),
      slider('Inclination', {
        min: 0, max: 145, step: 0.5, value: state.targetInclination, unit: '°',
        format: (v) => v.toFixed(1), onInput: (v) => set({ targetInclination: v }, false),
      }),
    ]));

    frag.appendChild(group('GUIDANCE', [
      slider('Vertical rise', {
        min: 0, max: 30, step: 1, value: state.guidance.verticalRiseTime, unit: ' s',
        format: (v) => v.toFixed(0),
        onInput: (v) => set({ guidance: { ...state.guidance, verticalRiseTime: v } }, false),
      }),
      slider('Pitch-over altitude', {
        min: 20, max: 160, step: 5, value: state.guidance.turnAltitude / 1000, unit: ' km',
        format: (v) => v.toFixed(0),
        onInput: (v) => set({ guidance: { ...state.guidance, turnAltitude: v * 1000 } }, false),
      }),
      slider('Turn exponent', {
        min: 0.3, max: 1.2, step: 0.01, value: state.guidance.turnExponent,
        format: (v) => v.toFixed(2),
        onInput: (v) => set({ guidance: { ...state.guidance, turnExponent: v } }, false),
      }),
      slider('Max axial acceleration', {
        min: 2, max: 8, step: 0.1, value: state.guidance.maxAxialAccel / G0, unit: ' g',
        format: (v) => v.toFixed(1),
        onInput: (v) => set({ guidance: { ...state.guidance, maxAxialAccel: v * G0 } }, false),
      }),
      slider('q·α structural limit', {
        min: 2e4, max: 5e5, log: true, value: state.guidance.qAlphaLimit, unit: ' Pa·°',
        format: (v) => fmtSI(v, 0),
        onInput: (v) => set({ guidance: { ...state.guidance, qAlphaLimit: v } }, false),
      }),
      note('The pitch profile is limited by the q·α budget, so raising the ' +
        'structural limit lets the vehicle turn earlier and lose less to gravity — ' +
        'at the cost of loads a real airframe may not survive.'),
    ], { collapsible: true, collapsed: true }));

    frag.appendChild(group('ENVIRONMENT', [
      slider('Solar flux F10.7', {
        min: 65, max: 250, step: 1, value: state.f107, unit: ' sfu',
        format: (v) => v.toFixed(0), onInput: (v) => set({ f107: v }, false),
      }),
      note('F10.7 drives thermospheric density. It changes drag on ascent barely ' +
        'at all, and orbital lifetime by nearly an order of magnitude.'),
    ], { collapsible: true, collapsed: true }));
  }

  if (tab === 'explore') {
    frag.appendChild(group('STUDY', [
      select('Question',
        Object.entries(STUDIES).map(([k, v]) => [k, v.name]),
        state.study, (v) => set({ study: v })),
      studySummary(state.study),
      checkbox('Show only configurations that close',
        state.exploreViableOnly, (v) => set({ exploreViableOnly: v })),
    ]));

    frag.appendChild(group('RANK BY', [
      select('Metric',
        STUDIES[state.study].kind === 'launch'
          ? [['dvIdeal', 'Total ideal ΔV'], ['dvGravityLoss', 'Gravity loss'],
             ['maxQkPa', 'Max dynamic pressure'], ['maxG', 'Peak axial load'],
             ['altitudeErrorPct', 'Altitude miss']]
          : [['totalMassT', 'Launch mass'], ['costUsd', 'Total cost'],
             ['costPerPflopYear', 'Cost per PFLOP-year'], ['radiatorArea', 'Radiator area'],
             ['kradPerYear', 'Radiation dose'], ['decayYears', 'Orbital lifetime']],
        state.rankKey, (v) => set({ rankKey: v })),
      select('Direction', [['min', 'Lowest first'], ['max', 'Highest first']],
        state.rankDir, (v) => set({ rankDir: v })),
      note('The Pareto front below is the honest answer to "what works": every ' +
        'configuration on it wins on something. A single ranking hides the trade.'),
    ]));
    return frag;
  }

  if (tab === 'design' || tab === 'analysis' || tab === 'sweep') {
    frag.appendChild(group('COMPUTE LOAD', [
      slider('IT power', {
        min: 1e4, max: 1e9, log: true, value: state.itPower,
        format: (v) => fmtSI(v, 1, 'W'), onInput: (v) => set({ itPower: v }, false),
      }),
      select('Hardware profile',
        Object.entries(COMPUTE_PROFILES).map(([k, v]) => [k, v.name]),
        state.computeProfile, (v) => set({ computeProfile: v })),
      slider('Mission duration', {
        min: 1, max: 25, step: 1, value: state.missionYears, unit: ' yr',
        format: (v) => v.toFixed(0), onInput: (v) => set({ missionYears: v }, false),
      }),
    ]));

    frag.appendChild(group('ORBIT', [
      slider('Altitude', {
        min: 300, max: 40000, log: true, value: state.dcAltitude / 1000, unit: ' km',
        format: (v) => v.toFixed(0), onInput: (v) => set({ dcAltitude: v * 1000 }, false),
      }),
      slider('Inclination', {
        min: 0, max: 145, step: 0.5, value: state.dcInclination, unit: '°',
        format: (v) => v.toFixed(1), onInput: (v) => set({ dcInclination: v }, false),
      }),
      slider('Beta angle (orbit plane to Sun)', {
        min: 0, max: 90, step: 1, value: state.betaAngle / DEG, unit: '°',
        format: (v) => v.toFixed(0), onInput: (v) => set({ betaAngle: v * DEG }, false),
      }),
      note('At high beta the orbit is continuously sunlit: no eclipse, no ' +
        'batteries, and a radiator that never gets a break.'),
    ]));

    frag.appendChild(group('SUBSYSTEMS', [
      select('Solar array',
        Object.entries(SOLAR_TECH).map(([k, v]) => [k, v.name]),
        state.solarTech, (v) => set({ solarTech: v })),
      select('Battery',
        Object.entries(BATTERY_TECH).map(([k, v]) => [k, v.name]),
        state.batteryTech, (v) => set({ batteryTech: v })),
      slider('Junction temperature limit', {
        min: 320, max: 400, step: 1, value: state.junctionTemp, unit: ' K',
        format: (v) => `${v.toFixed(0)} (${(v - 273.15).toFixed(0)}°C)`,
        onInput: (v) => set({ junctionTemp: v }, false),
      }),
      note('Radiator rejection goes as T⁴, so letting the silicon run hotter is ' +
        'the single most effective way to shrink the radiator.'),
    ]));

    frag.appendChild(group('RADIATION', [
      select('Electronics class',
        Object.entries(DOSE_TOLERANCE).map(([k, v]) => [k, `${v.name} (${fmtSI(v.tolerance, 0)}rad)`]),
        state.electronicsClass, (v) => set({ electronicsClass: v })),
      slider('Shielding (Al equivalent)', {
        min: 1, max: 40, step: 0.5, value: state.shieldingMm, unit: ' mm',
        format: (v) => v.toFixed(1), onInput: (v) => set({ shieldingMm: v }, false),
      }),
      note('Order-of-magnitude model. See MODELS & LIMITS — this is the least ' +
        'certain part of the simulator and it is not AP-9/AE-9.'),
    ], { collapsible: true, collapsed: tab !== 'analysis' }));

    frag.appendChild(group('DOWNLINK', [
      select('Band', Object.entries(BANDS).map(([k, v]) => [k, v.name]), state.band,
        (v) => set({ band: v })),
      slider('Ground stations', {
        min: 1, max: 40, step: 1, value: state.groundStations,
        format: (v) => v.toFixed(0), onInput: (v) => set({ groundStations: v }, false),
      }),
      slider('Transmit power', {
        min: 10, max: 2000, log: true, value: state.transmitPower, unit: ' W',
        format: (v) => v.toFixed(0), onInput: (v) => set({ transmitPower: v }, false),
      }),
    ], { collapsible: true, collapsed: tab !== 'analysis' }));

    frag.appendChild(group('DEPLOYMENT & COST', [
      select('Launch vehicle',
        Object.entries(LAUNCH_COSTS).map(([k, v]) => [k, `${v.name}${v.speculative ? ' *' : ''}`]),
        state.costVehicle, (v) => set({ costVehicle: v })),
      note('Prices marked * are targets or estimates for vehicles that are not ' +
        'yet flying commercially. Launch price dominates the comparison, so the ' +
        'ANALYSIS tab solves for the breakeven price instead of asserting one.'),
    ], { collapsible: true, collapsed: tab !== 'analysis' }));
  }

  return frag;
}

function studySummary(key) {
  const st = STUDIES[key];
  const spec = st.spec();
  return el('div', {}, [
    stat('Sweep type', st.kind === 'launch' ? 'launch trajectories' : 'datacenter designs'),
    stat('Combinations', String(matrixSize(spec.axes))),
    ...Object.entries(spec.axes).map(([k, v]) => stat(`  ${k}`, `${v.length} levels`)),
  ]);
}

function vehicleSummary(v) {
  const stages = v.stages.length;
  const glom = v.stages.reduce((s, st) => s + st.dryMass + st.propellantMass, 0);
  return el('div', {}, [
    stat('Operator', v.operator),
    stat('Stages / GLOM', `${stages} / ${fmtMass(glom)}`),
    stat('LEO (expendable)', fmtMass(v.payloadLeoExpendable)),
    stat('Data confidence', v.confidence === 'published' ? 'published' : 'ESTIMATED',
      v.confidence === 'published' ? 'good' : 'warn'),
    v.notes ? note(v.notes) : null,
  ]);
}

function siteSummary(s, targetInc) {
  const lat = Math.abs(s.latitude);
  // A 0.1 deg tolerance: asking for 28.6 deg from a pad at 28.608 deg is not a
  // design error, it is rounding, and flagging it as a failure is noise.
  const reachable = Math.abs(targetInc) >= lat - 0.1 && Math.abs(targetInc) <= 180 - lat + 0.1;

  return el('div', {}, [
    stat('Latitude', `${s.latitude.toFixed(3)}°`),
    stat('Azimuth corridor', `${s.azimuthMin}° … ${s.azimuthMax}°`),
    stat('Min direct inclination', `${lat.toFixed(2)}°`, reachable ? 'good' : 'warn'),
    !reachable ? note(
      `The orbit plane must pass through the pad, so no direct launch from ` +
      `${lat.toFixed(1)}° latitude reaches ${targetInc.toFixed(1)}°. The vehicle ` +
      'will fly due east instead and settle at the site latitude; reaching the ' +
      'requested inclination needs a dogleg or an on-orbit plane change.',
    ) : null,
    s.notes ? note(s.notes) : null,
  ]);
}

// ===========================================================================
// Results
// ===========================================================================

export function buildResults(state, tab) {
  const frag = document.createDocumentFragment();

  if (tab === 'launch') frag.appendChild(launchResults(state));
  else if (tab === 'design') frag.appendChild(designResults(state));
  else if (tab === 'analysis') frag.appendChild(analysisResults(state));
  else if (tab === 'sweep') frag.appendChild(sweepResults(state));
  else if (tab === 'explore') frag.appendChild(exploreResults(state));

  return frag;
}

// --------------------------------------------------------------- launch tab
function launchResults(state) {
  const a = state.ascent;
  if (!a) return empty('Configure the vehicle and press RUN MISSION.\n\nThe ascent is integrated in 3DOF with a rotating atmosphere, pressure-corrected thrust and J2 gravity.');

  const s = a.summary;
  const d = s.deltaV;
  const wrap = el('div');

  wrap.appendChild(el('div', {
    class: `verdict ${a.success ? 'ok' : 'fail'}`,
    text: a.success
      ? `ORBIT ACHIEVED · ${fmtMass(a.payloadMass)} DELIVERED`
      : `MISSION FAILED · ${a.status.toUpperCase().replace(/-/g, ' ')}`,
  }));

  wrap.appendChild(group('ACHIEVED ORBIT', [
    stat('Perigee', `${(s.perigeeAltitude / 1000).toFixed(1)} km`),
    stat('Apogee', `${(s.apoapsisAltitude / 1000).toFixed(1)} km`),
    stat('Eccentricity', s.eccentricity.toFixed(5)),
    stat('Inclination', `${s.inclinationDeg.toFixed(2)}°`),
    stat('Launch azimuth', `${a.azimuthDeg.toFixed(1)}°`,
      a.azimuthInCorridor ? 'good' : 'warn'),
    !a.azimuthInCorridor ? note(
      'This azimuth is outside the corridor the site actually flies. That is a ' +
      'range-safety constraint, not a physical one — the trajectory is valid, but ' +
      'no regulator would approve it.') : null,
  ]));

  wrap.appendChild(group('ΔV BUDGET', [
    stat('Ideal (∫T/m dt)', `${d.ideal.toFixed(0)} m/s`),
    stat('− Gravity loss', `${d.gravityLoss.toFixed(0)} m/s`, 'warn'),
    stat('− Drag loss', `${d.dragLoss.toFixed(0)} m/s`, 'warn'),
    stat('− Steering loss', `${d.steeringLoss.toFixed(0)} m/s`, 'warn'),
    stat('+ Earth rotation', `${d.rotationBonus.toFixed(0)} m/s`, 'good'),
    stat('= Final speed', `${d.achieved.toFixed(0)} m/s`),
    stackedBar([
      ['Useful', Math.max(0, d.achieved - d.rotationBonus)],
      ['Gravity', d.gravityLoss],
      ['Drag', d.dragLoss],
      ['Steering', d.steeringLoss],
    ], ['#5ee08a', '#ff8f6b', '#ffc75a', '#c98fff']),
  ]));

  wrap.appendChild(group('FLIGHT ENVIRONMENT', [
    stat('Max dynamic pressure', `${(s.maxDynamicPressure / 1000).toFixed(1)} kPa`),
    stat('  at altitude / time', `${(s.maxQAltitude / 1000).toFixed(1)} km · T+${s.maxQTime.toFixed(0)}s`),
    stat('Max Mach', s.maxMach.toFixed(1)),
    stat('Max axial load', `${s.maxAxialG.toFixed(2)} g`),
    stat('Max angle of attack', `${s.maxAngleOfAttack.toFixed(1)}°`),
    stat('Max q·α', `${fmtSI(s.maxQAlpha, 0)}Pa·°`,
      s.structurallyFlyable ? 'good' : 'bad'),
    stat('Peak heat flux', `${fmtSI(s.maxHeatFlux, 1, 'W/m²')}`),
    stat('Flight time', fmtTime(s.flightTime)),
    !s.structurallyFlyable ? note(
      'q·α exceeds the configured structural limit. In 3DOF the vehicle flies this ' +
      'happily; a real airframe would not.') : null,
  ]));

  if (a.circularisation) {
    const c = a.circularisation;
    wrap.appendChild(group('CIRCULARISATION', [
      stat('Coast to apoapsis', fmtTime(c.coastTime)),
      stat('Burn duration', fmtTime(c.burnDuration)),
      stat('ΔV required', `${c.deltaVNeeded.toFixed(0)} m/s`),
      stat('ΔV available', `${c.deltaVAvailable.toFixed(0)} m/s`,
        c.sufficient ? 'good' : 'bad'),
    ]));
  }

  wrap.appendChild(group('SEQUENCE', a.events.map((e) => stat(
    e.name.replace(/-/g, ' '),
    `T+${e.t.toFixed(1)}s · ${(e.altitude / 1000).toFixed(0)} km`,
  ))));

  if (state.maxPayload) {
    wrap.appendChild(group('MAX PAYLOAD SEARCH', [
      stat('To this orbit', fmtMass(state.maxPayload.payload)),
      stat('Published LEO', fmtMass(VEHICLES[state.vehicleId].payloadLeoExpendable)),
      stat('Iterations', String(state.maxPayload.iterations)),
      note('Found by bisection, re-flying the full trajectory at each trial rather ' +
        'than using a rocket-equation shortcut.'),
    ]));
  }

  return wrap;
}

// --------------------------------------------------------------- design tab
function designResults(state) {
  const d = state.design;
  if (!d) return empty('Adjust the compute load and orbit — the design updates live.');

  const wrap = el('div');

  wrap.appendChild(el('div', {
    class: `verdict ${d.viable ? 'ok' : 'fail'}`,
    text: d.viable ? 'DESIGN CLOSES' : 'DESIGN DOES NOT CLOSE',
  }));

  wrap.appendChild(group('THERMAL — THE BINDING CONSTRAINT', [
    stat('Heat to reject', fmtSI(d.thermal.heatLoad, 1, 'W')),
    stat('Radiator temperature', `${d.thermal.radiatorTemp.toFixed(0)} K`),
    stat('Net rejection', `${d.thermal.netPerArea.toFixed(0)} W/m²`),
    stat('Radiator area', fmtArea(d.thermal.area), d.thermal.feasible ? '' : 'bad'),
    stat('  as a square', squareSide(d.thermal.area)),
    stat('  for comparison', areaComparison(d.thermal.area)),
    stat('Radiator mass', fmtMass(d.mass.radiator)),
    note('All electrical power becomes heat — there is no work leaving the system. ' +
      'A radiator rejects about 1 kW/m², so this area is not a design choice.'),
  ]));

  wrap.appendChild(group('POWER', [
    stat('IT load', fmtSI(d.power.itPower, 1, 'W')),
    stat('Total load', fmtSI(d.power.totalPower, 1, 'W')),
    stat('Overhead', `${(d.power.overheadFraction * 100).toFixed(0)}%`),
    stat('Array area', fmtArea(d.power.array.area)),
    stat('  as a square', squareSide(d.power.array.area)),
    stat('Eclipse fraction', `${(d.orbit.eclipseFraction * 100).toFixed(1)}%`),
    stat('Eclipse duration', fmtTime(d.orbit.eclipseSeconds)),
    stat('Battery pack', `${fmtSI(d.power.battery.packEnergyWh * 3600, 1, 'J')} · ${fmtMass(d.mass.battery)}`),
    stat('Charge cycles', `${Math.round(d.power.cycles.totalCycles).toLocaleString()}`,
      d.power.batteryLifeOk ? 'good' : 'warn'),
    stat('Bus current @1 kV', `${Math.round(d.power.pmad.current).toLocaleString()} A`,
      d.power.pmad.warning ? 'warn' : ''),
  ]));

  wrap.appendChild(group('MASS BUDGET', [
    stat('Total launch mass', fmtMass(d.mass.total)),
    stackedBar(d.mass.breakdown.map(([k, v]) => [k.split(' ')[0], v]), MASS_PALETTE),
    ...d.mass.breakdown.map(([k, v]) => stat(k, fmtMass(v))),
  ]));

  wrap.appendChild(group('ORBIT MAINTENANCE', [
    stat('Drag area', fmtArea(d.orbit.dragArea)),
    stat('Ballistic coefficient', `${d.orbit.ballisticCoefficient.toFixed(1)} kg/m²`),
    stat('Decay lifetime', fmtYears(d.orbit.decayYears),
      d.orbit.decayYears < d.inputs.missionYears ? 'bad' : 'good'),
    stat('Station-keeping', `${d.orbit.stationKeepingDvPerYear.toFixed(1)} m/s/yr`),
    stat('Total ΔV over mission', `${d.orbit.stationKeepingDvTotal.toFixed(0)} m/s`),
    stat('Orbital period', fmtTime(d.orbit.period)),
  ]));

  wrap.appendChild(group('COMPUTE', [
    stat('Delivered', `${fmtSI(d.compute.petaflops, 1)}PFLOPS`),
    stat('Racks', Math.round(d.compute.rackCount).toLocaleString()),
    stat('Memory', fmtSI(d.compute.memoryBytes, 1, 'B')),
    stat('PFLOPS per tonne', d.compute.petaflopsPerTonne.toFixed(2)),
  ]));

  wrap.appendChild(group('ISSUES', [issueList(d.issues)]));

  return wrap;
}

// ------------------------------------------------------------- analysis tab
function analysisResults(state) {
  const d = state.design;
  const c = state.comparison;
  if (!d || !c) return empty('Set a design first.');

  const wrap = el('div');

  wrap.appendChild(group('COST COMPARISON', [
    stat('Orbital total', fmtMoney(c.orbital.total)),
    stat('Terrestrial total', fmtMoney(c.terrestrial.total)),
    stat('Ratio', `${c.ratio.toFixed(2)}×`, c.orbitalCheaper ? 'good' : 'bad'),
    stat('Launches needed', `${c.orbital.launchesNeeded} × ${c.orbital.launchVehicle.name}`),
    stat('Launch share of cost', `${(c.orbital.launchFraction * 100).toFixed(0)}%`),
    stackedBar([
      ['Hardware', c.orbital.hardwareTotal],
      ['Integration', c.orbital.integration],
      ['Launch', c.orbital.launchCost],
      ['Ground', c.orbital.groundSegment],
      ['Ops', c.orbital.operations],
      ['Insurance', c.orbital.insurance],
    ], MASS_PALETTE),
  ]));

  wrap.appendChild(group('BREAKEVEN', [
    stat('Assumed launch price', `$${Math.round(c.currentLaunchPricePerKg).toLocaleString()}/kg`),
    stat('Breakeven price', c.breakevenLaunchPricePerKg > 0
      ? `$${Math.round(c.breakevenLaunchPricePerKg).toLocaleString()}/kg`
      : 'unreachable',
      c.breakevenLaunchPricePerKg > c.currentLaunchPricePerKg ? 'good' : 'bad'),
    note(c.verdict),
    ...c.notes.map((n) => note(n)),
  ]));

  wrap.appendChild(group('TERRESTRIAL BASELINE', [
    stat('Facility capex', fmtMoney(c.terrestrial.facility)),
    stat('Hardware (with refreshes)', fmtMoney(c.terrestrial.compute)),
    stat('Hardware refreshes', String(c.terrestrial.hardwareRefreshes)),
    stat('Electricity', fmtMoney(c.terrestrial.electricity)),
    stat('Energy consumed', `${fmtSI(c.terrestrial.energyKwh * 3.6e6, 1, 'J')}`),
    stat('Cooling water', `${fmtSI(c.terrestrial.waterLitres, 1, 'L')}`),
    note('Orbit genuinely avoids the electricity and the water. It also gives up ' +
      'hardware refresh entirely, which the terrestrial column pays for ' +
      `${c.terrestrial.hardwareRefreshes} extra times.`),
  ]));

  wrap.appendChild(group('RADIATION ENVIRONMENT', [
    stat('Annual dose', `${d.radiation.kradPerYear.toFixed(2)} krad/yr`),
    stat('Environment', d.radiation.band.toUpperCase(),
      d.radiation.band === 'benign' ? 'good' : d.radiation.band === 'severe' ? 'bad' : 'warn'),
    stat('Electronics lifetime', fmtYears(d.radiation.lifetimeYears),
      d.radiation.lifetimeYears < d.inputs.missionYears ? 'bad' : 'good'),
    stat('Shielding factor', d.radiation.shieldingFactor.toFixed(3)),
    stat('Raw upsets', `${fmtSI(d.radiation.seu.rawUpsetsPerDay, 1)}/day`),
    stat('Uncorrected (post-ECC)', `${fmtSI(d.radiation.seu.uncorrectedPerDay, 1)}/day`, 'warn'),
    stat('MTBF (uncorrected)', fmtTime(d.radiation.seu.meanTimeBetweenUncorrectedHours * 3600)),
    note(d.radiation.verdict),
    note(`Uncertainty: ${d.radiation.uncertainty}.`),
  ]));

  wrap.appendChild(group('DOWNLINK', [
    stat('Band', d.comms.band.name),
    stat('Slant range (10° el)', `${(d.comms.slantRange / 1000).toFixed(0)} km`),
    stat('Path loss', `${d.comms.link.pathLossDb.toFixed(1)} dB`),
    stat('Link margin', `${d.comms.link.linkMarginDb.toFixed(1)} dB`,
      d.comms.link.closed ? 'good' : 'bad'),
    stat('Peak rate', `${fmtSI(d.comms.link.achievableRateBps, 1)}bit/s`),
    stat('Shannon limit', `${fmtSI(d.comms.link.shannonCapacityBps, 1)}bit/s`),
    stat('Coverage', `${(d.comms.downlink.coverageFraction * 100).toFixed(0)}%`),
    stat('Average rate', `${fmtSI(d.comms.downlink.averageRateBps, 1)}bit/s`),
    stat('Daily volume', `${fmtSI(d.comms.downlink.dailyVolumeBytes, 1, 'B')}`),
    stat('Stations for continuous', String(d.comms.downlink.stationsForContinuous)),
  ]));

  return wrap;
}

// ---------------------------------------------------------------- sweep tab
function sweepResults(state) {
  if (!state.sweep) return empty('Press RUN MISSION to sweep altitude from 300 km to 40 000 km at the current compute load.');

  const wrap = el('div');
  wrap.appendChild(group('ALTITUDE SWEEP', [
    note('Same datacenter, same power, flown at every altitude. The viable band ' +
      'is narrow and it is bounded from below by drag and from above by the ' +
      'inner radiation belt.'),
  ]));

  const table = el('table', { style: 'width:100%;border-collapse:collapse;margin-top:6px' });
  table.appendChild(el('tr', {}, ['ALT', 'DOSE', 'DECAY', 'MASS', 'OK'].map((h) =>
    el('th', {
      style: 'text-align:left;font-size:9px;letter-spacing:.1em;color:#6b7c94;padding:4px 3px;border-bottom:1px solid #1c2636',
      text: h,
    }))));

  for (const row of state.sweep) {
    const tone = row.viable ? '#5ee08a' : '#ff6b6b';
    table.appendChild(el('tr', {}, [
      el('td', { style: cellStyle(), text: `${(row.altitude / 1000).toFixed(0)} km` }),
      el('td', { style: cellStyle(), text: `${row.krad.toFixed(1)}` }),
      el('td', { style: cellStyle(), text: fmtYears(row.decayYears) }),
      el('td', { style: cellStyle(), text: fmtMass(row.mass) }),
      el('td', { style: `${cellStyle()};color:${tone}`, text: row.viable ? '✓' : '✕' }),
    ]));
  }
  wrap.appendChild(table);

  // The viable set is generally NOT contiguous -- drag rules out the bottom,
  // the inner proton belt rules out the middle, and GEO reappears on its own
  // above it. Reporting a single min-to-max range would paint over exactly the
  // structure this sweep exists to reveal.
  const bands = [];
  for (const row of state.sweep) {
    if (!row.viable) { bands.push(null); continue; }
    const last = bands[bands.length - 1];
    if (last) last.push(row); else bands.push([row]);
  }
  const runs = bands.filter(Boolean);

  wrap.appendChild(group('VIABLE BANDS', [
    ...(runs.length
      ? runs.map((run, i) => stat(
          `Band ${i + 1}`,
          run.length === 1
            ? `${(run[0].altitude / 1000).toFixed(0)} km`
            : `${(run[0].altitude / 1000).toFixed(0)} – ${(run[run.length - 1].altitude / 1000).toFixed(0)} km`,
          'good'))
      : [stat('Viable altitudes', 'none at this configuration', 'bad')]),
    stat('Candidates tested', String(state.sweep.length)),
    runs.length > 1
      ? note('The gap between bands is the inner proton belt. It is not a ' +
          'shielding problem — the dose there is two orders of magnitude above ' +
          'LEO and no realistic mass closes it.')
      : null,
  ]));

  return wrap;
}

// ------------------------------------------------------------- explore tab
function exploreResults(state) {
  const r = state.explore;
  if (!r) return empty('Pick a question and press RUN MISSION.\n\nEach study sweeps a parameter matrix and evaluates every combination with the full physics — not an interpolation.');

  const st = STUDIES[state.study];
  const isLaunch = st.kind === 'launch';
  const okKey = isLaunch ? 'success' : 'viable';
  const wrap = el('div');

  wrap.appendChild(el('div', {
    class: `verdict ${r.okCount > 0 ? 'ok' : 'fail'}`,
    text: `${r.okCount} / ${r.rows.length} CONFIGURATIONS ${isLaunch ? 'REACH ORBIT' : 'CLOSE'}`,
  }));

  // --- ranked table -------------------------------------------------------
  const axes = Object.keys(r.axes);
  const metric = state.rankKey;
  const shown = (state.exploreViableOnly ? r.rows.filter((x) => x[okKey]) : r.rows).slice(0, 40);

  const table = el('table', { style: 'width:100%;border-collapse:collapse;margin-top:4px' });
  table.appendChild(el('tr', {}, [...axes, metric, 'OK'].map((h) =>
    el('th', {
      style: 'text-align:left;font-size:9px;letter-spacing:.08em;color:#6b7c94;padding:4px 3px;border-bottom:1px solid #1c2636',
      text: h.length > 11 ? h.slice(0, 11) : h,
    }))));

  for (const row of shown) {
    table.appendChild(el('tr', {}, [
      ...axes.map((a) => el('td', { style: cellStyle(), text: formatAxis(a, row[a]) })),
      el('td', { style: cellStyle(), text: fmtSI(row[metric], 1) }),
      el('td', {
        style: `${cellStyle()};color:${row[okKey] ? '#5ee08a' : '#ff6b6b'}`,
        text: row[okKey] ? '✓' : '✕',
      }),
    ]));
  }
  wrap.appendChild(group(`RANKED BY ${metric.toUpperCase()}`, [table]));

  // --- pareto front -------------------------------------------------------
  if (r.pareto?.length) {
    const objectives = st.objectives.map(([k, d]) => `${d} ${k}`).join(' · ');
    wrap.appendChild(group('PARETO FRONT', [
      note(`Non-dominated on ${objectives}. Nothing else beats these on every count.`),
      ...r.pareto.slice(0, 10).map((row) => stat(
        axes.map((a) => formatAxis(a, row[a])).join(' · '),
        st.objectives.map(([k]) => fmtSI(row[k], 1)).join('  /  '),
        'good',
      )),
    ]));
  }

  // --- sensitivity --------------------------------------------------------
  if (r.sensitivity?.length) {
    wrap.appendChild(group('WHICH KNOB MATTERS', [
      note(`Fold-change in ${metric} when each axis varies and the rest are held fixed.`),
      ...r.sensitivity.map((sv) => stat(
        sv.axis,
        `${sv.medianFoldChange === Infinity ? '∞' : sv.medianFoldChange.toFixed(2)}×`,
        sv.medianFoldChange > 2 ? 'warn' : '',
      )),
    ]));
  }

  // --- per-axis viability -------------------------------------------------
  if (r.groups?.length) {
    wrap.appendChild(group(`VIABILITY BY ${r.groupAxis.toUpperCase()}`,
      r.groups.map((g) => stat(
        formatAxis(r.groupAxis, g.value),
        `${(g.viableFraction * 100).toFixed(0)}%  (${g.viableCount}/${g.count})`,
        g.viableFraction > 0.6 ? 'good' : g.viableFraction > 0 ? 'warn' : 'bad',
      ))));
  }

  return wrap;
}

/** Axis values are a mix of metres, radians, keys — format each sensibly. */
function formatAxis(axis, value) {
  if (typeof value === 'string') return value;
  if (!Number.isFinite(value)) return String(value);
  if (axis === 'altitude' || axis === 'targetAltitude') return `${(value / 1000).toFixed(0)}km`;
  if (axis === 'itPower') return fmtSI(value, 0, 'W');
  if (axis === 'betaAngle') return `${(value / DEG).toFixed(0)}°`;
  if (axis === 'payloadMass') return fmtMass(value);
  if (axis === 'junctionTemp') return `${value.toFixed(0)}K`;
  if (axis === 'shieldingMm') return `${value}mm`;
  if (axis.toLowerCase().includes('inclination')) return `${value}°`;
  return fmtSI(value, 1);
}

const cellStyle = () =>
  'padding:4px 3px;font-size:11px;font-family:ui-monospace,monospace;border-bottom:1px solid #121a26;color:#c8d4e4';
