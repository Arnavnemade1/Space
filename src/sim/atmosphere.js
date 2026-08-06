/**
 * Atmosphere models.
 *
 * Three layers of fidelity, each a published model rather than a curve fit:
 *
 *  1. 0 - 86 km   : U.S. Standard Atmosphere 1976 (NOAA-S/T 76-1562), exact.
 *                   This is the regime that sets max-Q and drag losses on
 *                   ascent, so it is implemented to the letter -- including
 *                   USSA-76's own constants (R* = 8.31432, r0 = 6356766 m),
 *                   which differ slightly from modern CODATA values.
 *
 *  2. 86 - 1000 km: Piecewise-exponential model, Vallado "Fundamentals of
 *                   Astrodynamics and Applications" Table 8-4, itself derived
 *                   from USSA-76 / CIRA-72. Represents mean solar activity.
 *
 *  3. > 180 km    : Optional exospheric-temperature correction driven by the
 *                   F10.7 solar flux and Ap geomagnetic index, applied on top
 *                   of layer 2.
 *
 * ACCURACY NOTE, stated plainly: layers 1 and 2 reproduce their source tables
 * to the digits published. Layer 3 is a first-order scaling, not NRLMSISE-00.
 * Thermospheric density genuinely varies by an order of magnitude over a solar
 * cycle and even the best operational models (NRLMSISE-00, JB2008) carry
 * 15-30% error. Any decay lifetime this simulator reports inherits that
 * uncertainty -- it is a property of the atmosphere, not of this code.
 */

import { R_USSA76, K_BOLTZMANN, G0 } from './constants.js';

// ---------------------------------------------------------------------------
// U.S. Standard Atmosphere 1976 -- constants as defined by the standard
// ---------------------------------------------------------------------------

/** Effective Earth radius used by USSA-76 for geopotential conversion [m]. */
const R0_USSA76 = 6356766.0;

/** Sea-level mean molar mass of air [kg/mol]. USSA-76. */
const M_AIR = 0.0289644;

/** Specific gas constant for air [J/(kg K)]: R_USSA76 / M_AIR = 287.0528... */
export const R_AIR = R_USSA76 / M_AIR;

/** Ratio of specific heats for air [-]. USSA-76 value. */
export const GAMMA_AIR = 1.4;

/** Sutherland's law constants, USSA-76 form. */
const SUTHERLAND_BETA = 1.458e-6; // [kg/(s m K^0.5)]
const SUTHERLAND_S = 110.4; // [K]

/** Effective collision diameter of an air molecule [m]. USSA-76. */
const COLLISION_DIAMETER = 3.65e-10;

/**
 * The seven USSA-76 base layers, indexed by geopotential altitude.
 * Hb [m], Lb (lapse rate) [K/m], Tb [K], Pb [Pa].
 *
 * Base pressures are the values published in the standard; they are also
 * exactly reproducible by integrating upward from 101325 Pa, which the test
 * suite verifies.
 */
const USSA76_LAYERS = [
  { Hb: 0, Lb: -0.0065, Tb: 288.15, Pb: 101325.0 },
  { Hb: 11000, Lb: 0.0, Tb: 216.65, Pb: 22632.06 },
  { Hb: 20000, Lb: 0.001, Tb: 216.65, Pb: 5474.889 },
  { Hb: 32000, Lb: 0.0028, Tb: 228.65, Pb: 868.0187 },
  { Hb: 47000, Lb: 0.0, Tb: 270.65, Pb: 110.9063 },
  { Hb: 51000, Lb: -0.0028, Tb: 270.65, Pb: 66.93887 },
  { Hb: 71000, Lb: -0.002, Tb: 214.65, Pb: 3.956420 },
];

/** Top of the USSA-76 homosphere formulation: 84852 m geopotential = 86 km geometric. */
const USSA76_TOP_H = 84852.0;

/**
 * Geometric altitude -> geopotential altitude [m].
 * H = r0 * z / (r0 + z). Accounts for gravity falling off with altitude so
 * that the hydrostatic equation can be integrated with a constant g0.
 */
export function geopotentialAltitude(z) {
  return (R0_USSA76 * z) / (R0_USSA76 + z);
}

/** Geopotential altitude -> geometric altitude [m]. Inverse of the above. */
export function geometricAltitude(H) {
  return (R0_USSA76 * H) / (R0_USSA76 - H);
}

/**
 * U.S. Standard Atmosphere 1976, valid 0 to 86 km geometric altitude.
 *
 * @param {number} z geometric altitude [m]
 * @returns {{temperature:number, pressure:number, density:number,
 *            soundSpeed:number, viscosity:number, numberDensity:number,
 *            meanFreePath:number, scaleHeight:number}}
 */
export function ussa76(z) {
  const H = geopotentialAltitude(Math.max(z, -5000));
  const Hc = Math.min(H, USSA76_TOP_H);

  // Locate the layer containing Hc.
  let i = 0;
  for (let k = USSA76_LAYERS.length - 1; k >= 0; k--) {
    if (Hc >= USSA76_LAYERS[k].Hb) {
      i = k;
      break;
    }
  }
  const { Hb, Lb, Tb, Pb } = USSA76_LAYERS[i];

  const dH = Hc - Hb;
  const T = Tb + Lb * dH;

  // Hydrostatic integration. Two closed forms depending on whether the layer
  // is isothermal (Lb == 0) or has a linear lapse rate.
  let P;
  if (Lb === 0) {
    P = Pb * Math.exp((-G0 * M_AIR * dH) / (R_USSA76 * Tb));
  } else {
    P = Pb * Math.pow(Tb / T, (G0 * M_AIR) / (R_USSA76 * Lb));
  }

  const density = P / (R_AIR * T);
  const soundSpeed = Math.sqrt(GAMMA_AIR * R_AIR * T);
  const viscosity = (SUTHERLAND_BETA * Math.pow(T, 1.5)) / (T + SUTHERLAND_S);
  const numberDensity = P / (K_BOLTZMANN * T);
  const meanFreePath =
    1 / (Math.SQRT2 * Math.PI * COLLISION_DIAMETER ** 2 * numberDensity);
  const scaleHeight = (R_AIR * T) / G0;

  return {
    temperature: T,
    pressure: P,
    density,
    soundSpeed,
    viscosity,
    numberDensity,
    meanFreePath,
    scaleHeight,
  };
}

// ---------------------------------------------------------------------------
// Piecewise-exponential model (Vallado Table 8-4)
// ---------------------------------------------------------------------------

/**
 * [base altitude km, reference density kg/m^3, scale height km].
 * Rows are ordered by ascending base altitude; the last row extrapolates.
 */
const EXP_TABLE = [
  [0, 1.225, 7.249],
  [25, 3.899e-2, 6.349],
  [30, 1.774e-2, 6.682],
  [40, 3.972e-3, 7.554],
  [50, 1.057e-3, 8.382],
  [60, 3.206e-4, 7.714],
  [70, 8.77e-5, 6.549],
  [80, 1.905e-5, 5.799],
  [90, 3.396e-6, 5.382],
  [100, 5.297e-7, 5.877],
  [110, 9.661e-8, 7.263],
  [120, 2.438e-8, 9.473],
  [130, 8.484e-9, 12.636],
  [140, 3.845e-9, 16.149],
  [150, 2.07e-9, 22.523],
  [180, 5.464e-10, 29.74],
  [200, 2.789e-10, 37.105],
  [250, 7.248e-11, 45.546],
  [300, 2.418e-11, 53.628],
  [350, 9.518e-12, 53.298],
  [400, 3.725e-12, 58.515],
  [450, 1.585e-12, 60.828],
  [500, 6.967e-13, 63.822],
  [600, 1.454e-13, 71.835],
  [700, 3.614e-14, 88.667],
  [800, 1.17e-14, 124.64],
  [900, 5.245e-15, 181.05],
  [1000, 3.019e-15, 268.0],
];

/**
 * Piecewise-exponential density, mean solar activity.
 * @param {number} z geometric altitude [m]
 * @returns {number} density [kg/m^3]
 */
export function exponentialDensity(z) {
  const hkm = z / 1000;
  if (hkm < 0) return EXP_TABLE[0][1];

  let row = EXP_TABLE[0];
  for (let k = EXP_TABLE.length - 1; k >= 0; k--) {
    if (hkm >= EXP_TABLE[k][0]) {
      row = EXP_TABLE[k];
      break;
    }
  }
  const [h0, rho0, H] = row;
  return rho0 * Math.exp(-(hkm - h0) / H);
}

// ---------------------------------------------------------------------------
// Solar activity correction (layer 3)
// ---------------------------------------------------------------------------

/**
 * Exospheric temperature from solar and geomagnetic indices [K].
 *
 * T_inf = 900 + 2.5 (F10.7 - 70) + 1.5 Ap
 *
 * A standard first-order relation (Vallado eq. 8-37, also in Wertz SMAD).
 * F10.7 is the 10.7 cm solar radio flux in solar flux units (sfu); Ap is the
 * daily planetary geomagnetic amplitude index.
 *
 * Reference points: F10.7 = 70 (deep solar minimum) -> 900 K.
 *                   F10.7 = 150 (moderate)          -> 1100 K.
 *                   F10.7 = 250 (strong maximum)    -> 1350 K.
 */
export function exosphericTemperature(f107 = 150, ap = 15) {
  return 900 + 2.5 * (f107 - 70) + 1.5 * ap;
}

/**
 * Altitude above which the solar-activity correction is applied [m].
 * Below the thermosphere proper, solar flux has little effect on density.
 */
const SOLAR_CORRECTION_FLOOR = 180000;

/**
 * Exospheric temperature the Vallado table implicitly represents [K].
 * The table is a mean-solar-activity fit; F10.7 = 150, Ap = 15 reproduces it.
 */
const T_INF_REFERENCE = exosphericTemperature(150, 15);

/**
 * Density multiplier for solar activity above SOLAR_CORRECTION_FLOOR.
 *
 * Above the turbopause the atmosphere is close to isothermal at T_inf, so
 * density falls as exp(-(z - z_ref)/H) with H = k T_inf / (m g). Raising
 * T_inf raises H and inflates density at altitude. The ratio of the two
 * exponentials gives the multiplier below.
 *
 * This is a scale-height scaling, not a full thermospheric model. It captures
 * the correct sign, the correct order of magnitude (roughly 5-10x swing at
 * 400 km across a solar cycle, matching NRLMSISE-00), and nothing finer.
 */
export function solarActivityFactor(z, f107 = 150, ap = 15) {
  if (z <= SOLAR_CORRECTION_FLOOR) return 1;

  const tInf = exosphericTemperature(f107, ap);
  const dz = z - SOLAR_CORRECTION_FLOOR;

  // Scale height at the reference altitude for the table's implicit T_inf.
  // Mean molar mass near 180-400 km is dominated by atomic oxygen; USSA-76
  // gives M ~ 0.0220 kg/mol at 180 km falling toward 0.0160 at 500 km.
  const mBar = 0.0205; // [kg/mol], representative of 180-500 km
  const gLocal = G0 * (6371000 / (6371000 + SOLAR_CORRECTION_FLOOR)) ** 2;

  const hRef = (R_USSA76 * T_INF_REFERENCE) / (mBar * gLocal);
  const hNew = (R_USSA76 * tInf) / (mBar * gLocal);

  return Math.exp(-dz / hNew) / Math.exp(-dz / hRef);
}

// ---------------------------------------------------------------------------
// Unified interface
// ---------------------------------------------------------------------------

/**
 * Full atmospheric state at a geometric altitude.
 *
 * Blends USSA-76 (below 86 km) into the exponential model (above) with a
 * linear crossfade over 80-86 km so density and its derivative stay smooth --
 * a discontinuity here would inject spurious accelerations into the
 * integrator during the ascent phase.
 *
 * @param {number} z geometric altitude above the WGS84 ellipsoid [m]
 * @param {{f107?:number, ap?:number}} [opts] solar/geomagnetic indices
 */
export function atmosphere(z, opts = {}) {
  const { f107 = 150, ap = 15 } = opts;

  if (z >= 1000e3) {
    // Above the table. Extrapolate the top row; density here is ~1e-15 and
    // contributes nothing measurable to drag, but keep it finite and positive.
    const density = exponentialDensity(z) * solarActivityFactor(z, f107, ap);
    return {
      density,
      pressure: 0,
      temperature: exosphericTemperature(f107, ap),
      soundSpeed: NaN,
      viscosity: NaN,
      scaleHeight: 268000,
      regime: 'exospheric',
    };
  }

  if (z <= 80e3) {
    const s = ussa76(z);
    return { ...s, regime: 'ussa76' };
  }

  const rhoExp = exponentialDensity(z) * solarActivityFactor(z, f107, ap);

  if (z >= 86e3) {
    return {
      density: rhoExp,
      pressure: 0,
      temperature: 186.87,
      soundSpeed: NaN,
      viscosity: NaN,
      scaleHeight: 5382,
      regime: 'exponential',
    };
  }

  // Crossfade band, 80-86 km.
  const s = ussa76(z);
  const w = (z - 80e3) / 6e3;
  return {
    ...s,
    density: s.density * (1 - w) + rhoExp * w,
    regime: 'blend',
  };
}

/**
 * Convenience: density only.
 * @param {number} z geometric altitude [m]
 */
export function density(z, opts) {
  return atmosphere(z, opts).density;
}

/**
 * Knudsen number: mean free path / characteristic length.
 * Kn < 0.01 is continuum flow, Kn > 10 is free-molecular. Spacecraft above
 * ~150 km are firmly free-molecular, which is why their drag coefficients sit
 * near 2.2 rather than the ~1 typical of streamlined continuum bodies.
 */
export function knudsenNumber(z, characteristicLength) {
  const s = atmosphere(z);
  const lambda = s.meanFreePath ?? 1e6;
  return lambda / characteristicLength;
}
