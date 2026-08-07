/**
 * Orbital datacenter system model.
 *
 * Takes a compute requirement and an orbit, and returns a closed mass, power
 * and thermal budget plus every way the design fails.
 *
 * The structure of the answer, before any numbers: an orbital datacenter is
 * not a datacenter in space, it is a spacecraft that happens to compute. The
 * compute hardware is a minority of its mass. Radiators and solar arrays
 * dominate, and they scale linearly with power while the useful output also
 * scales linearly with power -- so unlike a terrestrial datacenter, there are
 * no economies of scale in the physics. Doubling the compute doubles the
 * radiator, doubles the array, and doubles the launch mass.
 */

import { R_EARTH_EQ, MU_EARTH, YEAR_JULIAN } from './constants.js';
import { orbitalPeriod, eclipseFraction, orbitalLifetime, stationKeepingDeltaV, ballisticCoefficient } from './orbit.js';
import { sizeRadiator, COATINGS } from './thermal.js';
import { sizeArray, sizeBattery, batteryCycles, SOLAR_TECH, BATTERY_TECH, distributionLosses } from './power.js';
import { annualDose, radiationVerdict, seuRate, doseLifetime, DOSE_TOLERANCE, shieldArealMass } from './radiation.js';
import { linkBudget, downlinkCapacity, slantRange, BANDS } from './comms.js';

/**
 * Compute hardware profiles.
 *
 * `specificMass` is kilograms of installed IT hardware per kilowatt of IT
 * load, at the rack level: servers, chassis, coldplates, interconnect and
 * in-rack power conversion. Dense accelerator racks land around 10-12 kg/kW;
 * conventional air-cooled enterprise racks are much worse per kilowatt because
 * their power density is lower.
 *
 * These are planning figures derived from published rack weights and power
 * ratings, not vendor specifications for any particular product.
 */
export const COMPUTE_PROFILES = {
  denseAccelerator: {
    name: 'Dense liquid-cooled accelerator rack',
    specificMass: 11.5,        // [kg/kW]
    computeDensity: 8000,      // [TFLOPS/kW] low-precision inference
    memoryPerKw: 40,           // [GB/kW] HBM + system memory
    rackPower: 120e3,          // [W] per rack
    liquidCooled: true,
  },
  generalCompute: {
    name: 'General-purpose CPU rack',
    specificMass: 55,
    computeDensity: 120,
    memoryPerKw: 130,
    rackPower: 15e3,
    liquidCooled: false,
  },
  storageHeavy: {
    name: 'Storage-optimised rack',
    specificMass: 130,
    computeDensity: 20,
    memoryPerKw: 60,
    rackPower: 8e3,
    liquidCooled: false,
  },
};

/**
 * Non-IT power overhead.
 *
 * The space analogue of PUE, but the components are different. There is no
 * chiller and no CRAC unit -- there is also no free convection, so the coolant
 * pumps work harder, and there are loads a terrestrial facility simply does
 * not have: attitude control, propulsion, communications, and thermostatic
 * heaters for everything that must not freeze during eclipse.
 */
export const DEFAULT_OVERHEAD = {
  coolantPumps: 0.04,      // fraction of IT load
  powerConversion: 0.07,   // PMAD losses, array to load
  attitudeControl: 0.01,
  communications: 0.02,
  avionicsAndHeaters: 0.02,
};

export function overheadFraction(overhead = DEFAULT_OVERHEAD) {
  return Object.values(overhead).reduce((a, b) => a + b, 0);
}

/**
 * Size a complete orbital datacenter.
 *
 * @param {object} cfg
 * @param {number} cfg.itPower              IT load [W]
 * @param {number} cfg.altitude             circular orbit altitude [m]
 * @param {number} cfg.inclination          [deg]
 * @param {number} [cfg.missionYears]
 * @param {string} [cfg.computeProfile]     key into COMPUTE_PROFILES
 * @param {string} [cfg.solarTech]          key into SOLAR_TECH
 * @param {string} [cfg.batteryTech]        key into BATTERY_TECH
 * @param {number} [cfg.betaAngle]          orbit-plane/Sun angle [rad]
 * @param {number} [cfg.shieldingMm]        aluminium equivalent shielding
 * @param {string} [cfg.electronicsClass]   key into DOSE_TOLERANCE
 * @param {number} [cfg.radiatorTempK]      radiator surface temperature
 */
export function designDatacenter(cfg) {
  const {
    itPower,
    altitude,
    inclination = 0,
    missionYears = 10,
    computeProfile = 'denseAccelerator',
    solarTech = 'rosaFlexible',
    batteryTech = 'liIonSpace',
    betaAngle = 0,
    shieldingMm = 5,
    electronicsClass = 'upscreenedCots',
    overhead = DEFAULT_OVERHEAD,
    structureFraction = 0.18,
    junctionTemp = 358.15,
    radiatorArealMass = 8,
    band = 'kaBand',
    groundStations = 6,
    transmitDiameter = 2.5,
    receiveDiameter = 13,
    transmitPower = 200,
    dragArea = null,
    /** Radiator coating, keyed into COATINGS. */
    coating = 'whitePaintZ93',
    /**
     * Size the radiator at end-of-life solar absorptivity rather than
     * beginning-of-life. Standard practice, and the difference is not small:
     * Z93 white paint darkens from alpha 0.17 to 0.30 over a mission, and a
     * radiator sized at BOL is roughly 20% short by the end of its life.
     */
    sizeForEndOfLife = true,
    /**
     * Radiator pointing, degrees from the panel normal. Perfect edge-on
     * pointing to both Sun and nadir makes the environmental load identically
     * zero, which is the ideal case and not an achievable one -- attitude error,
     * finite panel width and structural re-radiation all put flux on the panel.
     */
    radiatorSunIncidenceDeg = 78,
    radiatorTiltFromNadirDeg = 75,
    /**
     * Additional dry mass not produced by the subsystem models -- used by the
     * mission layer to carry disposal propellant, which the single-spacecraft
     * sizing has no reason to know about.
     */
    extraMass = 0,
  } = cfg;

  const compute = COMPUTE_PROFILES[computeProfile];
  const solar = SOLAR_TECH[solarTech];
  const battery = BATTERY_TECH[batteryTech];

  const orbitRadius = R_EARTH_EQ + altitude;
  const period = orbitalPeriod(orbitRadius);

  // ---- power -------------------------------------------------------------
  const ohFraction = overheadFraction(overhead);
  const totalPower = itPower * (1 + ohFraction);

  // Every watt delivered to the spacecraft ends up as heat. There is no
  // mechanical work leaving the system and no mass flow carrying enthalpy
  // away, so by conservation of energy the thermal load equals the electrical
  // load exactly. This is the single most important line in the file.
  const heatLoad = totalPower;

  const eclipseFrac = eclipseFraction(orbitRadius, betaAngle);
  const sunlitFrac = 1 - eclipseFrac;
  const eclipseSeconds = eclipseFrac * period;

  const array = sizeArray({
    requiredPower: totalPower,
    efficiency: solar.efficiency,
    sunlitFractionOfOrbit: sunlitFrac,
    roundTripEfficiency: battery.roundTripEfficiency,
    years: missionYears,
    degradationPerYear: solar.degradationPerYear,
    specificPower: solar.specificPower,
  });

  const batt = sizeBattery({
    loadPower: totalPower,
    eclipseDuration: eclipseSeconds,
    depthOfDischarge: battery.depthOfDischarge,
    specificEnergy: battery.specificEnergy,
    roundTripEfficiency: battery.roundTripEfficiency,
  });

  const cycles = batteryCycles(period, missionYears, eclipseFrac);
  const batteryLifeOk = cycles.totalCycles <= battery.cycleLife;

  const pmad = distributionLosses({ power: totalPower, busVoltage: 1000 });

  // ---- thermal -----------------------------------------------------------
  // Worst case: the radiator is sized for full sunlight, since that is when it
  // is least effective and the load is unchanged.
  const coatingSpec = COATINGS[coating] ?? COATINGS.whitePaintZ93;
  const designAlpha = sizeForEndOfLife ? coatingSpec.alphaEOL : coatingSpec.alpha;

  const radiator = sizeRadiator({
    heatLoad,
    junctionTemp,
    orbitRadius,
    sunlitFraction: 1,
    arealMass: radiatorArealMass,
    alpha: designAlpha,
    // Radiators are held as near edge-on to the Sun and to nadir as attitude
    // control allows; that is the whole reason a datacenter of this kind needs
    // active attitude control at all.
    sunIncidenceAngle: radiatorSunIncidenceDeg * (Math.PI / 180),
    tiltFromNadir: radiatorTiltFromNadirDeg * (Math.PI / 180),
  });

  // ---- mass budget -------------------------------------------------------
  const itMass = (itPower / 1000) * compute.specificMass;

  // Shielding wraps the pressurised/electronics volume. Estimate the enclosure
  // area from the IT mass at a representative packing density, then apply the
  // shield areal mass. Crude, but it captures the right scaling: shielding
  // mass grows as volume^(2/3), so it hurts small spacecraft far more.
  const itVolume = itMass / 400; // [m^3] at ~400 kg/m^3 packed rack density
  const enclosureArea = 6 * Math.pow(Math.max(itVolume, 0.1), 2 / 3);
  const shieldingMass = enclosureArea * shieldArealMass(shieldingMm);

  const subtotal =
    itMass +
    (Number.isFinite(radiator.mass) ? radiator.mass : 0) +
    array.mass +
    batt.mass +
    shieldingMass +
    extraMass;

  const structureMass = subtotal * structureFraction;

  // ---- orbit maintenance -------------------------------------------------
  // Drag area: the solar arrays and radiators dominate it, and they are huge.
  // A spacecraft with 250000 m^2 of array has a terrible ballistic
  // coefficient no matter how heavy it is.
  const effectiveDragArea = dragArea ?? 0.25 * (array.area + (Number.isFinite(radiator.area) ? radiator.area : 0));
  const dryMassEstimate = subtotal + structureMass;
  const ballistic = ballisticCoefficient(dryMassEstimate, 2.2, Math.max(effectiveDragArea, 1));

  const keeping = stationKeepingDeltaV(altitude, ballistic);
  const stationKeepingDv = keeping.perYear * missionYears;

  // Electric propulsion: high Isp keeps the propellant fraction sane.
  const thrusterIsp = 1800;
  const propellantMass =
    dryMassEstimate * (Math.exp(stationKeepingDv / (thrusterIsp * 9.80665)) - 1);
  const propulsionDryMass = Math.max(50, propellantMass * 0.25);

  const totalMass = dryMassEstimate + propellantMass + propulsionDryMass;

  const decay = orbitalLifetime(altitude, ballistic, { maxYears: 500 });

  // ---- radiation ---------------------------------------------------------
  const radVerdict = radiationVerdict(altitude, inclination, shieldingMm);
  const tolerance = DOSE_TOLERANCE[electronicsClass];
  const radLifeYears = doseLifetime(radVerdict.radPerYear, tolerance.tolerance);

  const memoryBytes = (itPower / 1000) * compute.memoryPerKw * 1e9;
  const seu = seuRate({ memoryBytes, altitude, inclination, shieldingMm });

  // ---- communications ----------------------------------------------------
  const bandCfg = BANDS[band];
  const range = slantRange(orbitRadius, 10);
  const link = linkBudget({
    transmitPower,
    transmitDiameter,
    receiveDiameter,
    distance: range,
    frequency: bandCfg.frequency,
    bandwidth: bandCfg.maxBandwidth,
    rainMarginDb: bandCfg.rainMarginDb,
  });
  const downlink = downlinkCapacity({
    orbitRadius,
    peakRateBps: link.achievableRateBps,
    stationCount: groundStations,
  });

  // ---- compute output ----------------------------------------------------
  const petaflops = ((itPower / 1000) * compute.computeDensity) / 1000;
  const rackCount = itPower / compute.rackPower;

  // ---- failure modes -----------------------------------------------------
  const issues = [];
  if (!radiator.feasible) {
    issues.push({
      severity: 'fatal',
      subsystem: 'thermal',
      message: radiator.reason,
    });
  }
  if (decay.decayed && decay.years < missionYears) {
    // A short unpowered decay life is not automatically fatal -- the vehicle
    // carries propellant precisely to hold station against it. What matters is
    // whether that propellant is a sane fraction of the vehicle, and what the
    // consequence of losing propulsion is.
    //
    // Reporting this as fatal regardless was wrong: it condemned designs that
    // hold altitude comfortably for their whole mission, while saying nothing
    // about the ones where station-keeping quietly eats a third of the launch
    // mass. The propellant fraction is the real discriminator.
    const propellantFraction = propellantMass / totalMass;
    const survivable = propellantFraction < 0.25;

    issues.push({
      severity: survivable ? 'warning' : 'fatal',
      subsystem: 'orbit',
      message: survivable
        ? `Unpowered, drag brings this vehicle down in ${decay.years.toFixed(1)} years — ` +
          `less than the ${missionYears}-year mission — so it must thrust continuously. ` +
          `The ${Math.round(propellantMass)} kg propellant load covers that ` +
          `(${(propellantFraction * 100).toFixed(1)}% of launch mass), but any loss of ` +
          `propulsion is unrecoverable within ${decay.years.toFixed(1)} years. Ballistic ` +
          `coefficient is ${ballistic.toFixed(1)} kg/m^2 against ` +
          `${Math.round(effectiveDragArea)} m^2 of drag area.`
        : `Drag would deorbit this vehicle in ${decay.years.toFixed(1)} years and holding ` +
          `altitude costs ${Math.round(propellantMass)} kg — ` +
          `${(propellantFraction * 100).toFixed(0)}% of launch mass. At that point the ` +
          `vehicle is mostly a propellant tank; fly higher or cut the ` +
          `${Math.round(effectiveDragArea)} m^2 of drag area.`,
    });
  }
  if (radLifeYears < missionYears) {
    issues.push({
      severity: radLifeYears < missionYears / 3 ? 'fatal' : 'warning',
      subsystem: 'radiation',
      message:
        `${tolerance.name} reaches its total-dose limit in ${radLifeYears.toFixed(1)} years ` +
        `at ${radVerdict.kradPerYear.toFixed(1)} krad/year. ${radVerdict.verdict}`,
    });
  }
  if (!batteryLifeOk) {
    issues.push({
      severity: 'warning',
      subsystem: 'power',
      message:
        `${Math.round(cycles.totalCycles)} charge cycles exceeds the ${battery.cycleLife} ` +
        `cycle rating. Battery replacement or a higher-altitude/dawn-dusk orbit is needed.`,
    });
  }
  if (!link.closed) {
    issues.push({
      severity: 'fatal',
      subsystem: 'comms',
      message: `Downlink does not close: ${link.linkMarginDb.toFixed(1)} dB margin.`,
    });
  }
  if (pmad.warning) {
    issues.push({ severity: 'warning', subsystem: 'power', message: pmad.warning });
  }
  if (stationKeepingDv > 2000) {
    issues.push({
      severity: 'warning',
      subsystem: 'propulsion',
      message: `${Math.round(stationKeepingDv)} m/s of station-keeping over the mission is a large propellant burden.`,
    });
  }

  return {
    inputs: { itPower, altitude, inclination, missionYears, computeProfile, solarTech, betaAngle, shieldingMm },
    orbit: {
      radius: orbitRadius,
      period,
      eclipseFraction: eclipseFrac,
      eclipseSeconds,
      sunlitFraction: sunlitFrac,
      ballisticCoefficient: ballistic,
      dragArea: effectiveDragArea,
      decayYears: decay.years,
      decayed: decay.decayed,
      stationKeepingDvPerYear: keeping.perYear,
      stationKeepingDvTotal: stationKeepingDv,
    },
    power: {
      itPower,
      overheadFraction: ohFraction,
      totalPower,
      array,
      battery: batt,
      cycles,
      batteryLifeOk,
      pmad,
    },
    thermal: {
      heatLoad, ...radiator,
      coating: coatingSpec.name,
      designAlpha,
      sizedForEndOfLife: sizeForEndOfLife,
      sunIncidenceDeg: radiatorSunIncidenceDeg,
      tiltFromNadirDeg: radiatorTiltFromNadirDeg,
    },
    mass: {
      it: itMass,
      radiator: Number.isFinite(radiator.mass) ? radiator.mass : Infinity,
      solarArray: array.mass,
      battery: batt.mass,
      shielding: shieldingMass,
      structure: structureMass,
      propellant: propellantMass,
      propulsion: propulsionDryMass,
      total: totalMass,
      breakdown: [
        ['Compute hardware', itMass],
        ['Radiators', Number.isFinite(radiator.mass) ? radiator.mass : 0],
        ['Solar arrays', array.mass],
        ['Batteries', batt.mass],
        ['Shielding', shieldingMass],
        ['Structure', structureMass],
        ['Propulsion + propellant', propellantMass + propulsionDryMass + extraMass],
      ],
    },
    radiation: { ...radVerdict, lifetimeYears: radLifeYears, tolerance, seu },
    comms: { band: bandCfg, link, downlink, slantRange: range },
    compute: {
      profile: compute,
      petaflops,
      rackCount,
      memoryBytes,
      petaflopsPerTonne: petaflops / (totalMass / 1000),
      wattsPerPetaflop: totalPower / Math.max(petaflops, 1e-9),
    },
    issues,
    viable: !issues.some((i) => i.severity === 'fatal'),
  };
}

/**
 * Launch campaign required to deploy a design.
 *
 * Splits total mass across launches of a chosen vehicle. Deliberately reports
 * the number of launches rather than hiding it in a cost: an 8 GW constellation
 * needing four thousand Starship flights is a schedule problem long before it
 * is a money problem.
 */
export function launchCampaign({ totalMass, vehiclePayload, vehicleName, launchesPerYear = 12 }) {
  const launches = Math.ceil(totalMass / vehiclePayload);
  return {
    launches,
    vehicleName,
    vehiclePayload,
    massPerLaunch: totalMass / launches,
    campaignYears: launches / launchesPerYear,
    launchesPerYear,
  };
}
