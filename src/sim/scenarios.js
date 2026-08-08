/**
 * SCENARIO ENGINE — the ways an orbital datacenter fails, and what fixes each.
 *
 * The README states an outcomes matrix: for every subsystem, a failure mode, a
 * condition under which the design is viable instead, and the engineering
 * solution that gets you from one to the other. This module turns that table
 * from documentation into something executable.
 *
 * Three things it does that a table cannot:
 *
 *   1. MEASURES. Every scenario computes its own number from the physics
 *      modules -- radiator area, dose lifetime, battery fraction, decay years,
 *      link margin, cost ratio -- and grades it against thresholds taken from
 *      the README. No scenario is a hand-written verdict.
 *
 *   2. APPLIES THE FIX AND RECOMPUTES. Each remedy is a config patch. The
 *      engine applies it, re-runs the whole design, and reports what actually
 *      happened, including the cases where the documented solution is not
 *      enough on its own.
 *
 *   3. REPORTS WHAT THE FIX BREAKS. This is the part a matrix structurally
 *      cannot express, because its rows are independent and the real system is
 *      not. Raising the orbit to escape drag walks into the proton belt.
 *      Running silicon hotter to shrink the radiator costs reliability margin.
 *      Every remedy is re-graded against ALL scenarios, and any that regress
 *      are reported as side effects.
 *
 * Pure functions over plain objects, no DOM, SI units throughout.
 */

import { designDatacenter } from './datacenter.js';
import { compare } from './economics.js';
import { latchupRate } from './radiation.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Verdict ordering, worst first, so regressions are easy to detect. */
export const STATUS_RANK = { fail: 0, marginal: 1, viable: 2 };

// ---------------------------------------------------------------------------
// Supplementary models
// ---------------------------------------------------------------------------

/**
 * Single-event effects, which `designDatacenter` does not model end to end.
 *
 * It computes an upset rate but has no notion of what the design does about
 * it, and the difference between a station with over-current protection and
 * one without is not a detail: latchup is the failure mode that physically
 * destroys parts. Everything else on the radiation side degrades.
 *
 * @param {object} design result of designDatacenter()
 * @param {object} cfg    the config it was built from, plus:
 *   eccMode            'none' | 'secded' | 'secdedScrub' | 'tmr'
 *   latchupProtection  'none' | 'ocp'   (sub-millisecond over-current limiting)
 */
export function singleEventEffects(design, cfg) {
  const {
    altitude, inclination = 0, missionYears = 10,
    eccMode = 'secded', latchupProtection = 'none',
  } = cfg;

  // Devices, not racks: latchup is a per-die event. A dense accelerator rack
  // carries of order forty large devices once accelerators, memory stacks and
  // the power stages are counted.
  const devicesPerRack = 40;
  const deviceCount = Math.max(1, Math.round(design.compute.rackCount * devicesPerRack));

  const latch = latchupRate({ deviceCount, altitude, inclination });

  // Without current limiting a latchup destroys the part. With it, the domain
  // is tripped and power-cycled: seconds of lost work, no lost hardware.
  const destroyedPerYear = latchupProtection === 'ocp' ? 0 : latch.eventsPerYear;
  const destroyedTotal = destroyedPerYear * missionYears;
  const capacityLost = clamp(destroyedTotal / deviceCount, 0, 1);

  // ECC catches single-bit upsets outright. Scrubbing matters because the
  // failure that gets you is a SECOND strike in a word that already carries a
  // latent single-bit error, and scrubbing removes latent errors before they
  // can pair up. TMR votes out what is left at triple the hardware.
  const eccResidual = { none: 1, secded: 1, secdedScrub: 0.25, tmr: 0.02 }[eccMode] ?? 1;
  const uncorrectedPerDay = design.radiation.seu.uncorrectedPerDay * eccResidual;
  const mtbfHours = uncorrectedPerDay > 0 ? 24 / uncorrectedPerDay : Infinity;

  // "99.99% memory state integrity" read as: the chance a given day passes
  // with the working set uncorrupted.
  const dailyIntegrity = Math.exp(-uncorrectedPerDay);

  return {
    deviceCount,
    eccMode,
    latchupProtection,
    latchupsPerYear: latch.eventsPerYear,
    devicesDestroyed: destroyedTotal,
    capacityLostToLatchup: capacityLost,
    uncorrectedPerDay,
    meanTimeBetweenUncorrectedHours: mtbfHours,
    dailyIntegrity,
  };
}

/**
 * Downlink demand against downlink supply.
 *
 * The README's failure mode is a saturated pipe with most of the computed
 * output stranded in orbit, so the question is not "does the link close" but
 * "does it carry what the compute produces".
 */
export function downlinkBalance(design, cfg) {
  const {
    // Bytes produced per PFLOP-second that must reach the ground. Inference
    // output is tiny next to the arithmetic that made it; training checkpoints
    // are not. This is the single most uncertain number here and is exposed
    // rather than buried.
    bytesPerPflopSecond = 2.0e3,
    edgeFiltering = false,
  } = cfg;

  const produced = design.compute.petaflops * bytesPerPflopSecond;   // bytes/s
  // "Edge AI data reduction reduces downlinked volume by up to 99%."
  const required = produced * (edgeFiltering ? 0.01 : 1);
  const available = design.comms.downlink.averageRateBps / 8;        // bytes/s

  return {
    requiredBytesPerSecond: required,
    availableBytesPerSecond: available,
    marginRatio: available / Math.max(required, 1e-9),
    strandedFraction: clamp(1 - available / Math.max(required, 1e-9), 0, 1),
    linkMarginDb: design.comms.link.linkMarginDb,
    linkCloses: design.comms.link.closed,
    edgeFiltering,
  };
}

// ---------------------------------------------------------------------------
// Scenario definitions
// ---------------------------------------------------------------------------

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const t = (kg) => `${(kg / 1000).toFixed(1)} t`;

/**
 * Every scenario measures one number, grades it, and carries the remedies the
 * README prescribes. `measure` returns { status, headline, metrics }.
 */
export const SCENARIOS = [
  // ---------------------------------------------------------------- thermal
  {
    id: 'thermal',
    name: 'Thermal rejection',
    subsystem: 'thermal',
    failure: 'Thermal runaway; junction exceeds its limit; radiator area explodes past 40,000 m².',
    viableWhen: 'Stable equilibrium below the junction limit through end of life.',
    measure(design) {
      const area = design.thermal.area;
      const feasible = design.thermal.feasible && Number.isFinite(area);
      const status = !feasible || area > 40000 ? 'fail' : area > 20000 ? 'marginal' : 'viable';
      return {
        status,
        // Higher is better. Bands alone are too coarse to steer by: high-Tj
        // silicon cuts a 186,000 m² radiator to 74,000 and that is still
        // "fail", so a band-only search sees no progress and gives up.
        score: feasible ? 40000 / Math.max(area, 1) : 0,
        headline: feasible
          ? `${Math.round(area).toLocaleString()} m² of radiator at ${design.thermal.radiatorTemp.toFixed(0)} K`
          : 'No radiator area rejects this load — thermal runaway',
        metrics: [
          ['Radiator area', feasible ? `${Math.round(area).toLocaleString()} m²` : '∞'],
          ['Radiator mass', feasible ? t(design.thermal.mass) : '—'],
          ['Net flux', `${design.thermal.netPerArea.toFixed(0)} W/m²`],
          ['EOL absorptivity', design.thermal.designAlpha.toFixed(3)],
        ],
      };
    },
    remedies: [
      { id: 'highTjSilicon', name: 'High-Tj silicon (GaN/SiC, 400 K junction)',
        summary: 'Radiated power goes as T⁴, so raising the junction limit is the single biggest lever there is.',
        patch: { junctionTemp: 400 } },
      { id: 'sicModerate', name: 'SiC at 375 K junction',
        summary: 'A less aggressive step than 400 K, still well above the 358 K silicon limit.',
        patch: { junctionTemp: 375 } },
      { id: 'silveredTeflon', name: 'Silvered-Teflon radiator coating',
        summary: 'Lower solar absorptivity than Z93 white paint and it degrades less.',
        patch: { coating: 'silveredTeflon' } },
      // Not an engineering solution -- it changes the requirement rather than
      // meeting it -- so it is offered for comparison but never picked by the
      // auto-resolver, which would otherwise "solve" everything by descoping.
      { id: 'lowerPower', name: 'Halve the compute load', kind: 'descope',
        summary: 'Heat load is exactly IT power, so halving the load halves the radiator. This is descoping, not solving.',
        patch: (cfg) => ({ ...cfg, itPower: cfg.itPower / 2 }) },
    ],
  },

  // ----------------------------------------------------------- radiation TID
  {
    id: 'radiationTid',
    name: 'Total ionizing dose',
    subsystem: 'radiation',
    failure: 'Electronics bricked within months as gate oxides break down.',
    viableWhen: 'Ten-plus years of survival with under 5% compute capacity lost.',
    measure(design, cfg) {
      const years = design.radiation.lifetimeYears;
      const mission = cfg.missionYears ?? 10;
      const status = years < mission ? 'fail' : years < mission * 1.5 ? 'marginal' : 'viable';
      return {
        status,
        score: years / Math.max(mission, 1e-9),
        headline: `${design.radiation.kradPerYear.toFixed(1)} krad/yr — parts last ${years.toFixed(1)} yr against a ${mission} yr mission`,
        metrics: [
          ['Dose rate', `${design.radiation.kradPerYear.toFixed(1)} krad(Si)/yr`],
          ['Part class', `${design.radiation.tolerance.name} (${design.radiation.tolerance.tolerance} krad)`],
          ['Shielding', `${(cfg.shieldingMm ?? 5).toFixed(1)} mm Al-eq, ${t(design.mass.shielding)}`],
          ['Environment', design.radiation.band],
        ],
      };
    },
    remedies: [
      { id: 'gradedZShield', name: 'Graded-Z shielding, 20 mm Al-equivalent',
        summary: 'The README prescribes 10–20 mm with inner high-Z liners. Costs mass.',
        patch: { shieldingMm: 20 } },
      { id: 'radTolerant', name: 'Radiation-tolerant silicon (100 krad)',
        summary: 'Twenty times the tolerance of commercial parts, at a large cost and compute-density penalty.',
        patch: { electronicsClass: 'radTolerant' } },
      { id: 'exitBelt', name: 'Site below the inner proton belt (600 km)',
        summary: 'Dose spikes above 350 krad/yr between 1,000 and 10,000 km. The fix is to not be there.',
        patch: { altitude: 600e3 } },
    ],
  },

  // ------------------------------------------------------- radiation SEE/SEL
  {
    id: 'singleEvent',
    name: 'Single-event effects',
    subsystem: 'radiation',
    failure: 'Latchup shorts power rails and destroys parts; bit flips corrupt model weights.',
    viableWhen: 'No single-point hardware destruction, and under one uncorrected upset a day.',
    measure(design, cfg) {
      const see = singleEventEffects(design, cfg);
      const destroys = see.capacityLostToLatchup > 0.05;
      // Graded on the uncorrected RATE, not on a probability of a clean day.
      // At datacenter memory scale exp(-N) underflows to zero for every option
      // on offer, so a probability gives the solver no gradient to follow and
      // makes TMR look identical to no mitigation at all. It is also the more
      // useful number: what matters operationally is how often you lose work.
      const status = destroys || see.uncorrectedPerDay > 1e4
        ? 'fail' : see.uncorrectedPerDay > 1 ? 'marginal' : 'viable';
      return {
        status,
        score: (1 - see.capacityLostToLatchup)
          + 1 / (1 + Math.log10(1 + see.uncorrectedPerDay)),
        // Say which of the two it is. "Contained" means protection is fitted,
        // not merely that the rate happens to be survivable at this altitude.
        headline: destroys
          ? `${see.latchupsPerYear.toFixed(0)} latchups/yr destroying ${pct(see.capacityLostToLatchup)} of the fleet`
          : `${see.latchupProtection === 'ocp'
              ? 'Latchups contained'
              : `${see.latchupsPerYear.toFixed(0)} latchups/yr unprotected, ${pct(see.capacityLostToLatchup)} lost`}`
            + `; ${see.uncorrectedPerDay.toExponential(2)} uncorrected upsets/day`
            + ` across ${(design.compute.memoryBytes / 1e12).toFixed(0)} TB`,
        metrics: [
          ['Latchup rate', `${see.latchupsPerYear.toFixed(1)} /yr over ${see.deviceCount.toLocaleString()} devices`],
          ['Capacity lost', pct(see.capacityLostToLatchup)],
          ['Uncorrected upsets', `${see.uncorrectedPerDay.toExponential(2)} /day`],
          ['Uncorrected MTBF', see.meanTimeBetweenUncorrectedHours > 1e6
            ? '> a century' : `${(see.meanTimeBetweenUncorrectedHours * 3600).toFixed(2)} s`],
          ['Protection', `${see.eccMode} · latchup ${see.latchupProtection}`],
          // The per-bit base rate spans two orders of magnitude across real
          // devices. At 400 TB that swing moves the upset count from
          // manageable to hopeless, so the bar this scenario is graded against
          // should be read as a sensitivity, not a prediction.
          ['Base-rate spread', '±2 orders of magnitude'],
        ],
        extra: see,
      };
    },
    remedies: [
      { id: 'ocp', name: 'Sub-millisecond over-current protection',
        summary: 'Trips and power-cycles a latched domain before the die cooks. Turns destruction into seconds of downtime.',
        patch: { latchupProtection: 'ocp' } },
      { id: 'secdedScrub', name: 'SECDED ECC with memory scrubbing',
        summary: 'Scrubbing removes latent single-bit errors before a second strike makes them uncorrectable.',
        patch: { eccMode: 'secdedScrub' } },
      { id: 'tmr', name: 'Triple modular redundancy',
        summary: 'Votes out what ECC cannot catch, at three times the hardware for the protected path.',
        patch: { eccMode: 'tmr' } },
    ],
  },

  // ---------------------------------------------------------- eclipse power
  {
    id: 'eclipsePower',
    name: 'Eclipse power',
    subsystem: 'power',
    failure: 'Battery mass exceeds 30% of payload; cycle death around year five.',
    viableWhen: 'No battery mass penalty — continuous generation.',
    measure(design, cfg) {
      const frac = design.mass.battery / Math.max(design.mass.total, 1);
      const cycleDeath = !design.power.batteryLifeOk;
      const status = frac > 0.30 || cycleDeath ? 'fail' : frac > 0.10 ? 'marginal' : 'viable';
      return {
        status,
        score: (1 - frac) - (cycleDeath ? 1 : 0),
        headline: design.mass.battery <= 0
          ? 'Continuously sunlit — no battery carried'
          : cycleDeath
            ? `${t(design.mass.battery)} of battery, but ${Math.round(design.power.cycles.totalCycles).toLocaleString()} cycles exceeds its ${design.power.battery.cycleLife?.toLocaleString() ?? 'rated'} cycle life`
            : `${t(design.mass.battery)} of battery, ${pct(frac)} of launch mass`,
        metrics: [
          ['Battery mass', t(design.mass.battery)],
          ['Share of vehicle', pct(frac)],
          ['Eclipse fraction', pct(design.orbit.eclipseFraction)],
          ['Charge cycles', `${Math.round(design.power.cycles.totalCycles).toLocaleString()}` +
            (cycleDeath ? ' — exceeds cycle life' : '')],
          ['Array area', `${Math.round(design.power.array.area).toLocaleString()} m²`],
        ],
      };
    },
    remedies: [
      { id: 'dawnDuskSso', name: 'Dawn–dusk sun-synchronous orbit',
        summary: '97.9° at 600–800 km holds the plane near the terminator, so the vehicle never enters shadow.',
        patch: { inclination: 97.9, altitude: 700e3, betaAngle: (90 * Math.PI) / 180 } },
      { id: 'modernCells', name: 'High-energy Li-ion chemistry',
        summary: 'Half the mass at 200 Wh/kg — but half the cycle life too, and a LEO station '
          + 'charges sixteen times a day. Usually trades a mass problem for a wear-out problem.',
        patch: { batteryTech: 'liIonModern' } },
      { id: 'longLifeCells', name: 'LiFePO4 (100,000 cycle life)',
        summary: 'Heavier per watt-hour but survives the cycle count, and tolerates deeper discharge.',
        patch: { batteryTech: 'liFePO4' } },
    ],
  },

  // -------------------------------------------------------------------- drag
  {
    id: 'drag',
    name: 'Atmospheric drag',
    subsystem: 'orbit',
    failure: 'Deorbits inside eighteen months without continuous thrust.',
    viableWhen: 'Orbit stable for twelve years on modest propellant.',
    measure(design, cfg) {
      const mission = cfg.missionYears ?? 10;
      const decay = design.orbit.decayYears;
      const dv = design.orbit.stationKeepingDvTotal;
      const status = decay < 1.5 ? 'fail' : decay < mission ? 'marginal' : 'viable';
      return {
        status,
        score: Math.min(Number.isFinite(decay) ? decay : 1e3, 1e3) / Math.max(mission, 1e-9),
        headline: Number.isFinite(decay)
          ? `Unpowered decay in ${decay.toFixed(1)} yr; ${Math.round(dv)} m/s to hold station`
          : `Stable; ${Math.round(dv)} m/s to hold station`,
        metrics: [
          ['Unpowered decay', Number.isFinite(decay) ? `${decay.toFixed(1)} yr` : '> century'],
          ['Ballistic coefficient', `${design.orbit.ballisticCoefficient.toFixed(1)} kg/m²`],
          ['Drag area', `${Math.round(design.orbit.dragArea).toLocaleString()} m²`],
          ['Station-keeping', `${Math.round(dv)} m/s over ${mission} yr`],
          ['Propellant', t(design.mass.propellant)],
        ],
      };
    },
    remedies: [
      { id: 'raiseTo700', name: 'Station above 600 km',
        summary: 'Density falls roughly an order of magnitude per 100 km here, so a modest raise buys years.',
        patch: { altitude: 700e3 } },
      { id: 'raiseTo1000', name: 'Station at 1,000 km',
        summary: 'Drag effectively disappears — but this is the edge of the inner proton belt.',
        patch: { altitude: 1000e3 } },
    ],
  },

  // ---------------------------------------------------------------- downlink
  {
    id: 'downlink',
    name: 'Downlink capacity',
    subsystem: 'comms',
    failure: 'Pipe saturated; most of the computed output stranded in orbit.',
    viableWhen: 'Downlink carries what the compute produces.',
    measure(design, cfg) {
      const b = downlinkBalance(design, cfg);
      const status = !b.linkCloses || b.strandedFraction > 0.5
        ? 'fail' : b.strandedFraction > 0.05 ? 'marginal' : 'viable';
      const gb = (x) => `${((x * 8) / 1e9).toFixed(2)} Gbps`;
      return {
        status,
        score: (b.linkCloses ? 1 : 0) + (1 - b.strandedFraction),
        headline: b.strandedFraction > 0.005
          ? `${pct(b.strandedFraction)} of output stranded in orbit`
          : 'Downlink carries the full output',
        metrics: [
          ['Produced', gb(b.requiredBytesPerSecond)],
          ['Downlinked', gb(b.availableBytesPerSecond)],
          ['Link margin', `${b.linkMarginDb.toFixed(1)} dB`],
          ['Stranded', pct(b.strandedFraction)],
        ],
        extra: b,
      };
    },
    remedies: [
      { id: 'edgeFiltering', name: 'Edge AI data reduction',
        summary: 'Process on orbit and downlink conclusions, not raw data — up to 99% less volume.',
        patch: { edgeFiltering: true } },
      { id: 'opticalDownlink', name: 'Optical laser downlink',
        summary: 'Optical terminals reach 100 Gbps–1 Tbps where Ka band runs out of spectrum.',
        patch: { band: 'optical' } },
      { id: 'moreStations', name: 'Twenty-four ground stations',
        summary: 'Average rate is contact-limited, so more sites raise throughput almost linearly.',
        patch: { groundStations: 24 } },
    ],
  },

  // --------------------------------------------------------------- economics
  {
    id: 'economics',
    name: 'Launch economics',
    subsystem: 'cost',
    failure: 'Cost per PFLOP-year many times the terrestrial baseline.',
    viableWhen: 'Parity with a terrestrial datacenter.',
    measure(design, cfg) {
      const years = cfg.missionYears ?? 10;
      // The key is `launchVehicle`. Passing `vehicle` silently fell back to the
      // default, so every launch-cost remedy reported an identical figure and
      // looked like it did nothing.
      const c = compare(design, {
        launchVehicle: cfg.costVehicle ?? 'starshipEarly',
        groundStations: cfg.groundStations ?? 6,
      });
      const orbital = c.orbital.perPetaflopYear;
      const ground = c.terrestrial.total / Math.max(design.compute.petaflops * years, 1e-9);
      const ratio = orbital / Math.max(ground, 1e-9);
      const status = ratio > 5 ? 'fail' : ratio > 1.5 ? 'marginal' : 'viable';
      return {
        status,
        score: 1 / Math.max(ratio, 1e-9),
        headline: `$${Math.round(orbital).toLocaleString()} per PFLOP-year — ${ratio.toFixed(1)}× terrestrial`,
        metrics: [
          ['Orbital', `$${Math.round(orbital).toLocaleString()} /PFLOP-yr`],
          ['Terrestrial', `$${Math.round(ground).toLocaleString()} /PFLOP-yr`],
          ['Ratio', `${ratio.toFixed(1)}×`],
          ['Launch share', pct(c.orbital.launchFraction)],
          ['Launch vehicle', c.orbital.launchVehicle.name],
        ],
        extra: { orbital, ground, ratio, launchFraction: c.orbital.launchFraction },
      };
    },
    remedies: [
      { id: 'starshipTarget', name: 'Next-gen heavy lift at target pricing',
        summary: 'The README puts parity below $150–250/kg. This prices the fully-reusable target.',
        patch: { costVehicle: 'starshipTarget' } },
      { id: 'fullyReusable', name: 'Falcon Heavy pricing ($1,500/kg)',
        summary: 'A flying vehicle rather than a target price, for a floor that does not assume Starship.',
        patch: { costVehicle: 'falconHeavy' } },
      { id: 'highTjSilicon', name: 'High-Tj silicon (smaller radiator)',
        summary: 'Radiators are a large mass fraction; shrinking them cuts launch cost directly.',
        patch: { junctionTemp: 400 } },
    ],
  },
];

export const SCENARIO_BY_ID = Object.fromEntries(SCENARIOS.map((s) => [s.id, s]));

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Apply a remedy's patch to a config, without mutating the original. */
export function applyRemedy(cfg, remedy) {
  return typeof remedy.patch === 'function'
    ? remedy.patch({ ...cfg })
    : { ...cfg, ...remedy.patch };
}

/**
 * Grade a configuration against every scenario.
 *
 * @param {object} cfg designDatacenter config, plus the scenario-only keys
 *   documented on `singleEventEffects` and `downlinkBalance`.
 */
export function assess(cfg) {
  const design = designDatacenter(cfg);
  const verdicts = SCENARIOS.map((s) => {
    const m = s.measure(design, cfg);
    return {
      id: s.id,
      name: s.name,
      subsystem: s.subsystem,
      failure: s.failure,
      viableWhen: s.viableWhen,
      status: m.status,
      score: m.score ?? 0,
      headline: m.headline,
      metrics: m.metrics,
      extra: m.extra ?? null,
    };
  });

  const counts = { fail: 0, marginal: 0, viable: 0 };
  for (const v of verdicts) counts[v.status]++;

  return {
    config: cfg,
    design,
    verdicts,
    counts,
    // The design is only viable if nothing is failing. Marginal is allowed --
    // real programmes fly marginal subsystems knowingly.
    verdict: counts.fail > 0 ? 'fail' : counts.marginal > 0 ? 'marginal' : 'viable',
  };
}

/** Status of every scenario, keyed by id -- used to diff two assessments. */
function statusMap(assessment) {
  return Object.fromEntries(assessment.verdicts.map((v) => [v.id, v.status]));
}

/**
 * Try every remedy for one scenario and report what each actually does.
 *
 * The `sideEffects` field is the reason this exists rather than a lookup
 * table: remedies are not independent. Raising the orbit to escape drag walks
 * into the proton belt; running the silicon hotter to shrink the radiator eats
 * reliability margin. Anything that regresses is reported alongside the fix.
 */
export function solve(cfg, scenarioId) {
  const scenario = SCENARIO_BY_ID[scenarioId];
  if (!scenario) throw new Error(`unknown scenario: ${scenarioId}`);

  const before = assess(cfg);
  const beforeStatus = statusMap(before);
  const beforeVerdict = before.verdicts.find((v) => v.id === scenarioId);

  const options = scenario.remedies.map((remedy) => {
    const patched = applyRemedy(cfg, remedy);
    const after = assess(patched);
    const afterStatus = statusMap(after);
    const afterVerdict = after.verdicts.find((v) => v.id === scenarioId);

    const sideEffects = [];
    for (const id of Object.keys(afterStatus)) {
      if (id === scenarioId) continue;
      if (STATUS_RANK[afterStatus[id]] < STATUS_RANK[beforeStatus[id]]) {
        sideEffects.push({ id, from: beforeStatus[id], to: afterStatus[id] });
      }
    }

    return {
      remedy: {
        id: remedy.id, name: remedy.name, summary: remedy.summary,
        kind: remedy.kind ?? 'engineering',
      },
      config: patched,
      from: beforeVerdict.status,
      to: afterVerdict.status,
      scoreFrom: beforeVerdict.score,
      scoreTo: afterVerdict.score,
      // Relative movement in the scenario's own measure, independent of bands.
      improvement: afterVerdict.score / Math.max(beforeVerdict.score, 1e-9) - 1,
      resolved: STATUS_RANK[afterVerdict.status] > STATUS_RANK[beforeVerdict.status],
      cleared: afterVerdict.status === 'viable',
      headline: afterVerdict.headline,
      sideEffects,
      // What the fix costs, in the two currencies that matter.
      deltaMassKg: after.design.mass.total - before.design.mass.total,
      overallFrom: before.verdict,
      overallTo: after.verdict,
    };
  });

  // Best first: cleared outright, then improved, then fewest side effects,
  // then lightest.
  options.sort((a, b) =>
    (b.cleared - a.cleared)
    || (b.resolved - a.resolved)
    || (a.sideEffects.length - b.sideEffects.length)
    || (b.improvement - a.improvement)
    || (a.deltaMassKg - b.deltaMassKg));

  return { scenario: { id: scenario.id, name: scenario.name }, before: beforeVerdict, options };
}

/** Run `solve` for every scenario that is not already viable. */
export function solveAll(cfg) {
  const base = assess(cfg);
  const failing = base.verdicts.filter((v) => v.status !== 'viable');
  return {
    assessment: base,
    solutions: failing.map((v) => solve(cfg, v.id)),
  };
}

/**
 * Apply the best available remedy for each failing scenario, repeatedly, until
 * nothing improves.
 *
 * Greedy and explicitly so: it takes the locally best fix each round and
 * re-derives everything, which is not guaranteed to find the global optimum
 * but does show whether the documented solutions compose into a viable design
 * at all. Where they do not, that is the interesting result.
 */
export function autoResolve(cfg, maxRounds = 12) {
  let current = { ...cfg };
  const applied = [];
  // A remedy is a config patch, so re-applying one is a no-op that would spin
  // the loop forever. Each is offered once.
  const used = new Set();

  for (let round = 0; round < maxRounds; round++) {
    const a = assess(current);
    if (a.verdict === 'viable') {
      return { config: current, applied, assessment: a, converged: true };
    }

    // Work the worst scenario first, then the next, so a round is not wasted
    // when the worst one has nothing left to try.
    const targets = a.verdicts
      .filter((v) => v.status !== 'viable')
      .sort((x, y) => STATUS_RANK[x.status] - STATUS_RANK[y.status]);

    let picked = null;
    for (const target of targets) {
      const { options } = solve(current, target.id);
      const usable = options.filter((o) => !used.has(o.remedy.id)
        && o.sideEffects.length === 0
        && o.remedy.kind !== 'descope');
      // Prefer a band change; failing that, accept a real improvement in the
      // measure itself. A 60% cut in radiator area is progress even when the
      // result is still over the threshold.
      const best = usable.find((o) => o.resolved)
        ?? usable.find((o) => o.improvement > 0.02);
      if (best) { picked = { target, best }; break; }
    }

    if (!picked) {
      const worst = targets[0];
      return {
        config: current, applied, assessment: a, converged: false,
        stuckOn: worst.id,
        reason: `Nothing left to try for ${worst.name} that does not make another `
          + `scenario worse. ${worst.headline}`,
      };
    }

    used.add(picked.best.remedy.id);
    applied.push({
      scenario: picked.target.id,
      remedy: picked.best.remedy.id,
      name: picked.best.remedy.name,
      from: picked.best.from,
      to: picked.best.to,
    });
    current = picked.best.config;
  }

  const a = assess(current);
  return {
    config: current, applied, assessment: a,
    converged: a.verdict === 'viable',
    reason: a.verdict === 'viable' ? null : `Ran out of rounds still ${a.verdict}.`,
  };
}
