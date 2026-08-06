/**
 * Reference frames, time systems, and solar geometry.
 *
 * Frames used throughout the simulator:
 *
 *   ECI  - Earth-Centered Inertial, mean equator and equinox of date. All
 *          dynamics are integrated here, because Newton's second law needs a
 *          non-rotating frame and adding Coriolis/centrifugal terms to an
 *          ECEF formulation would be strictly more error-prone.
 *   ECEF - Earth-Centered Earth-Fixed. Rotates with the planet. Launch sites,
 *          ground stations and ground tracks live here.
 *   Geodetic - latitude/longitude/altitude on the WGS84 ellipsoid. Note that
 *          geodetic latitude is not geocentric latitude; the difference peaks
 *          near 45 deg at about 0.19 deg, which is ~21 km of position error if
 *          conflated. They are kept distinct here.
 */

import {
  R_EARTH_EQ,
  EARTH_E2,
  OMEGA_EARTH,
  AU,
  OBLIQUITY_J2000,
  DEG,
} from './constants.js';

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** Julian date of the J2000.0 epoch (2000-01-01T12:00:00 TT). */
export const JD_J2000 = 2451545.0;

/** JavaScript Date -> Julian Date (UTC treated as UT1; see note in gmst). */
export function dateToJulian(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

/** Julian Date -> JavaScript Date. */
export function julianToDate(jd) {
  return new Date((jd - 2440587.5) * 86400000);
}

/**
 * Greenwich Mean Sidereal Time [rad], IAU 1982 expression.
 *
 * Takes UT1. We feed it UTC, which differs from UT1 by |DUT1| < 0.9 s by
 * definition of leap seconds. That is at most 0.004 deg of Earth rotation, or
 * ~410 m at the equator -- irrelevant next to the other modelling assumptions
 * here, but worth naming rather than hiding.
 */
export function gmst(jdUt1) {
  const T = (jdUt1 - JD_J2000) / 36525;
  let seconds =
    67310.54841 +
    (876600 * 3600 + 8640184.812866) * T +
    0.093104 * T * T -
    6.2e-6 * T * T * T;

  seconds = ((seconds % 86400) + 86400) % 86400;
  // 86400 s of sidereal time spans 2*pi radians.
  return (seconds / 86400) * 2 * Math.PI;
}

// ---------------------------------------------------------------------------
// Geodetic <-> ECEF (WGS84 ellipsoid)
// ---------------------------------------------------------------------------

/**
 * Geodetic coordinates -> ECEF position.
 * @param {number} latDeg geodetic latitude [deg]
 * @param {number} lonDeg east longitude [deg]
 * @param {number} alt height above the ellipsoid [m]
 */
export function geodeticToEcef(latDeg, lonDeg, alt = 0) {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);

  // Radius of curvature in the prime vertical.
  const N = R_EARTH_EQ / Math.sqrt(1 - EARTH_E2 * sinLat * sinLat);

  return [
    (N + alt) * cosLat * Math.cos(lon),
    (N + alt) * cosLat * Math.sin(lon),
    (N * (1 - EARTH_E2) + alt) * sinLat,
  ];
}

/**
 * ECEF position -> geodetic coordinates, via Bowring's method.
 *
 * Bowring's closed-form approximation converges to sub-millimetre accuracy in
 * a single iteration for any altitude a spacecraft will occupy, so no loop is
 * needed. One Newton refinement is applied anyway for the extreme-altitude case.
 *
 * @returns {{latitude:number, longitude:number, altitude:number}} deg, deg, m
 */
export function ecefToGeodetic(r) {
  const [x, y, z] = r;
  const a = R_EARTH_EQ;
  const e2 = EARTH_E2;
  const b = a * Math.sqrt(1 - e2);
  const ep2 = (a * a - b * b) / (b * b); // second eccentricity squared

  const p = Math.hypot(x, y);
  const lon = Math.atan2(y, x);

  if (p < 1e-9) {
    // On the polar axis; latitude is +/-90 and the formulas below degenerate.
    return {
      latitude: z >= 0 ? 90 : -90,
      longitude: 0,
      altitude: Math.abs(z) - b,
    };
  }

  const theta = Math.atan2(z * a, p * b);
  let lat = Math.atan2(
    z + ep2 * b * Math.sin(theta) ** 3,
    p - e2 * a * Math.cos(theta) ** 3,
  );

  // One Newton refinement on the height/latitude pair.
  let N = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  let alt = p / Math.cos(lat) - N;
  for (let i = 0; i < 2; i++) {
    N = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    alt = p / Math.cos(lat) - N;
    lat = Math.atan2(z, p * (1 - (e2 * N) / (N + alt)));
  }

  return {
    latitude: lat / DEG,
    longitude: (((lon / DEG + 180) % 360) + 360) % 360 - 180,
    altitude: alt,
  };
}

/** Geocentric latitude [deg] of an ECI/ECEF position -- not geodetic latitude. */
export function geocentricLatitude(r) {
  return Math.asin(r[2] / Math.hypot(r[0], r[1], r[2])) / DEG;
}

/** Altitude above the WGS84 ellipsoid [m]. */
export function altitudeAboveEllipsoid(rEcef) {
  return ecefToGeodetic(rEcef).altitude;
}

/**
 * Altitude above the WGS84 ellipsoid, taken directly from an ECI vector [m].
 *
 * No GMST is needed: the ellipsoid is a surface of revolution about the z
 * axis, so rotating about that axis changes longitude but not height or
 * geodetic latitude. Only longitude would be wrong, and this returns neither.
 *
 * Use this, never `|r| - R_EARTH_EQ`. The two differ by 21 km between the
 * equator and the poles -- at Cape Canaveral's latitude the naive form puts
 * the launch pad 4.9 km below sea level, which corrupts the atmosphere lookup,
 * the pitch program, and the ground-impact test all at once.
 */
export function geodeticAltitude(rEci) {
  return ecefToGeodetic(rEci).altitude;
}

// ---------------------------------------------------------------------------
// ECI <-> ECEF
// ---------------------------------------------------------------------------

/** Rotate an ECI vector into ECEF given GMST [rad]. */
export function eciToEcef(rEci, theta) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [
    c * rEci[0] + s * rEci[1],
    -s * rEci[0] + c * rEci[1],
    rEci[2],
  ];
}

/** Rotate an ECEF vector into ECI given GMST [rad]. */
export function ecefToEci(rEcef, theta) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [
    c * rEcef[0] - s * rEcef[1],
    s * rEcef[0] + c * rEcef[1],
    rEcef[2],
  ];
}

/**
 * Inertial velocity of a point fixed to the rotating Earth.
 * v = omega x r. This is the free eastward velocity a launch site starts with:
 * 465 m/s at the equator, 408 m/s at Cape Canaveral (28.5 deg).
 */
export function earthRotationVelocity(rEci) {
  return [-OMEGA_EARTH * rEci[1], OMEGA_EARTH * rEci[0], 0];
}

/**
 * Velocity relative to the co-rotating atmosphere.
 * Drag acts on this, not on the inertial velocity -- a distinction worth
 * hundreds of m/s of computed drag loss during ascent.
 */
export function relativeVelocity(rEci, vEci) {
  const vAtm = earthRotationVelocity(rEci);
  return [vEci[0] - vAtm[0], vEci[1] - vAtm[1], vEci[2] - vAtm[2]];
}

// ---------------------------------------------------------------------------
// Local horizon frames
// ---------------------------------------------------------------------------

/**
 * East-North-Up basis vectors at a geodetic location, expressed in ECEF.
 * @returns {{east:number[], north:number[], up:number[]}}
 */
export function enuBasis(latDeg, lonDeg) {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const sLat = Math.sin(lat);
  const cLat = Math.cos(lat);
  const sLon = Math.sin(lon);
  const cLon = Math.cos(lon);

  return {
    east: [-sLon, cLon, 0],
    north: [-sLat * cLon, -sLat * sLon, cLat],
    up: [cLat * cLon, cLat * sLon, sLat],
  };
}

// ---------------------------------------------------------------------------
// Solar geometry
// ---------------------------------------------------------------------------

/**
 * Geocentric position of the Sun in ECI [m].
 *
 * Low-precision solar ephemeris from the Astronomical Almanac (also Vallado
 * Algorithm 29). Stated accuracy is 0.01 deg in ecliptic longitude over
 * 1950-2050, i.e. about 26000 km of transverse position error at 1 AU. For
 * eclipse timing that is worth well under a second, and for solar-array
 * incidence angles it is far below the pointing errors of a real array.
 *
 * @param {number} jd Julian date (UT1)
 */
export function sunPositionEci(jd) {
  const n = jd - JD_J2000;

  const meanLongitude = (280.46 + 0.9856474 * n) * DEG;
  const meanAnomaly = (357.528 + 0.9856003 * n) * DEG;

  const eclipticLongitude =
    meanLongitude +
    1.915 * DEG * Math.sin(meanAnomaly) +
    0.02 * DEG * Math.sin(2 * meanAnomaly);

  // Obliquity of date; the secular term is tiny but free to include.
  const obliquity = OBLIQUITY_J2000 - 0.0000004 * DEG * n;

  // Sun-Earth distance in AU, from the eccentricity of Earth's orbit.
  const rAu =
    1.00014 -
    0.01671 * Math.cos(meanAnomaly) -
    0.00014 * Math.cos(2 * meanAnomaly);
  const r = rAu * AU;

  return [
    r * Math.cos(eclipticLongitude),
    r * Math.cos(obliquity) * Math.sin(eclipticLongitude),
    r * Math.sin(obliquity) * Math.sin(eclipticLongitude),
  ];
}

/** Unit vector from Earth toward the Sun in ECI. */
export function sunDirectionEci(jd) {
  const s = sunPositionEci(jd);
  const m = Math.hypot(s[0], s[1], s[2]);
  return [s[0] / m, s[1] / m, s[2] / m];
}

/** Sun-Earth distance [m] at a given Julian date. */
export function sunDistance(jd) {
  const s = sunPositionEci(jd);
  return Math.hypot(s[0], s[1], s[2]);
}

/**
 * Solar irradiance at Earth's distance on a given date [W/m^2].
 * Varies +/-3.4% over the year because Earth's orbit is eccentric: perihelion
 * in early January gives ~1412 W/m^2, aphelion in early July ~1322 W/m^2.
 * A power budget sized at the annual mean will brown out in July.
 */
export function solarIrradianceAt(jd) {
  const d = sunDistance(jd);
  const SOLAR_CONSTANT = 1361.0;
  return SOLAR_CONSTANT * (AU / d) ** 2;
}
