/**
 * End-to-end mission campaign: launch, deployment, operations, disposal.
 *
 * The other modules answer "can this design close?". This one answers the
 * question that actually decides a programme: what happens over fifteen years?
 *
 * Three things only appear at this level, and all three change the answer:
 *
 *   1. A station is not launched, it is DEPLOYED. Mass goes up in flights, and
 *      capability ramps as modules arrive. A 400 t station on a 100 t vehicle
 *      is four flights and a schedule, and the compute those early modules
 *      produce while the rest is still on the ground is real output that a
 *      single-shot model never counts.
 *
 *   2. Everything degrades. Arrays lose output, batteries fade, silicon
 *      accumulates dose, propellant drains. Day-one performance is the best the
 *      system will ever do, and sizing to it guarantees a shortfall.
 *
 *   3. Missions end, and they end for a specific reason. Which limit binds
 *      first -- propellant, radiation, or the calendar -- is the most useful
 *      single output here, because it says what to fix.
 *
 * Pure function, no I/O, deterministic given its config: built to be fanned out
 * across hundreds of configurations without coordination.
 */

import { designDatacenter } from './datacenter.js';
import { compare, LAUNCH_COSTS } from './economics.js';
import { simulateAscent } from './ascent.js';
import { VEHICLES, LAUNCH_SITES } from './vehicles.js';
import { orbitalLifetime, stationKeepingDeltaV } from './orbit.js';
import { environmentalFlux, COATINGS } from './thermal.js';
import { SIGMA_SB, T_CMB } from './constants.js';
import { R_EARTH_EQ, G0, DEG, YEAR_JULIAN } from './constants.js';

/**
 * Assumptions specific to running a campaign rather than a single spacecraft.
 * Every one is an operational or programmatic choice, not physics, so they sit
 * together here where they can be argued with.
 */
export const CAMPAIGN_DEFAULTS = {
  /** Weeks from a module arriving on orbit to it carrying load. */
  commissioningWeeks: 6,
  /** Flights per year the launch provider can actually fly for this customer. */
  launchesPerYear: 12,
  /** Fraction of a flight's payload capacity actually usable after adapters. */
  payloadEfficiency: 0.9,
  /** Probability a given launch succeeds. Drives expected reflights. */
  launchReliability: 0.97,
  /** Electric thruster specific impulse for station-keeping [s]. */
  thrusterIsp: 1800,
  /**
   * Fraction of the propellant load reserved for end-of-life disposal.
   * Post-mission disposal is a regulatory requirement, not an optional extra:
   * the FCC's 2024 rule cut the old 25-year deorbit guideline to 5 years for
   * LEO. Spending the last of the propellant staying up is not permitted.
   */
  disposalReserve: 0.15,
  /**
   * Battery capacity remaining at rated cycle life. Space Li-ion is typically
   * qualified to 70-80% of beginning-of-life capacity.
   */
  batteryEolCapacity: 0.75,
  /** Unplanned outage fraction: faults, safe modes, software. */
  unplannedOutage: 0.03,
  /**
   * Radiation derating: fraction of dose tolerance at which compute starts to
   * degrade rather than failing outright. Total-dose effects are gradual --
   * leakage rises and timing margin erodes well before anything stops.
   */
  doseDeratingOnset: 0.6,
  /**
   * Radiator coating, keyed into COATINGS. Its solar absorptivity rises over
   * the mission from UV and atomic-oxygen exposure -- the single degradation
   * mechanism that can actually kill a thermal design rather than just trim it.
   */
  radiatorCoating: 'whitePaintZ93',
  /**
   * Time constant of that coating degradation [years]. Most of the darkening
   * happens in the first couple of years of exposure and then asymptotes.
   */
  coatingTau: 2.5,
  /**
   * Real radiator pointing, in degrees from the panel normal.
   *
   * The single-spacecraft sizing assumes panels held exactly edge-on to both
   * the Sun and nadir, which makes the environmental load identically zero and
   * coating degradation a no-op. No real vehicle achieves that: attitude
   * control has error, the panels have finite width, and structure shades and
   * re-radiates onto them. A dozen degrees off edge-on is a fair operational
   * figure and it is what makes the coating matter at all.
   */
  radiatorSunIncidenceDeg: 78,
  radiatorTiltFromNadirDeg: 75,
};

// ---------------------------------------------------------------------------
// Launch campaign
// ---------------------------------------------------------------------------

/**
 * Plan and fly the deployment.
 *
 * The per-flight payload is the smaller of what the vehicle can lift to THIS
 * orbit (flown, not quoted) and an even split of the station across flights.
 * Using the flown figure matters: a vehicle's advertised payload is to its own
 * reference orbit, and a datacenter at 700 km sun-synchronous is a materially
 * harder target than 200 km due east.
 */
export function planDeployment(cfg) {
  const {
    totalMass,
    vehicleId,
    siteId,
    altitude,
    inclination,
    campaign = CAMPAIGN_DEFAULTS,
    startDate = new Date('2030-01-01T00:00:00Z'),
  } = cfg;

  const vehicle = VEHICLES[vehicleId];
  const site = LAUNCH_SITES[siteId];

  // Fly one representative ascent at a trial payload to find what this vehicle
  // actually delivers to this orbit, by bisection on the integrated trajectory.
  const flyTrial = (m) => simulateAscent({
    vehicle, site, payloadMass: m,
    targetAltitude: altitude, targetInclination: inclination,
    sampleInterval: 10,
  });

  let lo = 100;
  let hi = vehicle.payloadLeoExpendable * 1.5;
  let reference = null;

  if (!flyTrial(lo).success) {
    return {
      feasible: false,
      reason:
        `${vehicle.name} cannot reach ${(altitude / 1000).toFixed(0)} km at ` +
        `${inclination.toFixed(1)}° from ${site.name} with any payload.`,
      vehicle, site,
    };
  }

  for (let i = 0; i < 14 && hi - lo > 250; i++) {
    const mid = (lo + hi) / 2;
    const res = flyTrial(mid);
    if (res.success) { lo = mid; reference = res; } else { hi = mid; }
  }

  const deliverablePerFlight = lo * campaign.payloadEfficiency;
  const flightsNeeded = Math.ceil(totalMass / deliverablePerFlight);

  // Expected flights including reflights after failures. A campaign of N
  // successful deliveries at reliability p needs N/p attempts on average.
  const expectedAttempts = flightsNeeded / campaign.launchReliability;

  const massPerFlight = totalMass / flightsNeeded;
  const flightIntervalDays = 365.25 / campaign.launchesPerYear;

  const manifest = [];
  for (let i = 0; i < flightsNeeded; i++) {
    const launchDate = new Date(startDate.getTime() + i * flightIntervalDays * 86400e3);
    const onlineDate = new Date(
      launchDate.getTime() + campaign.commissioningWeeks * 7 * 86400e3);
    manifest.push({
      flight: i + 1,
      launchDate,
      onlineDate,
      massKg: massPerFlight,
      cumulativeMassKg: massPerFlight * (i + 1),
      capabilityFraction: (i + 1) / flightsNeeded,
    });
  }

  const lastOnline = manifest[manifest.length - 1].onlineDate;

  return {
    feasible: true,
    vehicle,
    site,
    reference,
    deliverablePerFlight,
    flightsNeeded,
    expectedAttempts,
    massPerFlight,
    manifest,
    startDate,
    fullCapabilityDate: lastOnline,
    deploymentYears: (lastOnline - startDate) / (YEAR_JULIAN * 1000),
  };
}

// ---------------------------------------------------------------------------
// Operational projection
// ---------------------------------------------------------------------------

/**
 * Month-by-month projection of the station across its life.
 *
 * Monthly rather than annual because the deployment ramp and the propellant
 * endgame both happen on that timescale; annual steps smear the ramp into a
 * straight line and miss the month the tanks run dry.
 */
export function projectOperations(cfg) {
  const {
    design,
    deployment,
    missionYears,
    campaign = CAMPAIGN_DEFAULTS,
    solarDegradationPerYear,
    doseTolerance,
    doseRatePerYear,
  } = cfg;

  const months = Math.ceil(missionYears * 12);
  const dtYears = 1 / 12;

  // --- propellant budget --------------------------------------------------
  const dryMass = design.mass.total - design.mass.propellant;
  const usableProp = design.mass.propellant * (1 - campaign.disposalReserve);
  let propRemaining = usableProp;

  let altitude = design.inputs.altitude;
  let cumulativeDose = 0;
  let cumulativeCycles = 0;
  let cumulativePflopYears = 0;

  // --- thermal margin -----------------------------------------------------
  //
  // A radiator does not degrade by losing emissivity -- it degrades by GAINING
  // solar absorptivity. UV and atomic oxygen darken the coating, so the same
  // panel absorbs progressively more sunlight while emitting the same infrared.
  // Z93 white paint typically goes from alpha 0.17 to around 0.30 over years.
  //
  // That matters because the radiator was sized with a specific net rejection
  // per square metre. As alpha climbs, net rejection falls, and if it falls
  // below the heat load the vehicle has no choice but to throttle the compute
  // that is producing the heat. This is the only mechanism here that can end a
  // mission by overheating, and it is a real one.
  const coating = COATINGS[campaign.radiatorCoating] ?? COATINGS.whitePaintZ93;
  const radiatorTemp = design.thermal.radiatorTemp;
  const epsilon = 0.90;
  const sides = 2;
  const grossPerArea = sides * epsilon * SIGMA_SB * (radiatorTemp ** 4 - T_CMB ** 4);

  const rejectionAtAlpha = (alpha) => {
    const env = environmentalFlux({
      orbitRadius: design.orbit.radius,
      alpha,
      epsilon,
      // Read the pointing back off the design so the two layers cannot drift
      // apart: sizing for one geometry and then flying another guarantees the
      // vehicle starts its life already thermally short.
      sunIncidenceAngle: (design.thermal.sunIncidenceDeg ?? 78) * DEG,
      tiltFromNadir: (design.thermal.tiltFromNadirDeg ?? 75) * DEG,
      sunlitFraction: 1,
    });
    return (grossPerArea - sides * env.total) * 0.85; // fin efficiency
  };

  // An infeasible radiator reports area = Infinity, which would make the
  // required flux per square metre zero and the thermal factor a cheerful 1.0 --
  // exactly inverted. A design that cannot reject its heat at all has no
  // thermal margin, not infinite margin.
  const radiatorFeasible = Number.isFinite(design.thermal.area) && design.thermal.area > 0;
  const requiredPerArea = radiatorFeasible
    ? design.thermal.heatLoad / design.thermal.area
    : Infinity;

  const rows = [];
  let endReason = null;
  let endMonth = null;

  for (let m = 0; m < months; m++) {
    const t = m * dtYears;
    const date = new Date(deployment.startDate.getTime() + t * YEAR_JULIAN * 1000);

    // --- how much of the station is online -------------------------------
    const online = deployment.manifest.filter((f) => f.onlineDate <= date);
    const capability = online.length ? online[online.length - 1].capabilityFraction : 0;

    // --- degradation ------------------------------------------------------
    // Arrays lose output to radiation damage and UV darkening of coverglass.
    const arrayFactor = Math.pow(1 - solarDegradationPerYear, t);

    // Battery fade, linear in cycles to the qualified life.
    const cyclesPerYear = design.orbit.eclipseFraction > 0
      ? YEAR_JULIAN / design.orbit.period : 0;
    cumulativeCycles += cyclesPerYear * dtYears * capability;
    const cycleFraction = design.power.cycles.totalCycles > 0
      ? cumulativeCycles / (design.power.cycles.totalCycles / missionYears * missionYears)
      : 0;
    const batteryFactor = Math.max(
      campaign.batteryEolCapacity,
      1 - (1 - campaign.batteryEolCapacity) * Math.min(1, cycleFraction));

    // Radiator coating darkening, asymptotic in exposure time.
    const alphaNow = coating.alpha +
      (coating.alphaEOL - coating.alpha) * (1 - Math.exp(-t / campaign.coatingTau));
    const rejectionNow = rejectionAtAlpha(alphaNow);
    // How much of the design heat load the radiator can still shed. Below 1 the
    // vehicle must throttle compute to stay inside its junction temperature.
    const thermalFactor = !radiatorFeasible
      ? 0
      : Math.max(0, Math.min(1, rejectionNow / requiredPerArea));

    // Total ionising dose accumulates; compute derates past the onset.
    cumulativeDose += doseRatePerYear * dtYears * (capability > 0 ? 1 : 0);
    const doseFraction = doseTolerance > 0 ? cumulativeDose / doseTolerance : 0;
    const doseFactor = doseFraction <= campaign.doseDeratingOnset
      ? 1
      : Math.max(0, 1 - (doseFraction - campaign.doseDeratingOnset) /
          (1 - campaign.doseDeratingOnset));

    // --- station-keeping --------------------------------------------------
    // Drag scales with the deployed area, so a partly built station needs
    // proportionally less propellant.
    const keeping = stationKeepingDeltaV(altitude, design.orbit.ballisticCoefficient);
    const dvThisMonth = keeping.perYear * dtYears * capability;
    const wetMass = dryMass + propRemaining;
    const propUsed = wetMass * (1 - Math.exp(-dvThisMonth / (campaign.thrusterIsp * G0)));

    if (propRemaining >= propUsed) {
      propRemaining -= propUsed;
    } else {
      // Out of station-keeping propellant: the orbit starts to decay.
      propRemaining = 0;
      const decay = orbitalLifetime(altitude, design.orbit.ballisticCoefficient, {
        maxYears: 2,
      });
      // Approximate the month's altitude loss from the initial decay rate.
      altitude -= Math.min(altitude - 120e3, (decay.decayed ? altitude - 120e3 : 0) * dtYears / Math.max(decay.years, dtYears));
      if (altitude <= 160e3 && !endReason) {
        endReason = 'propellant exhausted, orbit decayed';
        endMonth = m;
      }
    }

    // --- delivered compute ------------------------------------------------
    // Power is the binding resource: whichever of array output or battery
    // capacity is worse sets what the racks can actually draw.
    const powerFactor = Math.min(arrayFactor, 1) * Math.min(batteryFactor, 1);
    const availability = (1 - campaign.unplannedOutage) *
      Math.min(1, design.comms.downlink.coverageFraction > 0 ? 1 : 1);

    const effective = capability * powerFactor * doseFactor * thermalFactor * availability;
    const pflops = design.compute.petaflops * effective;
    cumulativePflopYears += pflops * dtYears;

    if (!endReason && doseFraction >= 1) {
      endReason = 'radiation dose limit reached';
      endMonth = m;
    }
    // Below a quarter of design rejection the vehicle cannot hold junction
    // temperature even with the compute almost entirely shut down.
    if (!endReason && thermalFactor < 0.25) {
      endReason = 'thermal runaway — radiator coating degraded past recovery';
      endMonth = m;
    }

    rows.push({
      month: m,
      years: t,
      date,
      capability,
      arrayFactor,
      batteryFactor,
      doseFactor,
      thermalFactor,
      alphaNow,
      rejectionNow,
      effective,
      petaflops: pflops,
      cumulativePflopYears,
      altitudeKm: altitude / 1000,
      propellantRemainingKg: propRemaining,
      propellantFraction: usableProp > 0 ? propRemaining / usableProp : 0,
      cumulativeDoseKrad: cumulativeDose / 1000,
      doseFraction,
      alive: !endReason || m <= endMonth,
    });
  }

  if (!endReason) {
    endReason = 'planned end of mission';
    endMonth = months - 1;
  }

  return {
    rows,
    endReason,
    endMonth,
    endYears: endMonth * dtYears,
    finalThermalFactor: rows.length ? rows[rows.length - 1].thermalFactor : 1,
    finalAlpha: rows.length ? rows[rows.length - 1].alphaNow : coating.alpha,
    coating: coating.name,
    totalPflopYears: cumulativePflopYears,
    finalAltitudeKm: altitude / 1000,
    propellantRemainingKg: propRemaining,
    disposalReserveKg: design.mass.propellant * campaign.disposalReserve,
  };
}

// ---------------------------------------------------------------------------
// Disposal
// ---------------------------------------------------------------------------

/**
 * End-of-life disposal, and whether it complies.
 *
 * Below ~600 km drag alone brings a vehicle down inside the 5-year window, so
 * disposal costs nothing but patience. Above that it has to be flown down, and
 * the delta-v to lower perigee into the atmosphere from 800 km is around
 * 100 m/s -- small, but it has to have been reserved, and a station that spent
 * its last propellant staying up has failed a regulatory requirement rather
 * than merely ending.
 */
export function planDisposal(cfg) {
  const { altitude, ballisticCoefficient, reserveKg, dryMass, thrusterIsp = 1800 } = cfg;

  const natural = orbitalLifetime(altitude, ballisticCoefficient, { maxYears: 500 });
  const compliantNaturally = natural.decayed && natural.years <= 5;

  // Delta-v to drop perigee to 120 km from a circular orbit at `altitude`.
  const r1 = R_EARTH_EQ + altitude;
  const r2 = R_EARTH_EQ + 120e3;
  const aT = (r1 + r2) / 2;
  const vCirc = Math.sqrt(3.986004418e14 / r1);
  const vPeri = Math.sqrt(3.986004418e14 * (2 / r1 - 1 / aT));
  const deltaV = Math.abs(vCirc - vPeri);

  const propNeeded = dryMass * (Math.exp(deltaV / (thrusterIsp * G0)) - 1);

  return {
    naturalDecayYears: natural.years,
    compliantNaturally,
    deorbitDeltaV: deltaV,
    propellantNeeded: propNeeded,
    reserveKg,
    sufficient: compliantNaturally || reserveKg >= propNeeded,
    rule: 'FCC 2024: LEO disposal within 5 years of end of mission',
  };
}

// ---------------------------------------------------------------------------
// Full campaign
// ---------------------------------------------------------------------------

/**
 * Run a complete mission: design, deploy, operate, dispose, and cost it.
 *
 * @param {object} cfg
 * @param {string} cfg.name              label for reporting
 * @param {number} cfg.itPower           [W]
 * @param {number} cfg.altitude          [m]
 * @param {number} cfg.inclination       [deg]
 * @param {number} cfg.missionYears
 * @param {string} cfg.vehicleId
 * @param {string} cfg.siteId
 * @param {string} [cfg.costVehicle]     key into LAUNCH_COSTS
 * @param {object} [cfg.design]          extra designDatacenter parameters
 * @param {object} [cfg.campaign]        overrides for CAMPAIGN_DEFAULTS
 */
export function simulateMission(cfg) {
  const {
    name = 'unnamed',
    itPower,
    altitude,
    inclination,
    missionYears = 10,
    vehicleId = 'starship',
    siteId = 'ksc',
    costVehicle = 'starshipEarly',
    design: designOverrides = {},
    campaign = CAMPAIGN_DEFAULTS,
    startDate = new Date('2030-01-01T00:00:00Z'),
    autoSizeDisposal = true,
  } = cfg;

  const t0 = Date.now();

  // --- 1. design ----------------------------------------------------------
  //
  // `designDatacenter` sizes propellant for station-keeping alone, and for a
  // heavy station that is nowhere near enough. Deorbiting 370 t from 700 km
  // costs 162 m/s -- modest as delta-v goes, but against that dry mass it is
  // 3.4 tonnes of propellant, roughly forty times the station-keeping load.
  //
  // Disposal is a regulatory requirement, so the honest thing is to carry it
  // in the mass budget from the start rather than discover at end of life that
  // the tanks are empty. The loop converges in two passes: adding propellant
  // raises the dry mass, which raises the propellant needed to move it.
  const baseDesign = designDatacenter({
    itPower, altitude, inclination, missionYears, ...designOverrides,
  });

  // Disposal propellant is its own line item, not a slice of the
  // station-keeping load. Deriving it as a fraction of station-keeping is what
  // produced the original absurdity: at 700 km the drag make-up budget is a
  // few hundred kilograms, 15% of which is 91 kg, against a genuine deorbit
  // requirement of three and a half tonnes.
  let design = baseDesign;
  let disposalPropellantKg = 0;
  let disposalMassAdded = 0;

  if (autoSizeDisposal) {
    for (let pass = 0; pass < 4; pass++) {
      const dry = design.mass.total - design.mass.propellant;
      const need = planDisposal({
        altitude,
        ballisticCoefficient: design.orbit.ballisticCoefficient,
        reserveKg: disposalPropellantKg,
        dryMass: dry,
        thrusterIsp: campaign.thrusterIsp,
      });
      if (need.sufficient) break;

      // Carry the propellant plus tankage at 12% of propellant mass. Adding it
      // raises the dry mass, which raises what is needed to move it -- hence
      // the iteration, which converges in two or three passes.
      disposalPropellantKg = need.propellantNeeded;
      disposalMassAdded = disposalPropellantKg * 1.12;

      design = designDatacenter({
        itPower, altitude, inclination, missionYears, ...designOverrides,
        extraMass: (designOverrides.extraMass ?? 0) + disposalMassAdded,
      });
    }
  }

  const economics = compare(design, { launchVehicle: costVehicle });

  // --- 2. deployment ------------------------------------------------------
  const deployment = planDeployment({
    totalMass: design.mass.total,
    vehicleId, siteId, altitude, inclination, campaign, startDate,
  });

  if (!deployment.feasible) {
    return {
      name, config: cfg, design, economics, deployment,
      feasible: false,
      blockers: [deployment.reason],
      runtimeMs: Date.now() - t0,
    };
  }

  // --- 3. operations ------------------------------------------------------
  const projection = projectOperations({
    design,
    deployment,
    missionYears,
    campaign,
    solarDegradationPerYear: design.power.array.degradationPerYear ?? 0.0075,
    doseTolerance: design.radiation.tolerance.tolerance,
    doseRatePerYear: design.radiation.radPerYear,
  });

  // --- 4. disposal --------------------------------------------------------
  const disposal = {
    ...planDisposal({
      altitude: projection.finalAltitudeKm * 1000,
      ballisticCoefficient: design.orbit.ballisticCoefficient,
      reserveKg: disposalPropellantKg,
      dryMass: design.mass.total - design.mass.propellant - disposalMassAdded,
      thrusterIsp: campaign.thrusterIsp,
    }),
    disposalPropellantKg,
    massAddedForDisposal: disposalMassAdded,
    // What the disposal requirement costs as a share of the whole vehicle.
    massPenaltyFraction: disposalMassAdded / design.mass.total,
  };

  // --- 5. programme economics --------------------------------------------
  const launchPrice = LAUNCH_COSTS[costVehicle];
  const launchCost = deployment.expectedAttempts * launchPrice.listPrice;
  const totalCost = economics.orbital.total - economics.orbital.launchCost + launchCost;

  const costPerPflopYear = projection.totalPflopYears > 0
    ? totalCost / projection.totalPflopYears : Infinity;

  // The terrestrial baseline is priced over the same window and for the same
  // delivered compute, so the two are actually comparable rather than merely
  // both being large numbers.
  const terrestrialPerPflopYear = economics.terrestrial.total /
    (design.compute.petaflops * missionYears);

  // --- 6. blockers --------------------------------------------------------
  const blockers = design.issues
    .filter((i) => i.severity === 'fatal')
    .map((i) => i.message);
  if (!disposal.sufficient) {
    blockers.push(
      `Cannot dispose within the 5-year rule: needs ${Math.round(disposal.propellantNeeded)} kg ` +
      `but only ${Math.round(disposal.reserveKg)} kg is reserved.`);
  }

  return {
    name,
    config: cfg,
    feasible: blockers.length === 0,
    blockers,
    design,
    baseDesign,
    economics,
    deployment,
    projection,
    disposal,
    programme: {
      launchCost,
      totalCost,
      costPerPflopYear,
      terrestrialPerPflopYear,
      costAdvantage: terrestrialPerPflopYear / costPerPflopYear,
      totalPflopYears: projection.totalPflopYears,
      // How much of the theoretical output the mission actually delivers, once
      // the deployment ramp and every degradation mechanism are counted.
      realisedFraction: projection.totalPflopYears /
        (design.compute.petaflops * missionYears),
    },
    runtimeMs: Date.now() - t0,
  };
}

/**
 * Run several missions. Deliberately trivial -- the point is that
 * `simulateMission` is pure and independent, so this can become an agent fan-out
 * without any change to the model.
 */
export function simulateMissions(configs) {
  return configs.map((c) => simulateMission(c));
}
