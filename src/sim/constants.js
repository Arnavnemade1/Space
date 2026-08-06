/**
 * Physical and geodetic constants.
 *
 * Every value below is a published reference value, not a fitted or invented
 * number. Sources are cited inline so any figure can be audited.
 *
 * Units are strict SI unless the name says otherwise (`_KM`, `_DEG`, ...).
 */

// ---------------------------------------------------------------------------
// Universal constants -- CODATA 2018
// ---------------------------------------------------------------------------

/** Newtonian constant of gravitation [m^3 kg^-1 s^-2]. CODATA 2018. */
export const G_NEWTON = 6.6743e-11;

/** Stefan-Boltzmann constant [W m^-2 K^-4]. CODATA 2018 (exact, from SI redefinition). */
export const SIGMA_SB = 5.670374419e-8;

/** Boltzmann constant [J/K]. Exact by SI definition (2019). */
export const K_BOLTZMANN = 1.380649e-23;

/** Speed of light in vacuum [m/s]. Exact by SI definition. */
export const C_LIGHT = 299792458;

/** Planck constant [J s]. Exact by SI definition (2019). */
export const H_PLANCK = 6.62607015e-34;

/** Universal molar gas constant [J mol^-1 K^-1]. CODATA 2018. */
export const R_UNIVERSAL = 8.314462618;

/**
 * Molar gas constant as used by the US Standard Atmosphere 1976.
 * USSA-76 predates CODATA refinements and defines R* = 8.31432 exactly; using
 * the modern value here would make the model disagree with its own published
 * tables. Kept separate on purpose.
 */
export const R_USSA76 = 8.31432;

/** Standard gravity [m/s^2]. Exact by definition (CGPM 1901). Used for Isp. */
export const G0 = 9.80665;

/** Standard sea-level pressure [Pa]. Exact by definition. */
export const P_SEA_LEVEL = 101325;

/** Astronomical unit [m]. Exact by IAU 2012 definition. */
export const AU = 1.495978707e11;

// ---------------------------------------------------------------------------
// Earth -- WGS84 / EGM96
// ---------------------------------------------------------------------------

/** Earth geocentric gravitational constant GM [m^3/s^2]. WGS84 / EGM96. */
export const MU_EARTH = 3.986004418e14;

/** WGS84 semi-major axis (equatorial radius) [m]. */
export const R_EARTH_EQ = 6378137.0;

/** WGS84 flattening [-]. */
export const EARTH_FLATTENING = 1 / 298.257223563;

/** WGS84 semi-minor axis (polar radius) [m]. Derived: a(1-f). */
export const R_EARTH_POLAR = R_EARTH_EQ * (1 - EARTH_FLATTENING);

/** First eccentricity squared of the WGS84 ellipsoid [-]. Derived: 2f - f^2. */
export const EARTH_E2 = 2 * EARTH_FLATTENING - EARTH_FLATTENING ** 2;

/**
 * Volumetric mean radius [m]: (a^2 b)^(1/3) = 6371000.79 m -- the radius of a
 * sphere with the same volume as the WGS84 ellipsoid.
 *
 * Not to be confused with the IUGG arithmetic mean radius R1 = (2a+b)/3 =
 * 6371008.77 m, which is the number usually quoted as "mean Earth radius".
 * They differ by 8 m. Used only for display and spherical approximations,
 * never in the dynamics.
 */
export const R_EARTH_MEAN = Math.cbrt(R_EARTH_EQ ** 2 * R_EARTH_POLAR);

/** IUGG arithmetic mean radius R1 = (2a + b)/3 [m]. */
export const R_EARTH_MEAN_ARITHMETIC = (2 * R_EARTH_EQ + R_EARTH_POLAR) / 3;

/** Earth rotation rate [rad/s]. WGS84 sidereal value. */
export const OMEGA_EARTH = 7.292115e-5;

/** Sidereal day [s]. 2*pi / OMEGA_EARTH = 86164.09 s. */
export const SIDEREAL_DAY = (2 * Math.PI) / OMEGA_EARTH;

/** Earth mass [kg]. Derived from GM/G. */
export const M_EARTH = MU_EARTH / G_NEWTON;

// Zonal harmonic coefficients (unnormalized), EGM96.
/** J2 oblateness term [-]. Dominant perturbation for Earth orbits. */
export const J2 = 1.082626683553151e-3;
/** J3 pear-shape term [-]. */
export const J3 = -2.5326564853322355e-6;
/** J4 term [-]. */
export const J4 = -1.6196215914968398e-6;

/** Earth's mean Bond albedo [-]. CERES EBAF observations, ~0.294. */
export const EARTH_ALBEDO = 0.294;

/**
 * Earth outgoing longwave radiation at top of atmosphere [W/m^2].
 * CERES EBAF global mean ~239.9 W/m^2.
 */
export const EARTH_IR_FLUX = 239.9;

// ---------------------------------------------------------------------------
// Sun
// ---------------------------------------------------------------------------

/** Sun gravitational parameter [m^3/s^2]. IAU 2015 nominal. */
export const MU_SUN = 1.32712440018e20;

/**
 * Total solar irradiance at 1 AU [W/m^2].
 * SORCE/TIM measured value, 1361 W/m^2 (revised down from the older 1367).
 */
export const SOLAR_CONSTANT = 1361.0;

/** Solar photosphere radius [m]. IAU 2015 nominal. */
export const R_SUN = 6.957e8;

/** Obliquity of the ecliptic at J2000 [rad]. 23.4392911 deg. */
export const OBLIQUITY_J2000 = (23.4392911 * Math.PI) / 180;

/**
 * Solar radiation pressure at 1 AU for a perfectly absorbing surface [Pa].
 * P = S/c = 1361 / 299792458 = 4.5401e-6 Pa.
 */
export const SRP_1AU = SOLAR_CONSTANT / C_LIGHT;

// ---------------------------------------------------------------------------
// Deep space / thermal environment
// ---------------------------------------------------------------------------

/** Cosmic microwave background temperature [K]. COBE/FIRAS. */
export const T_CMB = 2.72548;

// ---------------------------------------------------------------------------
// Common orbital reference altitudes (geometric, above equatorial radius) [m]
// ---------------------------------------------------------------------------

/**
 * Geostationary radius [m]: (mu / omega^2)^(1/3) = 42164172 m.
 * Altitude above the equator is this minus R_EARTH_EQ = 35786 km.
 */
export const R_GEO = Math.cbrt(MU_EARTH / OMEGA_EARTH ** 2);

/** Karman line [m] -- the FAI's nominal edge of space. Not a physical boundary. */
export const KARMAN_LINE = 100000;

// ---------------------------------------------------------------------------
// Unit helpers
// ---------------------------------------------------------------------------

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const DAY = 86400;
export const YEAR_JULIAN = 365.25 * DAY;
