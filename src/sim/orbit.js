/**
 * Orbital mechanics: element conversions, Kepler's equation, impulsive
 * transfers, J2 secular rates, eclipse geometry, and drag decay.
 *
 * Angle convention: every function in this module takes and returns angles in
 * RADIANS. Degrees appear only at the UI boundary. Mixing the two is the most
 * common source of silent errors in astrodynamics code, so the boundary is
 * kept in exactly one place.
 */

import {
  MU_EARTH,
  R_EARTH_EQ,
  J2,
  R_SUN,
  YEAR_JULIAN,
  DEG,
} from './constants.js';
import * as V from './vec3.js';
import { atmosphere } from './atmosphere.js';

const TWO_PI = 2 * Math.PI;
const wrap2pi = (x) => ((x % TWO_PI) + TWO_PI) % TWO_PI;

// ---------------------------------------------------------------------------
// State vector <-> classical orbital elements
// ---------------------------------------------------------------------------

/**
 * Position/velocity -> classical orbital elements.
 *
 * Handles the degenerate cases explicitly rather than dividing by zero:
 *   - equatorial (i ~ 0): RAAN undefined, folded into a longitude of periapsis
 *   - circular (e ~ 0): argument of periapsis undefined, folded into argument
 *     of latitude
 * These are not edge cases in this simulator -- a circularised equatorial
 * datacenter orbit hits both at once.
 *
 * @param {number[]} r position [m], ECI
 * @param {number[]} v velocity [m/s], ECI
 * @param {number} [mu] gravitational parameter
 */
export function rvToElements(r, v, mu = MU_EARTH) {
  const rMag = V.norm(r);
  const vMag = V.norm(v);

  const h = V.cross(r, v); // specific angular momentum
  const hMag = V.norm(h);

  const n = V.cross([0, 0, 1], h); // node vector
  const nMag = V.norm(n);

  // Eccentricity vector: e = ((v^2 - mu/r) r - (r.v) v) / mu
  const rv = V.dot(r, v);
  const eVec = V.scale(
    V.sub(V.scale(r, vMag * vMag - mu / rMag), V.scale(v, rv)),
    1 / mu,
  );
  const e = V.norm(eVec);

  // Specific orbital energy; a follows from it (negative for bound orbits).
  const energy = (vMag * vMag) / 2 - mu / rMag;
  const a = Math.abs(energy) < 1e-12 ? Infinity : -mu / (2 * energy);
  const p = (hMag * hMag) / mu; // semi-latus rectum

  const i = Math.acos(Math.min(1, Math.max(-1, h[2] / hMag)));

  const equatorial = nMag < 1e-10 * hMag;
  const circular = e < 1e-10;

  let raan = 0;
  if (!equatorial) {
    raan = Math.acos(Math.min(1, Math.max(-1, n[0] / nMag)));
    if (n[1] < 0) raan = TWO_PI - raan;
  }

  let argp = 0;
  if (!equatorial && !circular) {
    argp = Math.acos(Math.min(1, Math.max(-1, V.dot(n, eVec) / (nMag * e))));
    if (eVec[2] < 0) argp = TWO_PI - argp;
  } else if (equatorial && !circular) {
    // Longitude of periapsis, measured from the +X axis in the equator.
    argp = Math.atan2(eVec[1], eVec[0]);
    if (h[2] < 0) argp = TWO_PI - argp;
    argp = wrap2pi(argp);
  }

  let nu;
  if (!circular) {
    nu = Math.acos(Math.min(1, Math.max(-1, V.dot(eVec, r) / (e * rMag))));
    if (rv < 0) nu = TWO_PI - nu;
  } else if (!equatorial) {
    // Argument of latitude.
    nu = Math.acos(Math.min(1, Math.max(-1, V.dot(n, r) / (nMag * rMag))));
    if (r[2] < 0) nu = TWO_PI - nu;
  } else {
    // True longitude.
    nu = Math.atan2(r[1], r[0]);
    if (h[2] < 0) nu = TWO_PI - nu;
    nu = wrap2pi(nu);
  }

  const rp = e < 1 ? a * (1 - e) : p / (1 + e);
  const ra = e < 1 ? a * (1 + e) : Infinity;
  const period = e < 1 && a > 0 ? TWO_PI * Math.sqrt(a ** 3 / mu) : Infinity;

  return {
    a,
    e,
    i,
    raan,
    argp,
    nu,
    p,
    h: hMag,
    energy,
    period,
    rp,
    ra,
    // Altitudes are referenced to the equatorial radius. For an inclined orbit
    // the true ground clearance at the poles is 21 km greater; use the
    // geodetic helpers when that matters.
    altitudePerigee: rp - R_EARTH_EQ,
    altitudeApogee: ra === Infinity ? Infinity : ra - R_EARTH_EQ,
    equatorial,
    circular,
  };
}

/**
 * Classical orbital elements -> position/velocity in ECI.
 * Builds the state in the perifocal frame, then applies the 3-1-3 rotation
 * R_z(-raan) R_x(-i) R_z(-argp).
 */
export function elementsToRv(el, mu = MU_EARTH) {
  const { e, i, raan, argp, nu } = el;
  const p = el.p ?? el.a * (1 - e * e);

  const rMag = p / (1 + e * Math.cos(nu));
  const rPqw = [rMag * Math.cos(nu), rMag * Math.sin(nu), 0];
  const k = Math.sqrt(mu / p);
  const vPqw = [-k * Math.sin(nu), k * (e + Math.cos(nu)), 0];

  const cO = Math.cos(raan);
  const sO = Math.sin(raan);
  const cw = Math.cos(argp);
  const sw = Math.sin(argp);
  const ci = Math.cos(i);
  const si = Math.sin(i);

  const R = [
    [cO * cw - sO * sw * ci, -cO * sw - sO * cw * ci, sO * si],
    [sO * cw + cO * sw * ci, -sO * sw + cO * cw * ci, -cO * si],
    [sw * si, cw * si, ci],
  ];

  const apply = (u) => [
    R[0][0] * u[0] + R[0][1] * u[1] + R[0][2] * u[2],
    R[1][0] * u[0] + R[1][1] * u[1] + R[1][2] * u[2],
    R[2][0] * u[0] + R[2][1] * u[1] + R[2][2] * u[2],
  ];

  return { r: apply(rPqw), v: apply(vPqw) };
}

// ---------------------------------------------------------------------------
// Kepler's equation
// ---------------------------------------------------------------------------

/**
 * Solve M = E - e sin(E) for the eccentric anomaly E.
 *
 * Newton-Raphson with the Prussing-Conway starting guess, which keeps the
 * iteration in its quadratic-convergence basin even at e -> 1 where a naive
 * E0 = M start stalls or oscillates. Converges to machine precision in
 * typically 3-4 iterations for e < 0.99.
 *
 * @param {number} M mean anomaly [rad]
 * @param {number} e eccentricity, 0 <= e < 1
 * @param {number} [tol] convergence tolerance on |f(E)|
 */
export function solveKepler(M, e, tol = 1e-13, maxIter = 60) {
  if (e < 0 || e >= 1) {
    throw new RangeError(`solveKepler: elliptic solver requires 0 <= e < 1 (got ${e})`);
  }
  const Mw = wrap2pi(M);

  // Starting guess: for near-circular, M is already excellent. For high
  // eccentricity, offset toward periapsis where the true anomaly races ahead.
  let E = e < 0.8 ? Mw : Math.PI;

  for (let k = 0; k < maxIter; k++) {
    const f = E - e * Math.sin(E) - Mw;
    const fp = 1 - e * Math.cos(E);
    const dE = f / fp;
    E -= dE;
    if (Math.abs(f) < tol) break;
  }
  return E;
}

/** Solve the hyperbolic Kepler equation M = e sinh(H) - H. */
export function solveKeplerHyperbolic(M, e, tol = 1e-13, maxIter = 100) {
  if (e <= 1) throw new RangeError('solveKeplerHyperbolic requires e > 1');
  let H = Math.abs(M) > 4 ? Math.sign(M) * Math.log((2 * Math.abs(M)) / e + 1.8) : M / (e - 1);
  for (let k = 0; k < maxIter; k++) {
    const f = e * Math.sinh(H) - H - M;
    const fp = e * Math.cosh(H) - 1;
    H -= f / fp;
    if (Math.abs(f) < tol) break;
  }
  return H;
}

/** Eccentric anomaly -> true anomaly [rad]. */
export function eccentricToTrue(E, e) {
  return 2 * Math.atan2(
    Math.sqrt(1 + e) * Math.sin(E / 2),
    Math.sqrt(1 - e) * Math.cos(E / 2),
  );
}

/** True anomaly -> eccentric anomaly [rad]. */
export function trueToEccentric(nu, e) {
  return 2 * Math.atan2(
    Math.sqrt(1 - e) * Math.sin(nu / 2),
    Math.sqrt(1 + e) * Math.cos(nu / 2),
  );
}

/** True anomaly -> mean anomaly [rad]. */
export function trueToMean(nu, e) {
  const E = trueToEccentric(nu, e);
  return E - e * Math.sin(E);
}

/** Mean anomaly -> true anomaly [rad]. */
export function meanToTrue(M, e) {
  return eccentricToTrue(solveKepler(M, e), e);
}

// ---------------------------------------------------------------------------
// Basic orbit relations
// ---------------------------------------------------------------------------

/** Vis-viva: speed at radius r on an orbit of semi-major axis a. */
export const visViva = (r, a, mu = MU_EARTH) => Math.sqrt(mu * (2 / r - 1 / a));

/** Circular orbit speed at radius r. */
export const circularVelocity = (r, mu = MU_EARTH) => Math.sqrt(mu / r);

/** Local escape speed at radius r. */
export const escapeVelocity = (r, mu = MU_EARTH) => Math.sqrt((2 * mu) / r);

/** Keplerian period of a closed orbit [s]. */
export const orbitalPeriod = (a, mu = MU_EARTH) => TWO_PI * Math.sqrt(a ** 3 / mu);

/** Semi-major axis giving a requested period [m]. */
export const semiMajorAxisForPeriod = (T, mu = MU_EARTH) =>
  Math.cbrt((mu * T * T) / (4 * Math.PI * Math.PI));

/** Mean motion [rad/s]. */
export const meanMotion = (a, mu = MU_EARTH) => Math.sqrt(mu / a ** 3);

// ---------------------------------------------------------------------------
// Impulsive transfers
// ---------------------------------------------------------------------------

/**
 * Hohmann transfer between coplanar circular orbits.
 * The minimum-energy two-impulse transfer for radius ratios below 11.94;
 * above that a bi-elliptic transfer is cheaper, which `bestTransfer` checks.
 *
 * @returns {{dv1:number, dv2:number, dvTotal:number, transferTime:number, aTransfer:number}}
 */
export function hohmannTransfer(r1, r2, mu = MU_EARTH) {
  const aT = (r1 + r2) / 2;
  const v1 = Math.sqrt(mu / r1);
  const v2 = Math.sqrt(mu / r2);
  const vp = Math.sqrt(mu * (2 / r1 - 1 / aT));
  const va = Math.sqrt(mu * (2 / r2 - 1 / aT));

  const dv1 = vp - v1;
  const dv2 = v2 - va;

  return {
    dv1,
    dv2,
    dvTotal: Math.abs(dv1) + Math.abs(dv2),
    transferTime: Math.PI * Math.sqrt(aT ** 3 / mu),
    aTransfer: aT,
  };
}

/**
 * Bi-elliptic transfer via an intermediate apoapsis at rB.
 * Cheaper than Hohmann for large radius ratios, at the cost of a much longer
 * transfer time -- often weeks instead of hours.
 */
export function biellipticTransfer(r1, r2, rB, mu = MU_EARTH) {
  const a1 = (r1 + rB) / 2;
  const a2 = (r2 + rB) / 2;

  const v1 = Math.sqrt(mu / r1);
  const v2 = Math.sqrt(mu / r2);

  const dv1 = Math.sqrt(mu * (2 / r1 - 1 / a1)) - v1;
  const dv2 = Math.sqrt(mu * (2 / rB - 1 / a2)) - Math.sqrt(mu * (2 / rB - 1 / a1));
  const dv3 = v2 - Math.sqrt(mu * (2 / r2 - 1 / a2));

  return {
    dv1,
    dv2,
    dv3,
    dvTotal: Math.abs(dv1) + Math.abs(dv2) + Math.abs(dv3),
    transferTime:
      Math.PI * Math.sqrt(a1 ** 3 / mu) + Math.PI * Math.sqrt(a2 ** 3 / mu),
  };
}

/**
 * Delta-v for a pure plane change of angle `dInc` at speed `v`.
 * dv = 2 v sin(dInc/2). This is brutally expensive in LEO: changing
 * inclination by 30 deg at 7.6 km/s costs 3.9 km/s, more than the entire
 * upper-stage budget of most vehicles. It is the reason launch site latitude
 * effectively dictates achievable inclination.
 */
export const planeChangeDeltaV = (v, dInc) => 2 * v * Math.sin(dInc / 2);

/**
 * Combined plane change and speed change at one burn.
 * Law of cosines on the velocity triangle -- always cheaper than doing the two
 * separately, which is why inclination changes are folded into the
 * circularisation burn.
 */
export const combinedManeuverDeltaV = (v1, v2, dInc) =>
  Math.sqrt(v1 * v1 + v2 * v2 - 2 * v1 * v2 * Math.cos(dInc));

// ---------------------------------------------------------------------------
// J2 secular perturbations
// ---------------------------------------------------------------------------

/**
 * Secular rate of change of the right ascension of the ascending node [rad/s].
 * Negative (westward regression) for prograde orbits.
 */
export function nodalRegressionRate(a, e, i, mu = MU_EARTH, re = R_EARTH_EQ) {
  const p = a * (1 - e * e);
  const n = Math.sqrt(mu / a ** 3);
  return -1.5 * n * J2 * (re / p) ** 2 * Math.cos(i);
}

/**
 * Secular rate of change of the argument of periapsis [rad/s].
 * Vanishes at the critical inclination acos(1/sqrt(5)) = 63.4349 deg, which is
 * why Molniya orbits use it -- apogee stays parked over the same hemisphere.
 */
export function apsidalRotationRate(a, e, i, mu = MU_EARTH, re = R_EARTH_EQ) {
  const p = a * (1 - e * e);
  const n = Math.sqrt(mu / a ** 3);
  return 0.75 * n * J2 * (re / p) ** 2 * (5 * Math.cos(i) ** 2 - 1);
}

/** The critical inclination where apsidal rotation vanishes [rad]. */
export const CRITICAL_INCLINATION = Math.acos(1 / Math.sqrt(5));

/**
 * Inclination that makes an orbit sun-synchronous [rad], or NaN if no such
 * inclination exists (the required node rate exceeds what J2 can supply --
 * true above roughly 5975 km altitude).
 *
 * Sun-synchronous means the node precesses at exactly the rate Earth's mean
 * longitude of the Sun advances: 360 deg per tropical year.
 */
export function sunSynchronousInclination(a, e = 0, mu = MU_EARTH, re = R_EARTH_EQ) {
  const targetRate = TWO_PI / 365.2421897 / 86400; // [rad/s]
  const p = a * (1 - e * e);
  const n = Math.sqrt(mu / a ** 3);
  const cosI = -targetRate / (1.5 * n * J2 * (re / p) ** 2);
  if (Math.abs(cosI) > 1) return NaN;
  return Math.acos(cosI);
}

/**
 * Nodal (draconitic) period -- the interval between successive ascending node
 * crossings, which differs from the Keplerian period under J2.
 */
export function nodalPeriod(a, e, i, mu = MU_EARTH, re = R_EARTH_EQ) {
  const p = a * (1 - e * e);
  const n = Math.sqrt(mu / a ** 3);
  const factor =
    1 + 1.5 * J2 * (re / p) ** 2 * (Math.sqrt(1 - e * e) * (1 - 1.5 * Math.sin(i) ** 2) + (1 - 2.5 * Math.sin(i) ** 2));
  return TWO_PI / (n * factor);
}

// ---------------------------------------------------------------------------
// Eclipse geometry
// ---------------------------------------------------------------------------

/**
 * Fraction of the solar disk visible from a spacecraft, 0 (full umbra) to
 * 1 (full sun).
 *
 * Treats the Sun and Earth as uniform circular disks on the sky and computes
 * the exact area of their overlap. This is materially better than the usual
 * cylindrical-shadow test: penumbra crossings in LEO last 10-20 seconds and
 * the annular/partial phases are where a solar array's output actually ramps.
 * Limb darkening (a few percent, only during partial phases) is neglected.
 *
 * @param {number[]} rSat spacecraft position in ECI [m]
 * @param {number[]} rSun Sun position in ECI [m]
 * @param {number} [rBody] occulting body radius [m]
 */
export function sunlitFraction(rSat, rSun, rBody = R_EARTH_EQ) {
  const satToSun = V.sub(rSun, rSat);
  const dSun = V.norm(satToSun);
  const dEarth = V.norm(rSat);

  if (dEarth <= rBody) return 0; // inside the body

  // Apparent angular radii as seen from the spacecraft.
  const aSun = Math.asin(Math.min(1, R_SUN / dSun));
  const aEarth = Math.asin(Math.min(1, rBody / dEarth));

  // Angular separation of the two disk centres.
  const sep = V.angleBetween(satToSun, V.neg(rSat));

  if (sep >= aSun + aEarth) return 1; // no overlap: full sun
  if (sep <= aEarth - aSun) return 0; // Sun entirely behind Earth: umbra
  if (sep <= aSun - aEarth) {
    // Earth transits the solar disk without covering it: annular eclipse.
    return 1 - (aEarth / aSun) ** 2;
  }

  // Partial overlap: area of the circular lens between two disks.
  const a = aSun;
  const b = aEarth;
  const c = sep;
  const x = (a * a + c * c - b * b) / (2 * c);
  const y = Math.sqrt(Math.max(0, a * a - x * x));

  const overlap =
    a * a * Math.acos(Math.min(1, Math.max(-1, x / a))) +
    b * b * Math.acos(Math.min(1, Math.max(-1, (c - x) / b))) -
    c * y;

  return Math.max(0, 1 - overlap / (Math.PI * a * a));
}

/**
 * Analytic eclipse fraction of a circular orbit, for the worst case where the
 * orbit plane contains the Sun vector (beta angle = 0).
 *
 * f = (1/pi) asin( sqrt(R^2 - Re^2 ... ) ) -- derived from the cylindrical
 * shadow chord. Used for quick sizing; the full simulation uses
 * `sunlitFraction` per timestep instead.
 *
 * @param {number} a orbit radius [m]
 * @param {number} beta angle between the orbit plane and the Sun vector [rad]
 */
export function eclipseFraction(a, beta = 0, re = R_EARTH_EQ) {
  // Beyond this beta the orbit never enters the shadow cylinder at all.
  const betaCrit = Math.asin(Math.min(1, re / a));
  if (Math.abs(beta) >= betaCrit) return 0;

  const num = Math.sqrt(a * a - re * re) ;
  const cosBeta = Math.cos(beta);
  const arg = num / (a * cosBeta);
  if (arg >= 1) return 0;
  return Math.acos(arg) / Math.PI;
}

/**
 * Beta angle: the angle between the orbit plane and the Earth-Sun vector [rad].
 * Drives both eclipse duration and thermal loading. At high beta an orbit is
 * continuously sunlit -- great for power, punishing for radiators.
 */
export function betaAngle(hVec, sunDir) {
  return Math.PI / 2 - V.angleBetween(hVec, sunDir);
}

// ---------------------------------------------------------------------------
// Atmospheric drag
// ---------------------------------------------------------------------------

/**
 * Drag acceleration on a spacecraft [m/s^2].
 *
 * a = -0.5 * rho * |v_rel| * v_rel * Cd * A / m
 *
 * Note the drag coefficient: above ~150 km the flow is free-molecular, not
 * continuum, and Cd for a typical satellite is 2.0-2.4 rather than the
 * sub-unity values familiar from aerodynamics. 2.2 is the standard default.
 *
 * @param {number[]} vRel velocity relative to the rotating atmosphere [m/s]
 * @param {number} rho local density [kg/m^3]
 * @param {number} cdA drag coefficient times reference area [m^2]
 * @param {number} mass [kg]
 */
export function dragAcceleration(vRel, rho, cdA, mass) {
  const vMag = V.norm(vRel);
  if (vMag === 0 || rho === 0) return [0, 0, 0];
  const k = (-0.5 * rho * vMag * cdA) / mass;
  return [k * vRel[0], k * vRel[1], k * vRel[2]];
}

/** Ballistic coefficient B = m / (Cd A) [kg/m^2]. Higher = decays slower. */
export const ballisticCoefficient = (mass, cd, area) => mass / (cd * area);

/**
 * Orbital lifetime of a circular orbit under drag, by numerical integration of
 * the secular decay rate.
 *
 *   da/dt = -rho * sqrt(mu * a) / B
 *
 * This is the standard averaged result: the per-revolution loss is
 * da = -2 pi rho a^2 / B, divided by the period. It assumes the orbit stays
 * near-circular, which drag itself enforces (it circularises orbits by biting
 * hardest at perigee).
 *
 * The dominant uncertainty is not this integration -- it is the density model
 * and the future solar cycle. Reported lifetimes carry the atmosphere's
 * factor-of-several uncertainty, so treat them as order-of-magnitude.
 *
 * @param {number} altitude0 starting circular altitude [m]
 * @param {number} ballisticCoeff m/(Cd A) [kg/m^2]
 * @param {{f107?:number, ap?:number, reentryAltitude?:number, maxYears?:number}} [opts]
 * @returns {{years:number, decayed:boolean, profile:Array<{t:number,alt:number}>}}
 */
export function orbitalLifetime(altitude0, ballisticCoeff, opts = {}) {
  const {
    f107 = 150,
    ap = 15,
    reentryAltitude = 120e3,
    maxYears = 500,
    mu = MU_EARTH,
  } = opts;

  let a = R_EARTH_EQ + altitude0;
  const aEnd = R_EARTH_EQ + reentryAltitude;
  let t = 0;
  const tMax = maxYears * YEAR_JULIAN;
  const profile = [{ t: 0, alt: altitude0 }];

  // Always return at least two profile points so callers can plot or diff a
  // profile without special-casing the already-decayed input.
  if (a <= aEnd) {
    profile.push({ t: 0, alt: altitude0 });
    return { years: 0, decayed: true, profile };
  }

  // Adaptive stepping: step size chosen so each step loses at most ~0.5% of
  // the current altitude margin, which keeps the strongly nonlinear low-
  // altitude endgame resolved without wasting steps at high altitude.
  let steps = 0;
  while (a > aEnd && t < tMax && steps < 2_000_000) {
    const alt = a - R_EARTH_EQ;
    const rho = atmosphere(alt, { f107, ap }).density;

    if (rho <= 0 || !Number.isFinite(rho)) break;

    const dadt = (-rho * Math.sqrt(mu * a)) / ballisticCoeff; // [m/s]
    if (dadt === 0) break;

    const margin = a - aEnd;
    let dt = Math.abs((0.005 * margin) / dadt);
    dt = Math.min(dt, 30 * 86400); // never step more than a month
    dt = Math.max(dt, 1); // nor less than a second

    a += dadt * dt;
    t += dt;
    steps++;

    if (profile.length < 2000 && steps % 50 === 0) {
      profile.push({ t, alt: a - R_EARTH_EQ });
    }
  }

  const decayed = a <= aEnd;
  profile.push({ t, alt: a - R_EARTH_EQ });

  return {
    years: t / YEAR_JULIAN,
    decayed,
    profile,
  };
}

/**
 * Delta-v per year required to hold altitude against drag (station-keeping).
 *
 * To maintain a circular orbit the thrust must replace exactly the energy drag
 * removes, giving dv/dt = rho * v^2 / (2B) with v the orbital speed.
 */
export function stationKeepingDeltaV(altitude, ballisticCoeff, opts = {}) {
  const { f107 = 150, ap = 15, mu = MU_EARTH } = opts;
  const a = R_EARTH_EQ + altitude;
  const rho = atmosphere(altitude, { f107, ap }).density;
  const v = Math.sqrt(mu / a);
  const dvPerSecond = (rho * v * v) / (2 * ballisticCoeff);
  return {
    perSecond: dvPerSecond,
    perYear: dvPerSecond * YEAR_JULIAN,
    density: rho,
  };
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Convert an elements object's angles from radians to degrees for display. */
export function elementsToDegrees(el) {
  return {
    ...el,
    i: el.i / DEG,
    raan: el.raan / DEG,
    argp: el.argp / DEG,
    nu: el.nu / DEG,
  };
}

export { wrap2pi };
