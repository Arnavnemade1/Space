/**
 * Spacecraft thermal control.
 *
 * This module is the one that decides whether an orbital datacenter is a
 * serious idea, so it is worth being blunt about the physics up front.
 *
 * In a vacuum there is no convection and no conduction to anywhere. The ONLY
 * way to remove heat is to radiate it, and radiated power goes as T^4 times
 * area. A terrestrial datacenter dumps heat into air or water at ~300 K with
 * heat transfer coefficients of hundreds to thousands of W/(m^2 K); a radiator
 * at 350 K dumps about 1.5 kW/m^2 into deep space, total, no matter how hard
 * you pump. That single fact sets the size of everything.
 *
 * Sign convention: all fluxes in W/m^2, all temperatures in kelvin, all areas
 * in m^2. Absorptivity `alpha` applies to the solar spectrum, emissivity
 * `epsilon` to the infrared. They are different numbers for real coatings and
 * the ratio alpha/epsilon is the whole game in passive thermal design.
 */

import {
  SIGMA_SB,
  SOLAR_CONSTANT,
  EARTH_ALBEDO,
  EARTH_IR_FLUX,
  R_EARTH_EQ,
  T_CMB,
} from './constants.js';

/**
 * Common thermal control coatings.
 * `alpha` = solar absorptivity, `epsilon` = infrared emissivity.
 * Beginning-of-life values; alpha degrades upward with UV and atomic oxygen
 * exposure, typically by 0.05-0.15 over years, which is why `alphaEOL` is
 * carried separately.
 */
export const COATINGS = {
  whitePaintZ93: { name: 'Z93 white paint', alpha: 0.17, epsilon: 0.92, alphaEOL: 0.30 },
  silveredTeflon: { name: 'Silvered Teflon (OSR)', alpha: 0.08, epsilon: 0.80, alphaEOL: 0.16 },
  blackPaint: { name: 'Black paint', alpha: 0.95, epsilon: 0.90, alphaEOL: 0.96 },
  bareAluminium: { name: 'Bare aluminium', alpha: 0.15, epsilon: 0.05, alphaEOL: 0.20 },
  mliOuter: { name: 'MLI outer layer (Kapton)', alpha: 0.40, epsilon: 0.63, alphaEOL: 0.55 },
};

/**
 * View factor from a flat plate to the Earth, as a function of orbital radius
 * and the angle between the plate normal and the nadir direction.
 *
 * For a plate facing directly at Earth's centre the view factor is
 * F = (R_e / r)^2, the fraction of the hemisphere Earth subtends. The cosine
 * term handles tilt; a radiator edge-on to Earth (90 deg) sees essentially
 * none of it, which is exactly how you want to orient one.
 *
 * @param {number} orbitRadius distance from Earth's centre [m]
 * @param {number} tiltFromNadir angle between plate normal and nadir [rad]
 */
export function earthViewFactor(orbitRadius, tiltFromNadir = 0) {
  const f = (R_EARTH_EQ / orbitRadius) ** 2;
  return Math.max(0, f * Math.cos(tiltFromNadir));
}

/**
 * Environmental heat flux absorbed by one side of a radiator panel [W/m^2].
 *
 * Three sources, and they do not all scale the same way:
 *   - direct solar: attenuated by cos(incidence), absorbed at `alpha`
 *   - Earth albedo: reflected sunlight, absorbed at `alpha` (it is still
 *     solar-spectrum light), only when that part of Earth is lit
 *   - Earth infrared: emitted by the planet at ~255 K, absorbed at `epsilon`
 *     because it is in the infrared band
 *
 * Conflating albedo and IR into one number is a common shortcut and it is
 * wrong by a factor of several for a low-alpha, high-epsilon radiator coating,
 * which is precisely the coating a radiator uses.
 */
export function environmentalFlux({
  orbitRadius,
  alpha,
  epsilon,
  sunIncidenceAngle = Math.PI / 2, // pi/2 = edge-on to the Sun
  tiltFromNadir = Math.PI / 2,     // pi/2 = edge-on to Earth
  sunlitFraction = 1,
  solarConstant = SOLAR_CONSTANT,
  albedo = EARTH_ALBEDO,
  earthIr = EARTH_IR_FLUX,
}) {
  const cosSun = Math.max(0, Math.cos(sunIncidenceAngle));
  const viewEarth = earthViewFactor(orbitRadius, tiltFromNadir);

  const direct = alpha * solarConstant * cosSun * sunlitFraction;
  const albedoFlux = alpha * solarConstant * albedo * viewEarth * sunlitFraction;
  const irFlux = epsilon * earthIr * viewEarth;

  return {
    direct,
    albedo: albedoFlux,
    earthIr: irFlux,
    total: direct + albedoFlux + irFlux,
  };
}

/**
 * Net heat rejected per square metre of radiator [W/m^2].
 *
 * Q/A = n_sides * epsilon * sigma * (T_r^4 - T_cmb^4) - absorbed_environment
 *
 * The deep-space term is included for completeness; at 2.7 K it contributes
 * 3e-6 W/m^2 and is utterly negligible against a 350 K radiator. It is the
 * environmental backload, not the cosmic microwave background, that matters.
 *
 * @param {number} radiatorTemp [K]
 * @param {object} opts
 */
export function radiatorFluxPerArea(radiatorTemp, opts = {}) {
  const {
    epsilon = 0.90,
    sides = 2,
    environmentPerSide = 0,
    sinkTemp = T_CMB,
  } = opts;

  const emitted = sides * epsilon * SIGMA_SB * (radiatorTemp ** 4 - sinkTemp ** 4);
  const absorbed = sides * environmentPerSide;
  return emitted - absorbed;
}

/**
 * Radiator area required to reject a given heat load [m^2].
 *
 * Returns Infinity when the radiator cannot reject anything at that
 * temperature in that environment -- a real and important failure mode. A
 * 300 K radiator staring at a sunlit Earth absorbs more than it emits, and no
 * amount of area fixes that; the answer is to run hotter or point elsewhere.
 *
 * @param {number} heatLoad [W]
 * @param {number} radiatorTemp [K]
 */
export function radiatorArea(heatLoad, radiatorTemp, opts = {}) {
  const perArea = radiatorFluxPerArea(radiatorTemp, opts);
  if (perArea <= 0) return Infinity;
  return heatLoad / perArea;
}

/**
 * Equilibrium temperature of a passive surface with no internal dissipation.
 * Solves alpha * S_absorbed = epsilon * sigma * T^4 for T.
 */
export function equilibriumTemperature(absorbedFlux, epsilon, sides = 2) {
  if (absorbedFlux <= 0) return T_CMB;
  return Math.pow(absorbedFlux / (sides * epsilon * SIGMA_SB), 0.25);
}

/**
 * Full radiator sizing for a datacenter thermal load.
 *
 * Models the temperature chain that actually exists in a liquid-cooled system:
 *
 *   junction -> case -> coldplate -> coolant -> radiator root -> radiator fin
 *
 * Each link needs a temperature drop to push heat across it, and the radiator
 * ends up substantially cooler than the chip. Since rejection goes as T^4,
 * those drops are expensive: a 40 K total drop from a 358 K junction costs
 * about 35% of the rejection capability. Sizing a radiator at chip temperature
 * -- a common shortcut -- undersizes it by roughly a third.
 *
 * @param {object} cfg
 * @param {number} cfg.heatLoad            total waste heat [W]
 * @param {number} [cfg.junctionTemp]      max allowable silicon junction temp [K]
 * @param {number} [cfg.junctionToCoolant] dT from junction to coolant [K]
 * @param {number} [cfg.coolantToRadiator] dT from coolant to radiator surface [K]
 * @param {number} [cfg.radiatorEfficiency] fin efficiency, 0..1
 */
export function sizeRadiator(cfg) {
  const {
    heatLoad,
    junctionTemp = 358.15,        // 85 C, a typical server-CPU limit
    junctionToCoolant = 25,       // through package + coldplate
    coolantToRadiator = 15,       // pumped loop + manifold + fin root
    radiatorEfficiency = 0.85,    // fin efficiency
    epsilon = 0.90,
    sides = 2,
    orbitRadius = R_EARTH_EQ + 500e3,
    alpha = 0.17,
    sunIncidenceAngle = Math.PI / 2,
    tiltFromNadir = Math.PI / 2,
    sunlitFraction = 1,
    arealMass = 8,               // [kg/m^2] deployable radiator, structure included
  } = cfg;

  const radiatorTemp = junctionTemp - junctionToCoolant - coolantToRadiator;

  const env = environmentalFlux({
    orbitRadius,
    alpha,
    epsilon,
    sunIncidenceAngle,
    tiltFromNadir,
    sunlitFraction,
  });

  const grossPerArea = sides * epsilon * SIGMA_SB * (radiatorTemp ** 4 - T_CMB ** 4);
  const netPerArea = (grossPerArea - sides * env.total) * radiatorEfficiency;

  if (netPerArea <= 0) {
    return {
      feasible: false,
      radiatorTemp,
      grossPerArea,
      environmentPerArea: sides * env.total,
      netPerArea,
      area: Infinity,
      mass: Infinity,
      environment: env,
      reason:
        'Radiator absorbs more from its environment than it can emit at this ' +
        'temperature. Run hotter, use a lower alpha/epsilon coating, or point ' +
        'the panels away from the Sun and Earth.',
    };
  }

  const area = heatLoad / netPerArea;

  return {
    feasible: true,
    radiatorTemp,
    grossPerArea,
    environmentPerArea: sides * env.total,
    netPerArea,
    area,
    mass: area * arealMass,
    environment: env,
    // A useful sanity figure: how many football pitches (7140 m^2) this is.
    areaFootballPitches: area / 7140,
  };
}

/**
 * Transient temperature response of a lumped thermal mass.
 *
 * dT/dt = (Q_in - Q_radiated) / (m * cp)
 *
 * Used to answer "what happens during a 35-minute eclipse" and "how fast does
 * this thing overheat if the coolant pumps stop". The answer to the second is
 * usually "alarmingly fast": a 100 t structure at 1 kJ/(kg K) absorbing 10 MW
 * heats at 0.1 K/s, so a chip goes from 60 C to its 85 C limit in about four
 * minutes with no cooling at all.
 *
 * @param {number} temperature current [K]
 * @param {number} heatIn [W]
 * @param {number} thermalMass m*cp [J/K]
 * @param {number} radiatorArea [m^2]
 * @param {number} dt [s]
 */
export function thermalStep(temperature, heatIn, thermalMass, radiatorAreaM2, dt, opts = {}) {
  const { epsilon = 0.9, sides = 2, environmentPerSide = 0 } = opts;
  const radiated =
    radiatorAreaM2 *
    (sides * epsilon * SIGMA_SB * (temperature ** 4 - T_CMB ** 4) - sides * environmentPerSide);
  const dT = ((heatIn - radiated) / thermalMass) * dt;
  return { temperature: temperature + dT, radiated, netPower: heatIn - radiated };
}

/**
 * Time for a thermal mass to rise from one temperature to another with cooling
 * lost entirely [s]. Integrates the lumped equation with radiation included.
 */
export function timeToOverheat(cfg) {
  const {
    heatLoad,
    thermalMass,
    startTemp = 313,
    limitTemp = 358.15,
    passiveArea = 0,
    epsilon = 0.9,
  } = cfg;

  let T = startTemp;
  let t = 0;
  const dt = 0.5;
  while (T < limitTemp && t < 86400) {
    const radiated = passiveArea * 2 * epsilon * SIGMA_SB * (T ** 4 - T_CMB ** 4);
    const net = heatLoad - radiated;
    if (net <= 0) return { seconds: Infinity, equilibrium: T, survives: true };
    T += (net / thermalMass) * dt;
    t += dt;
  }
  return { seconds: t, equilibrium: null, survives: t >= 86400 };
}
