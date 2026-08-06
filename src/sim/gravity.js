/**
 * Gravitational acceleration models in the Earth-Centered Inertial (ECI) frame.
 *
 * The zonal harmonic expansions below are the standard closed forms found in
 * Vallado, "Fundamentals of Astrodynamics and Applications", and Curtis,
 * "Orbital Mechanics for Engineering Students" (eq. 12.30 for J2).
 *
 * Why J2 matters here: for a 500 km orbit the J2 acceleration is ~1e-2 of the
 * central term. Ignoring it would make the orbit plane inertially fixed, which
 * is wrong -- J2 drives nodal regression (~5 deg/day at 500 km, i=51.6) and
 * apsidal rotation. Sun-synchronous orbits exist *because* of J2, so a
 * simulator that drops it cannot represent the orbit most Earth-observation
 * and many proposed orbital-datacenter concepts would actually use.
 */

import { MU_EARTH, R_EARTH_EQ, J2, J3, J4 } from './constants.js';

/**
 * Two-body (point-mass) gravitational acceleration.
 * @param {number[]} r position in ECI [m]
 * @param {number} [mu] gravitational parameter [m^3/s^2]
 * @returns {number[]} acceleration [m/s^2]
 */
export function pointMassGravity(r, mu = MU_EARTH) {
  const r2 = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
  const rmag = Math.sqrt(r2);
  const k = -mu / (r2 * rmag);
  return [k * r[0], k * r[1], k * r[2]];
}

/**
 * Perturbing acceleration from the J2 zonal harmonic (Earth oblateness).
 * @param {number[]} r position in ECI [m]
 * @returns {number[]} perturbing acceleration [m/s^2]
 */
export function j2Perturbation(r, mu = MU_EARTH, re = R_EARTH_EQ, j2 = J2) {
  const [x, y, z] = r;
  const rmag = Math.hypot(x, y, z);
  const zr2 = (z / rmag) ** 2;

  const k = (-1.5 * j2 * mu * re * re) / rmag ** 4;
  const common = k / rmag;

  return [
    common * x * (1 - 5 * zr2),
    common * y * (1 - 5 * zr2),
    common * z * (3 - 5 * zr2),
  ];
}

/**
 * Perturbing acceleration from the J3 zonal harmonic ("pear shape").
 * About three orders of magnitude below J2; included so that long-duration
 * propagation of frozen / high-eccentricity orbits stays honest.
 */
export function j3Perturbation(r, mu = MU_EARTH, re = R_EARTH_EQ, j3 = J3) {
  const [x, y, z] = r;
  const rmag = Math.hypot(x, y, z);
  const s = z / rmag;

  const k = (-2.5 * j3 * mu * re ** 3) / rmag ** 5;
  const lateral = k * (3 * s - 7 * s ** 3);

  return [
    (lateral * x) / rmag,
    (lateral * y) / rmag,
    k * (6 * s * s - 7 * s ** 4 - 0.6),
  ];
}

/** Perturbing acceleration from the J4 zonal harmonic. */
export function j4Perturbation(r, mu = MU_EARTH, re = R_EARTH_EQ, j4 = J4) {
  const [x, y, z] = r;
  const rmag = Math.hypot(x, y, z);
  const s = z / rmag;
  const s2 = s * s;
  const s4 = s2 * s2;

  const k = (1.875 * j4 * mu * re ** 4) / rmag ** 6;
  const lateral = k * (1 - 14 * s2 + 21 * s4);

  return [
    (lateral * x) / rmag,
    (lateral * y) / rmag,
    (k * z * (5 - (70 / 3) * s2 + 21 * s4)) / rmag,
  ];
}

/**
 * Total Earth gravitational acceleration including selected zonal harmonics.
 *
 * @param {number[]} r position in ECI [m]
 * @param {{harmonics?: 0|2|3|4}} [opts] highest zonal term to include
 *        (0 = point mass, 2 = +J2, 3 = +J3, 4 = +J4)
 */
export function earthGravity(r, opts = {}) {
  const { harmonics = 2 } = opts;
  const a = pointMassGravity(r);
  if (harmonics < 2) return a;

  const p2 = j2Perturbation(r);
  a[0] += p2[0];
  a[1] += p2[1];
  a[2] += p2[2];

  if (harmonics >= 3) {
    const p3 = j3Perturbation(r);
    a[0] += p3[0];
    a[1] += p3[1];
    a[2] += p3[2];
  }
  if (harmonics >= 4) {
    const p4 = j4Perturbation(r);
    a[0] += p4[0];
    a[1] += p4[1];
    a[2] += p4[2];
  }
  return a;
}

/**
 * Third-body perturbing acceleration in the primary-centered frame.
 *
 * Uses the standard difference-of-inverse-cubes form. Written naively this
 * differences two nearly equal large numbers and loses precision when the
 * third body is far away, so the Battin f(q) formulation is used instead --
 * it is algebraically identical but evaluates the small difference directly.
 *
 * @param {number[]} rSat  spacecraft position, primary-centered [m]
 * @param {number[]} rBody third body position, primary-centered [m]
 * @param {number} muBody  third body gravitational parameter [m^3/s^2]
 */
export function thirdBodyPerturbation(rSat, rBody, muBody) {
  const d = [rSat[0] - rBody[0], rSat[1] - rBody[1], rSat[2] - rBody[2]];
  const dMag = Math.hypot(d[0], d[1], d[2]);
  const rBodyMag = Math.hypot(rBody[0], rBody[1], rBody[2]);

  // q = (r . (r - 2 s)) / |s|^2 where r = rSat, s = rBody
  const q =
    (rSat[0] * (rSat[0] - 2 * rBody[0]) +
      rSat[1] * (rSat[1] - 2 * rBody[1]) +
      rSat[2] * (rSat[2] - 2 * rBody[2])) /
    (rBodyMag * rBodyMag);

  const fq = q * ((3 + 3 * q + q * q) / (1 + Math.pow(1 + q, 1.5)));
  const k = -muBody / (dMag * dMag * dMag);

  return [
    k * (rSat[0] + fq * rBody[0]),
    k * (rSat[1] + fq * rBody[1]),
    k * (rSat[2] + fq * rBody[2]),
  ];
}

/**
 * Magnitude of the J2 perturbation relative to the central term.
 * Handy for deciding whether a given study needs harmonics at all.
 */
export function j2RelativeMagnitude(rmag) {
  return 1.5 * J2 * (R_EARTH_EQ / rmag) ** 2;
}
