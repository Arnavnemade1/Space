/**
 * Cost model and terrestrial comparison.
 *
 * Costs are the softest numbers in this simulator -- softer even than the
 * radiation model, because they are commercial rather than physical and they
 * move year to year. Everything here is a named, editable assumption rather
 * than a buried constant, and the comparison function reports the breakeven
 * conditions rather than a single verdict, because which side wins depends
 * almost entirely on the launch price assumed.
 */

/**
 * Published or widely reported launch prices, in US dollars per kilogram to
 * low Earth orbit. List prices, not marginal cost -- an operator flying its
 * own payload pays considerably less than it charges.
 */
export const LAUNCH_COSTS = {
  falcon9: { name: 'Falcon 9 (reusable)', pricePerKg: 2900, payload: 17500, listPrice: 69.75e6 },
  falconHeavy: { name: 'Falcon Heavy', pricePerKg: 1500, payload: 63800, listPrice: 97e6 },
  starshipTarget: { name: 'Starship (stated target)', pricePerKg: 200, payload: 100000, listPrice: 20e6, speculative: true },
  starshipEarly: { name: 'Starship (early operations estimate)', pricePerKg: 1000, payload: 100000, listPrice: 100e6, speculative: true },
  electron: { name: 'Electron', pricePerKg: 25000, payload: 320, listPrice: 8e6 },
  newGlenn: { name: 'New Glenn', pricePerKg: 1500, payload: 45000, listPrice: 68e6, speculative: true },
  vulcan: { name: 'Vulcan Centaur', pricePerKg: 4000, payload: 27200, listPrice: 110e6 },
  ariane6: { name: 'Ariane 64', pricePerKg: 5500, payload: 21650, listPrice: 115e6 },
  slsBlock1: { name: 'SLS Block 1', pricePerKg: 23000, payload: 95000, listPrice: 2.2e9 },
};

/**
 * Hardware and operations cost assumptions.
 * `perKwIt` figures are capital cost per kilowatt of IT load.
 */
export const COST_ASSUMPTIONS = {
  computeHardwarePerKw: 45000,      // [$/kW] dense accelerator hardware
  spaceQualificationMultiplier: 2.5, // ruggedising, testing, derating
  radiatorPerKg: 3000,              // [$/kg] deployable radiator
  solarArrayPerW: 150,              // [$/W] space-qualified array, BOL
  batteryPerKwh: 1500,              // [$/kWh] space-qualified
  structurePerKg: 2000,             // [$/kg]
  integrationFraction: 0.35,        // integration & test, as a fraction of hardware
  groundSegmentPerStation: 12e6,    // [$] per ground station
  operationsPerYear: 25e6,          // [$/year] mission operations
  insuranceRate: 0.07,              // fraction of launched value
};

/**
 * Terrestrial datacenter reference costs, for the comparison.
 * Hyperscale build costs are commonly quoted in the $9-12 M per MW of IT load
 * range for the facility, plus the IT hardware itself.
 */
export const TERRESTRIAL = {
  facilityCapexPerMw: 10e6,     // [$/MW IT] shell, power, cooling
  computeHardwarePerKw: 45000,  // [$/kW] same silicon, no space premium
  pue: 1.15,                    // modern hyperscale
  electricityPerKwh: 0.07,      // [$/kWh] industrial, large contract
  maintenancePerMwYear: 250e3,  // [$/MW/year]
  hardwareRefreshYears: 4,
  waterLitresPerKwh: 1.8,
};

/**
 * Total cost of an orbital datacenter design over its mission.
 *
 * @param {object} design result from designDatacenter()
 * @param {object} cfg
 * @param {string} cfg.launchVehicle key into LAUNCH_COSTS
 */
export function orbitalCost(design, cfg = {}) {
  const {
    launchVehicle = 'starshipEarly',
    assumptions = COST_ASSUMPTIONS,
    groundStations = 6,
    includeInsurance = true,
  } = cfg;

  const launch = LAUNCH_COSTS[launchVehicle];
  const itKw = design.power.itPower / 1000;
  const years = design.inputs.missionYears;

  const hardware = {
    compute: itKw * assumptions.computeHardwarePerKw * assumptions.spaceQualificationMultiplier,
    radiator: (Number.isFinite(design.mass.radiator) ? design.mass.radiator : 0) * assumptions.radiatorPerKg,
    solarArray: design.power.array.beginningOfLifePower * assumptions.solarArrayPerW,
    battery: (design.power.battery.packEnergyWh / 1000) * assumptions.batteryPerKwh,
    structure: (design.mass.structure + design.mass.shielding) * assumptions.structurePerKg,
  };
  const hardwareTotal = Object.values(hardware).reduce((a, b) => a + b, 0);
  const integration = hardwareTotal * assumptions.integrationFraction;

  const launchesNeeded = Math.ceil(design.mass.total / launch.payload);
  const launchCost = launchesNeeded * launch.listPrice;

  const groundSegment = groundStations * assumptions.groundSegmentPerStation;
  const operations = assumptions.operationsPerYear * years;
  const insurance = includeInsurance
    ? (hardwareTotal + integration) * assumptions.insuranceRate
    : 0;

  const total = hardwareTotal + integration + launchCost + groundSegment + operations + insurance;

  // No hardware refresh is possible in orbit without a servicing architecture,
  // which is itself an unsolved problem at this scale. A terrestrial facility
  // replaces its silicon every few years; an orbital one flies whatever it
  // launched with until the mission ends. That asymmetry is worth stating
  // explicitly rather than burying in a discount rate.
  const refreshCyclesForegone = Math.floor(years / TERRESTRIAL.hardwareRefreshYears);

  return {
    hardware,
    hardwareTotal,
    integration,
    launchesNeeded,
    launchCost,
    launchVehicle: launch,
    groundSegment,
    operations,
    insurance,
    total,
    perKwIt: total / itKw,
    perPetaflopYear: total / (design.compute.petaflops * years),
    launchFraction: launchCost / total,
    refreshCyclesForegone,
  };
}

/**
 * Equivalent terrestrial datacenter cost over the same period.
 * Includes electricity, which the orbital version genuinely avoids -- that is
 * the real economic argument for orbit, and it deserves to be counted fairly.
 */
export function terrestrialCost({ itPowerW, years, params = TERRESTRIAL }) {
  const itKw = itPowerW / 1000;
  const itMw = itKw / 1000;

  const facility = itMw * params.facilityCapexPerMw;
  const hardwareUnits = 1 + Math.floor(years / params.hardwareRefreshYears);
  const compute = itKw * params.computeHardwarePerKw * hardwareUnits;

  const totalPowerKw = itKw * params.pue;
  const energyKwh = totalPowerKw * 24 * 365.25 * years;
  const electricity = energyKwh * params.electricityPerKwh;

  const maintenance = itMw * params.maintenancePerMwYear * years;

  return {
    facility,
    compute,
    hardwareRefreshes: hardwareUnits - 1,
    electricity,
    energyKwh,
    maintenance,
    waterLitres: energyKwh * params.waterLitresPerKwh,
    total: facility + compute + electricity + maintenance,
    perKwIt: (facility + compute + electricity + maintenance) / itKw,
  };
}

/**
 * Compare the two and report what would have to be true for orbit to win.
 *
 * Rather than declaring a winner, this solves for the launch price at which
 * the totals are equal. That is the honest form of the answer, because the
 * launch price is both the dominant term and the most uncertain one.
 */
export function compare(design, cfg = {}) {
  const orbital = orbitalCost(design, cfg);
  const terrestrial = terrestrialCost({
    itPowerW: design.power.itPower,
    years: design.inputs.missionYears,
  });

  const ratio = orbital.total / terrestrial.total;

  // Solve for the launch cost that equalises the two totals.
  const nonLaunchOrbital = orbital.total - orbital.launchCost;
  const launchBudgetForParity = terrestrial.total - nonLaunchOrbital;
  const breakevenPricePerKg =
    launchBudgetForParity > 0 ? launchBudgetForParity / design.mass.total : 0;

  return {
    orbital,
    terrestrial,
    ratio,
    orbitalCheaper: orbital.total < terrestrial.total,
    breakevenLaunchPricePerKg: breakevenPricePerKg,
    currentLaunchPricePerKg: orbital.launchCost / design.mass.total,
    verdict:
      breakevenPricePerKg <= 0
        ? 'Orbit cannot reach parity at any launch price: the non-launch costs alone exceed the terrestrial total.'
        : `Parity requires launch at $${Math.round(breakevenPricePerKg)}/kg, against ` +
          `$${Math.round(orbital.launchCost / design.mass.total)}/kg assumed here.`,
    // The comparison the physics actually favours.
    notes: [
      'Orbital avoids all electricity cost and all cooling water.',
      'Orbital cannot refresh hardware; terrestrial replaces silicon every ~4 years.',
      'Terrestrial figures exclude grid interconnection delays, which are the ' +
        'real constraint on new capacity in many markets and are not a cost line.',
    ],
  };
}

/**
 * Cost per unit of delivered compute, the figure that makes designs comparable
 * across very different power levels.
 */
export function costPerCompute(design, costResult) {
  const petaflopYears = design.compute.petaflops * design.inputs.missionYears;
  return {
    perPetaflopYear: costResult.total / petaflopYears,
    perGpuHourEquivalent:
      costResult.total / (design.compute.rackCount * 72 * design.inputs.missionYears * 8766),
  };
}
