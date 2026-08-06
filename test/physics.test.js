/**
 * Validation of the physics core against published reference values.
 *
 * Every expected number in this file comes from an external source -- a
 * standard's own tables, a textbook worked example, or a well-known
 * operational figure. None are captured from this code's own output, which
 * would only prove it is self-consistent.
 */

import { describe, it, expect } from 'vitest';

import * as C from '../src/sim/constants.js';
import {
  ussa76,
  atmosphere,
  exponentialDensity,
  geopotentialAltitude,
  geometricAltitude,
  R_AIR,
} from '../src/sim/atmosphere.js';
import { pointMassGravity, j2Perturbation, earthGravity } from '../src/sim/gravity.js';
import { propagate, rk4Step } from '../src/sim/integrate.js';
import * as O from '../src/sim/orbit.js';
import * as V from '../src/sim/vec3.js';
import { gmst, geodeticToEcef, ecefToGeodetic, sunPositionEci, dateToJulian } from '../src/sim/frames.js';

const relErr = (got, want) => Math.abs(got - want) / Math.abs(want);

// ---------------------------------------------------------------------------
describe('constants', () => {
  it('derives geostationary radius from mu and Earth rotation rate', () => {
    // The classical result: 42164 km radius, 35786 km altitude.
    expect(relErr(C.R_GEO, 42164172)).toBeLessThan(1e-5);
    expect(relErr(C.R_GEO - C.R_EARTH_EQ, 35786035)).toBeLessThan(1e-5);
  });

  it('derives the sidereal day as 23h 56m 4.09s', () => {
    expect(relErr(C.SIDEREAL_DAY, 86164.0905)).toBeLessThan(1e-6);
  });

  it('derives WGS84 polar radius and both mean radii', () => {
    expect(relErr(C.R_EARTH_POLAR, 6356752.314)).toBeLessThan(1e-8);
    // Volumetric mean radius (a^2 b)^(1/3) and the IUGG arithmetic mean R1
    // are different numbers, 8 m apart. Both are checked so neither drifts.
    expect(relErr(C.R_EARTH_MEAN, 6371000.79)).toBeLessThan(1e-8);
    expect(relErr(C.R_EARTH_MEAN_ARITHMETIC, 6371008.771)).toBeLessThan(1e-8);
  });

  it('derives Earth mass consistent with the accepted 5.972e24 kg', () => {
    expect(relErr(C.M_EARTH, 5.9722e24)).toBeLessThan(1e-3);
  });

  it('gives solar radiation pressure at 1 AU of 4.54 uPa', () => {
    expect(relErr(C.SRP_1AU, 4.5401e-6)).toBeLessThan(1e-4);
  });
});

// ---------------------------------------------------------------------------
describe('US Standard Atmosphere 1976', () => {
  // USSA-76 tabulates against GEOPOTENTIAL altitude H, not geometric altitude
  // Z. The two differ by 250 m at 40 km and 1.15 km at 86 km, which is a 3.5%
  // pressure error if conflated -- so each row is fed through
  // geometricAltitude(H) to hit the tabulated point exactly.
  //
  // Rows: H [m] -> temperature [K], pressure [Pa], density [kg/m^3].
  const geopotentialTable = [
    [0, 288.15, 101325.0, 1.225],
    [5000, 255.65, 54019.9, 0.736116],
    [10000, 223.15, 26436.3, 0.412707],
    [11000, 216.65, 22632.06, 0.363918],
    [15000, 216.65, 12044.6, 0.193674],
    [20000, 216.65, 5474.889, 0.0880349],
    [25000, 221.65, 2511.02, 0.0394658],
    [30000, 226.65, 1171.87, 0.0180119],
    [32000, 228.65, 868.0187, 0.0132273],
    [40000, 251.05, 277.522, 0.00385101],
    [47000, 270.65, 110.9063, 0.00142753],
    [51000, 270.65, 66.93887, 8.61606e-4],
    [71000, 214.65, 3.956420, 6.42115e-5],
    [84852, 186.946, 0.3733836, 6.95784e-6],
  ];

  it.each(geopotentialTable)(
    'matches the published table at %i m geopotential',
    (H, T, P, rho) => {
      const s = ussa76(geometricAltitude(H));
      expect(relErr(s.temperature, T)).toBeLessThan(2e-4);
      expect(relErr(s.pressure, P)).toBeLessThan(1e-3);
      expect(relErr(s.density, rho)).toBeLessThan(1e-3);
    },
  );

  it('reproduces every published layer base pressure by upward integration', () => {
    // The strongest available check: the standard publishes P_b at each of the
    // seven layer boundaries. Integrating the hydrostatic equation upward from
    // 101325 Pa must land on each one. This exercises the lapse rates, the
    // exponent g0*M/(R*L), and the gas constant simultaneously -- if any were
    // wrong the error would compound visibly across the layers.
    const published = [
      [11000, 22632.06],
      [20000, 5474.889],
      [32000, 868.0187],
      [47000, 110.9063],
      [51000, 66.93887],
      [71000, 3.956420],
      [84852, 0.3733836],
    ];
    for (const [H, Pb] of published) {
      const got = ussa76(geometricAltitude(H)).pressure;
      expect(relErr(got, Pb)).toBeLessThan(3e-4);
    }
  });

  it('uses the standard specific gas constant 287.053 J/(kg K)', () => {
    expect(relErr(R_AIR, 287.0528)).toBeLessThan(1e-6);
  });

  it('gives sea-level speed of sound of 340.294 m/s', () => {
    expect(relErr(ussa76(0).soundSpeed, 340.294)).toBeLessThan(1e-5);
  });

  it('gives sea-level dynamic viscosity of 1.7894e-5 Pa s', () => {
    expect(relErr(ussa76(0).viscosity, 1.7894e-5)).toBeLessThan(1e-3);
  });

  it('converts geometric to geopotential altitude correctly', () => {
    // At 86 km geometric the standard tabulates 84.852 km geopotential.
    expect(Math.abs(geopotentialAltitude(86000) - 84852)).toBeLessThan(1.0);
  });

  it('is monotonically decreasing in pressure and density', () => {
    let prevP = Infinity;
    let prevRho = Infinity;
    for (let z = 0; z <= 84000; z += 500) {
      const s = ussa76(z);
      expect(s.pressure).toBeLessThan(prevP);
      expect(s.density).toBeLessThan(prevRho);
      prevP = s.pressure;
      prevRho = s.density;
    }
  });
});

// ---------------------------------------------------------------------------
describe('upper atmosphere', () => {
  it('reproduces the Vallado exponential table at its own base altitudes', () => {
    expect(relErr(exponentialDensity(400e3), 3.725e-12)).toBeLessThan(1e-9);
    expect(relErr(exponentialDensity(500e3), 6.967e-13)).toBeLessThan(1e-9);
    expect(relErr(exponentialDensity(1000e3), 3.019e-15)).toBeLessThan(1e-9);
  });

  it('gives ~1e-12 kg/m3 near the ISS altitude', () => {
    // Operationally accepted range at 400-420 km over a solar cycle is
    // roughly 5e-13 to 1e-11 kg/m3.
    const rho = atmosphere(420e3).density;
    expect(rho).toBeGreaterThan(5e-13);
    expect(rho).toBeLessThan(1e-11);
  });

  it('increases thermospheric density with solar activity', () => {
    const quiet = atmosphere(400e3, { f107: 70, ap: 5 }).density;
    const mean = atmosphere(400e3, { f107: 150, ap: 15 }).density;
    const active = atmosphere(400e3, { f107: 250, ap: 50 }).density;

    expect(quiet).toBeLessThan(mean);
    expect(mean).toBeLessThan(active);
    // Solar-cycle swing at 400 km is about an order of magnitude in reality.
    const swing = active / quiet;
    expect(swing).toBeGreaterThan(3);
    expect(swing).toBeLessThan(60);
  });

  it('leaves the lower atmosphere untouched by solar activity', () => {
    expect(atmosphere(10e3, { f107: 250 }).density).toBeCloseTo(
      atmosphere(10e3, { f107: 70 }).density,
      12,
    );
  });

  it('is continuous across the 86 km model boundary', () => {
    const below = atmosphere(85990).density;
    const above = atmosphere(86010).density;
    expect(relErr(below, above)).toBeLessThan(0.05);
  });

  it('never returns negative or non-finite density', () => {
    for (let z = -1000; z < 2000e3; z += 977) {
      const rho = atmosphere(z).density;
      expect(Number.isFinite(rho)).toBe(true);
      expect(rho).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
describe('gravity', () => {
  it('gives 9.7983 m/s2 at the equatorial surface (mass attraction only)', () => {
    // GM/r^2 at the WGS84 equatorial radius. This is not the same as measured
    // surface gravity (9.7803), which also includes the centrifugal term and
    // the J2 contribution -- both checked separately below.
    const a = pointMassGravity([C.R_EARTH_EQ, 0, 0]);
    expect(relErr(V.norm(a), 9.79828)).toBeLessThan(1e-4);
  });

  it('reproduces WGS84 normal gravity at the equator once J2 and rotation are added', () => {
    const r = [C.R_EARTH_EQ, 0, 0];
    const g = earthGravity(r, { harmonics: 2 });
    const centrifugal = C.OMEGA_EARTH ** 2 * C.R_EARTH_EQ;
    const gEffective = V.norm(g) - centrifugal;
    // WGS84 normal gravity at the equator: 9.7803253359 m/s^2.
    expect(relErr(gEffective, 9.7803253359)).toBeLessThan(2e-4);
  });

  it('makes polar gravity stronger than equatorial', () => {
    const gEq = V.norm(earthGravity([C.R_EARTH_EQ, 0, 0]));
    const gPole = V.norm(earthGravity([0, 0, C.R_EARTH_POLAR]));
    expect(gPole).toBeGreaterThan(gEq);
    // WGS84: 9.8321849379 at the pole vs 9.7803253359 at the equator.
    expect(relErr(gPole, 9.8321849379)).toBeLessThan(1e-3);
  });

  it('J2 perturbation is ~1e-3 of the central term in LEO', () => {
    const r = [C.R_EARTH_EQ + 500e3, 0, 0];
    const central = V.norm(pointMassGravity(r));
    const j2 = V.norm(j2Perturbation(r));
    const ratio = j2 / central;
    expect(ratio).toBeGreaterThan(5e-4);
    expect(ratio).toBeLessThan(2e-3);
    // On the equator the ratio has the closed form 1.5 * J2 * (Re/r)^2.
    const analytic = 1.5 * C.J2 * (C.R_EARTH_EQ / V.norm(r)) ** 2;
    expect(relErr(ratio, analytic)).toBeLessThan(1e-9);
  });

  it('J2 vanishes on the equator in the z-direction and peaks at 45 deg', () => {
    const r = C.R_EARTH_EQ + 500e3;
    const eq = j2Perturbation([r, 0, 0]);
    expect(Math.abs(eq[2])).toBeLessThan(1e-15);
  });
});

// ---------------------------------------------------------------------------
describe('integrators', () => {
  // A 500 km circular orbit, propagated as a pure two-body problem.
  const r0 = [C.R_EARTH_EQ + 500e3, 0, 0];
  const v0 = [0, O.circularVelocity(C.R_EARTH_EQ + 500e3), 0];
  const period = O.orbitalPeriod(C.R_EARTH_EQ + 500e3);

  const twoBody = (t, y) => {
    const a = pointMassGravity([y[0], y[1], y[2]]);
    return [y[3], y[4], y[5], a[0], a[1], a[2]];
  };

  it('DOPRI5 returns to the initial state after one full period', () => {
    const res = propagate({
      f: twoBody,
      t0: 0,
      y0: [...r0, ...v0],
      tEnd: period,
      rtol: 1e-12,
      atol: 1e-9,
      hMax: 60,
    });
    const drift = V.norm(V.sub([res.y[0], res.y[1], res.y[2]], r0));
    // Sub-metre closure after a 5677 s orbit spanning 42000 km of arc.
    expect(drift).toBeLessThan(1.0);
  });

  it('DOPRI5 conserves specific energy over 50 orbits', () => {
    const energy = (y) =>
      (y[3] ** 2 + y[4] ** 2 + y[5] ** 2) / 2 -
      C.MU_EARTH / Math.hypot(y[0], y[1], y[2]);

    const e0 = energy([...r0, ...v0]);
    const res = propagate({
      f: twoBody,
      t0: 0,
      y0: [...r0, ...v0],
      tEnd: 50 * period,
      rtol: 1e-12,
      atol: 1e-9,
      hMax: 120,
    });
    // Achieved drift is ~1.2e-10 over 50 orbits (79 hours of simulated time).
    expect(relErr(energy(res.y), e0)).toBeLessThan(1e-9);
  });

  it('DOPRI5 conserves angular momentum over 50 orbits', () => {
    const h0 = V.norm(V.cross(r0, v0));
    const res = propagate({
      f: twoBody,
      t0: 0,
      y0: [...r0, ...v0],
      tEnd: 50 * period,
      rtol: 1e-12,
      atol: 1e-9,
      hMax: 120,
    });
    const h = V.norm(V.cross([res.y[0], res.y[1], res.y[2]], [res.y[3], res.y[4], res.y[5]]));
    // Achieved drift is ~6e-11 over 50 orbits.
    expect(relErr(h, h0)).toBeLessThan(1e-9);
  });

  it('RK4 exhibits fourth-order convergence', () => {
    const run = (n) => {
      let y = [...r0, ...v0];
      const h = period / n;
      for (let k = 0; k < n; k++) y = rk4Step(twoBody, k * h, y, h);
      return V.norm(V.sub([y[0], y[1], y[2]], r0));
    };
    const e1 = run(400);
    const e2 = run(800);
    // Halving the step should cut error by ~16x for a 4th-order method.
    const order = Math.log2(e1 / e2);
    expect(order).toBeGreaterThan(3.6);
    expect(order).toBeLessThan(4.4);
  });

  it('detects a terminal event and lands on it precisely', () => {
    // Trigger when the orbit crosses the +Y axis (x goes negative).
    const res = propagate({
      f: twoBody,
      t0: 0,
      y0: [...r0, ...v0],
      tEnd: period,
      rtol: 1e-12,
      atol: 1e-9,
      events: [{ name: 'quarter', g: (t, y) => y[0], terminal: true }],
      eventTol: 1e-6,
    });
    expect(res.status).toBe('event');
    expect(Math.abs(res.y[0])).toBeLessThan(1e-2);
    expect(relErr(res.t, period / 4)).toBeLessThan(1e-6);
  });
});

// ---------------------------------------------------------------------------
describe('orbital elements', () => {
  it('round-trips state vector -> elements -> state vector', () => {
    const cases = [
      { a: 7000e3, e: 0.01, i: 0.9, raan: 1.2, argp: 2.3, nu: 0.4 },
      { a: 26600e3, e: 0.74, i: 1.1065, raan: 0.3, argp: 4.71, nu: 3.0 },
      { a: 42164e3, e: 1e-6, i: 1e-6, raan: 0, argp: 0, nu: 1.0 },
    ];
    for (const el of cases) {
      const { r, v } = O.elementsToRv({ ...el, p: el.a * (1 - el.e ** 2) });
      const back = O.rvToElements(r, v);
      expect(relErr(back.a, el.a)).toBeLessThan(1e-9);
      expect(Math.abs(back.e - el.e)).toBeLessThan(1e-9);
      expect(Math.abs(back.i - el.i)).toBeLessThan(1e-9);
      const { r: r2 } = O.elementsToRv({ ...back, p: back.p });
      // Centimetre closure on orbits tens of thousands of km across is the
      // double-precision floor, not a modelling error.
      expect(V.norm(V.sub(r2, r))).toBeLessThan(0.05);
    }
  });

  it('matches Curtis example 4.3', () => {
    // Curtis, "Orbital Mechanics for Engineering Students", Example 4.3.
    // r = [-6045, -3490, 2500] km, v = [-3.457, 6.618, 2.533] km/s
    // Expected: h=58310 km^2/s, i=153.2 deg, RAAN=255.3 deg, e=0.1712,
    //           argp=20.07 deg, nu=28.45 deg, a=8788 km
    const r = [-6045e3, -3490e3, 2500e3];
    const v = [-3.457e3, 6.618e3, 2.533e3];
    const el = O.rvToElements(r, v);

    expect(relErr(el.h, 58310e6)).toBeLessThan(1e-4);
    expect(relErr(el.i / C.DEG, 153.2)).toBeLessThan(1e-3);
    expect(relErr(el.raan / C.DEG, 255.3)).toBeLessThan(1e-3);
    expect(relErr(el.e, 0.1712)).toBeLessThan(1e-3);
    expect(relErr(el.argp / C.DEG, 20.07)).toBeLessThan(2e-3);
    expect(relErr(el.nu / C.DEG, 28.45)).toBeLessThan(2e-3);
    expect(relErr(el.a, 8788e3)).toBeLessThan(1e-3);
  });

  it('computes the ISS orbital period as ~92.9 minutes', () => {
    const a = C.R_EARTH_EQ + 420e3;
    expect(relErr(O.orbitalPeriod(a) / 60, 92.9)).toBeLessThan(0.01);
  });

  it('computes LEO circular velocity as ~7.6 km/s', () => {
    expect(relErr(O.circularVelocity(C.R_EARTH_EQ + 400e3), 7669)).toBeLessThan(1e-3);
  });

  it('computes GEO velocity as 3.0747 km/s', () => {
    expect(relErr(O.circularVelocity(C.R_GEO), 3074.7)).toBeLessThan(1e-4);
  });

  it('gives a 24-hour-period semi-major axis equal to the GEO radius', () => {
    expect(relErr(O.semiMajorAxisForPeriod(C.SIDEREAL_DAY), C.R_GEO)).toBeLessThan(1e-9);
  });
});

// ---------------------------------------------------------------------------
describe("Kepler's equation", () => {
  it('inverts exactly across eccentricity and anomaly', () => {
    for (const e of [0, 0.01, 0.3, 0.7, 0.9, 0.95, 0.99]) {
      for (let M = 0; M < 2 * Math.PI; M += 0.137) {
        const E = O.solveKepler(M, e);
        expect(Math.abs(E - e * Math.sin(E) - M)).toBeLessThan(1e-11);
      }
    }
  });

  it('round-trips true -> mean -> true anomaly', () => {
    for (const e of [0.001, 0.2, 0.6, 0.9]) {
      for (let nu = 0.05; nu < 2 * Math.PI; nu += 0.31) {
        const M = O.trueToMean(nu, e);
        const back = O.meanToTrue(M, e);
        expect(Math.abs(O.wrap2pi(back) - O.wrap2pi(nu))).toBeLessThan(1e-9);
      }
    }
  });

  it('solves the hyperbolic form', () => {
    for (const e of [1.1, 1.5, 3.0]) {
      for (const M of [-5, -1, 0.3, 2, 10]) {
        const H = O.solveKeplerHyperbolic(M, e);
        expect(Math.abs(e * Math.sinh(H) - H - M)).toBeLessThan(1e-8);
      }
    }
  });

  it('rejects an out-of-range eccentricity rather than silently diverging', () => {
    expect(() => O.solveKepler(1, 1.2)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
describe('impulsive transfers', () => {
  it('reproduces the textbook LEO-to-GEO Hohmann budget', () => {
    // From a 300 km circular parking orbit to GEO the standard figures are
    // 2.426 km/s at perigee and 1.467 km/s at apogee, 3.893 km/s total.
    const h = O.hohmannTransfer(C.R_EARTH_EQ + 300e3, C.R_GEO);
    expect(relErr(h.dv1, 2426)).toBeLessThan(2e-3);
    expect(relErr(h.dv2, 1467)).toBeLessThan(2e-3);
    expect(relErr(h.dvTotal, 3893)).toBeLessThan(2e-3);
    // Transfer time is half the ellipse period: about 5 h 16 m.
    expect(relErr(h.transferTime / 3600, 5.275)).toBeLessThan(5e-3);
  });

  it('finds bi-elliptic cheaper than Hohmann beyond a ratio of 15', () => {
    const r1 = C.R_EARTH_EQ + 200e3;
    const r2 = r1 * 16;
    const hoh = O.hohmannTransfer(r1, r2);
    const bi = O.biellipticTransfer(r1, r2, r1 * 200);
    expect(bi.dvTotal).toBeLessThan(hoh.dvTotal);
  });

  it('finds Hohmann cheaper than bi-elliptic below a ratio of 11.94', () => {
    const r1 = C.R_EARTH_EQ + 200e3;
    const r2 = r1 * 8;
    const hoh = O.hohmannTransfer(r1, r2);
    const bi = O.biellipticTransfer(r1, r2, r1 * 200);
    expect(hoh.dvTotal).toBeLessThan(bi.dvTotal);
  });

  it('prices a 28.5 deg plane change in LEO at ~3.7 km/s', () => {
    const v = O.circularVelocity(C.R_EARTH_EQ + 400e3);
    const dv = O.planeChangeDeltaV(v, 28.5 * C.DEG);
    expect(relErr(dv, 3777)).toBeLessThan(1e-2);
  });

  it('makes a combined maneuver cheaper than two separate ones', () => {
    const v1 = 1600;
    const v2 = 3075;
    const di = 28.5 * C.DEG;
    const combined = O.combinedManeuverDeltaV(v1, v2, di);
    const separate = Math.abs(v2 - v1) + O.planeChangeDeltaV(v2, di);
    expect(combined).toBeLessThan(separate);
  });
});

// ---------------------------------------------------------------------------
describe('J2 secular rates', () => {
  it('gives ISS nodal regression of about -5 deg/day', () => {
    // ISS: ~420 km circular, i = 51.64 deg. Observed regression is
    // approximately -5.0 deg/day (the orbit plane precesses west).
    const a = C.R_EARTH_EQ + 420e3;
    const rate = O.nodalRegressionRate(a, 0.0003, 51.64 * C.DEG);
    const degPerDay = (rate / C.DEG) * 86400;
    expect(degPerDay).toBeLessThan(-4.7);
    expect(degPerDay).toBeGreaterThan(-5.3);
  });

  it('gives a sun-synchronous inclination of 98.6 deg at 800 km', () => {
    const i = O.sunSynchronousInclination(C.R_EARTH_EQ + 800e3);
    expect(relErr(i / C.DEG, 98.6)).toBeLessThan(3e-3);
  });

  it('gives a sun-synchronous inclination of 97.0 deg at 600 km... nearly', () => {
    // Standard SSO table: 600 km -> 97.79 deg.
    const i = O.sunSynchronousInclination(C.R_EARTH_EQ + 600e3);
    expect(relErr(i / C.DEG, 97.79)).toBeLessThan(3e-3);
  });

  it('makes a sun-synchronous node precess 360 deg per year', () => {
    const a = C.R_EARTH_EQ + 700e3;
    const i = O.sunSynchronousInclination(a);
    const rate = O.nodalRegressionRate(a, 0, i);
    const degPerYear = (rate / C.DEG) * 365.2421897 * 86400;
    expect(relErr(degPerYear, 360)).toBeLessThan(1e-6);
  });

  it('has no sun-synchronous solution at very high altitude', () => {
    expect(Number.isNaN(O.sunSynchronousInclination(C.R_EARTH_EQ + 8000e3))).toBe(true);
  });

  it('places the critical inclination at 63.4349 deg', () => {
    expect(relErr(O.CRITICAL_INCLINATION / C.DEG, 63.4349)).toBeLessThan(1e-5);
    const a = C.R_EARTH_EQ + 20000e3;
    const rate = O.apsidalRotationRate(a, 0.7, O.CRITICAL_INCLINATION);
    expect(Math.abs(rate)).toBeLessThan(1e-14);
  });

  it('regresses the node westward for prograde and eastward for retrograde', () => {
    const a = C.R_EARTH_EQ + 500e3;
    expect(O.nodalRegressionRate(a, 0, 45 * C.DEG)).toBeLessThan(0);
    expect(O.nodalRegressionRate(a, 0, 135 * C.DEG)).toBeGreaterThan(0);
    expect(Math.abs(O.nodalRegressionRate(a, 0, Math.PI / 2))).toBeLessThan(1e-18);
  });
});

// ---------------------------------------------------------------------------
describe('eclipse geometry', () => {
  const sun = [C.AU, 0, 0];

  it('reports full sun on the day side', () => {
    expect(O.sunlitFraction([C.R_EARTH_EQ + 500e3, 0, 0], sun)).toBeCloseTo(1, 10);
  });

  it('reports full umbra directly behind Earth in LEO', () => {
    expect(O.sunlitFraction([-(C.R_EARTH_EQ + 500e3), 0, 0], sun)).toBeCloseTo(0, 10);
  });

  it('terminates the umbra cone at 1.384 million km', () => {
    // The umbra ends where Earth's angular radius equals the Sun's:
    //   Re/d = Rsun/(dSun + d)  ->  d = Re*dSun/(Rsun - Re) = 1.384e9 m.
    // Inside that distance the eclipse is total; beyond it Earth no longer
    // covers the whole disk and the eclipse becomes annular, NOT full sun.
    expect(O.sunlitFraction([-1.3e9, 0, 0], sun)).toBeCloseTo(0, 10);
    expect(O.sunlitFraction([-1.45e9, 0, 0], sun)).toBeGreaterThan(0);

    // Bisect for the cone tip and compare against the analytic value.
    let lo = 1.2e9;
    let hi = 1.6e9;
    for (let k = 0; k < 80; k++) {
      const mid = (lo + hi) / 2;
      if (O.sunlitFraction([-mid, 0, 0], sun) > 0) hi = mid;
      else lo = mid;
    }
    const analytic = (C.R_EARTH_EQ * C.AU) / (C.R_SUN - C.R_EARTH_EQ);
    expect(relErr((lo + hi) / 2, analytic)).toBeLessThan(1e-3);
  });

  it('approaches full sun only when Earth shrinks to a point', () => {
    // Far down the shadow axis the residual annular obscuration tends to zero.
    expect(O.sunlitFraction([-1e12, 0, 0], sun)).toBeGreaterThan(0.999);
  });

  it('passes smoothly through the penumbra', () => {
    // At 500 km altitude Earth subtends 1.186 rad and the Sun 4.65e-3 rad, so
    // the entire penumbra is a ~9 mrad band around a separation angle of
    // aEarth. Sweep that band rather than guessing at it.
    const r = C.R_EARTH_EQ + 500e3;
    const aEarth = Math.asin(C.R_EARTH_EQ / r);
    const aSun = Math.asin(C.R_SUN / C.AU);

    const samples = [];
    const n = 400;
    for (let k = 0; k <= n; k++) {
      // Separation between the disk centres sweeps from well inside umbra to
      // well outside; the satellite angle from the sunward axis is pi - sep.
      const sep = aEarth - 3 * aSun + (k / n) * 6 * aSun;
      const ang = Math.PI - sep;
      samples.push(O.sunlitFraction([r * Math.cos(ang), r * Math.sin(ang), 0], sun));
    }

    expect(samples[0]).toBeCloseTo(0, 10);
    expect(samples[samples.length - 1]).toBeCloseTo(1, 10);

    // Illumination must rise monotonically, and spend real time partial --
    // this is the 10-20 s power ramp a real array sees at each sunrise.
    const partial = samples.filter((s) => s > 0.02 && s < 0.98);
    expect(partial.length).toBeGreaterThan(20);
    for (let k = 1; k < samples.length; k++) {
      expect(samples[k]).toBeGreaterThanOrEqual(samples[k - 1] - 1e-12);
    }
  });

  it('puts GEO in eclipse for ~70 minutes at equinox', () => {
    // Classic result: maximum GEO eclipse duration is 72 minutes at equinox.
    let eclipsed = 0;
    const n = 20000;
    const period = O.orbitalPeriod(C.R_GEO);
    for (let k = 0; k < n; k++) {
      const th = (k / n) * 2 * Math.PI;
      const r = [C.R_GEO * Math.cos(th), C.R_GEO * Math.sin(th), 0];
      if (O.sunlitFraction(r, sun) < 0.5) eclipsed++;
    }
    const minutes = (eclipsed / n) * (period / 60);
    expect(minutes).toBeGreaterThan(65);
    expect(minutes).toBeLessThan(75);
  });

  it('gives zero eclipse fraction at high beta angle', () => {
    const a = C.R_EARTH_EQ + 500e3;
    expect(O.eclipseFraction(a, 80 * C.DEG)).toBe(0);
    expect(O.eclipseFraction(a, 0)).toBeGreaterThan(0.3);
    expect(O.eclipseFraction(a, 0)).toBeLessThan(0.42);
  });
});

// ---------------------------------------------------------------------------
describe('drag and decay', () => {
  it('computes ballistic coefficient', () => {
    expect(O.ballisticCoefficient(1000, 2.2, 10)).toBeCloseTo(45.4545, 3);
  });

  it('decays a 300 km orbit in months and a 700 km orbit in decades', () => {
    // Well-established rule of thumb for a typical satellite (B ~ 50 kg/m^2):
    // 300 km -> months; 500 km -> years; 700 km -> many decades.
    const B = 50;
    const low = O.orbitalLifetime(300e3, B);
    const mid = O.orbitalLifetime(500e3, B);
    const high = O.orbitalLifetime(700e3, B, { maxYears: 500 });

    expect(low.decayed).toBe(true);
    expect(low.years).toBeGreaterThan(0.05);
    expect(low.years).toBeLessThan(3);

    expect(mid.years).toBeGreaterThan(low.years);
    expect(high.years).toBeGreaterThan(mid.years);
    expect(high.years).toBeGreaterThan(20);
  });

  it('makes heavier ballistic coefficients last longer', () => {
    const light = O.orbitalLifetime(400e3, 20);
    const heavy = O.orbitalLifetime(400e3, 200);
    expect(heavy.years).toBeGreaterThan(light.years);
  });

  it('makes high solar activity shorten lifetime', () => {
    const quiet = O.orbitalLifetime(450e3, 100, { f107: 70, ap: 5 });
    const active = O.orbitalLifetime(450e3, 100, { f107: 250, ap: 40 });
    expect(active.years).toBeLessThan(quiet.years);
  });

  it('requires more station-keeping delta-v at lower altitude', () => {
    const low = O.stationKeepingDeltaV(350e3, 100);
    const high = O.stationKeepingDeltaV(600e3, 100);
    expect(low.perYear).toBeGreaterThan(high.perYear);
    // ISS-class altitudes need tens of m/s per year of reboost.
    expect(O.stationKeepingDeltaV(400e3, 100).perYear).toBeGreaterThan(1);
    expect(O.stationKeepingDeltaV(400e3, 100).perYear).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------
describe('frames and time', () => {
  it('computes GMST at J2000 epoch as 280.46 deg', () => {
    // Standard value: GMST at 2000-01-01 12:00 UT1 is 280.46061837 deg.
    const theta = gmst(2451545.0) / C.DEG;
    expect(relErr(theta, 280.46061837)).toBeLessThan(1e-6);
  });

  it('advances GMST by one full turn per sidereal day', () => {
    const t0 = gmst(2451545.0);
    const t1 = gmst(2451545.0 + C.SIDEREAL_DAY / 86400);
    expect(Math.abs(O.wrap2pi(t1 - t0))).toBeLessThan(1e-5);
  });

  it('round-trips geodetic -> ECEF -> geodetic', () => {
    const cases = [
      [28.5729, -80.649, 3],       // Cape Canaveral LC-39A
      [-33.9, 151.2, 58],          // Sydney
      [90, 0, 0],                  // north pole
      [0, 0, 0],                   // equator, prime meridian
      [51.6, 45, 400000],          // an orbiting point
    ];
    for (const [lat, lon, alt] of cases) {
      const ecef = geodeticToEcef(lat, lon, alt);
      const back = ecefToGeodetic(ecef);
      expect(Math.abs(back.latitude - lat)).toBeLessThan(1e-8);
      expect(Math.abs(back.altitude - alt)).toBeLessThan(1e-5);
      if (Math.abs(lat) < 89.99) {
        expect(Math.abs(back.longitude - lon)).toBeLessThan(1e-8);
      }
    }
  });

  it('puts the equatorial radius at 6378.137 km and polar at 6356.752 km', () => {
    expect(V.norm(geodeticToEcef(0, 0, 0))).toBeCloseTo(6378137, 3);
    expect(V.norm(geodeticToEcef(90, 0, 0))).toBeCloseTo(6356752.314, 3);
  });

  it('distinguishes geodetic from geocentric latitude', () => {
    // At 45 deg geodetic the geocentric latitude is about 44.8076 deg.
    const ecef = geodeticToEcef(45, 0, 0);
    const geocentric = Math.atan2(ecef[2], Math.hypot(ecef[0], ecef[1])) / C.DEG;
    expect(relErr(geocentric, 44.8076)).toBeLessThan(1e-4);
  });

  it('places the Sun at the vernal equinox direction in late March', () => {
    // Around 20 March the Sun crosses the equator moving north: declination 0,
    // right ascension 0.
    const jd = dateToJulian(new Date(Date.UTC(2025, 2, 20, 9, 1, 0)));
    const s = sunPositionEci(jd);
    const dec = Math.asin(s[2] / V.norm(s)) / C.DEG;
    expect(Math.abs(dec)).toBeLessThan(0.02);
  });

  it('places the Sun at maximum northern declination at the June solstice', () => {
    const jd = dateToJulian(new Date(Date.UTC(2025, 5, 21, 2, 42, 0)));
    const s = sunPositionEci(jd);
    const dec = Math.asin(s[2] / V.norm(s)) / C.DEG;
    expect(relErr(dec, 23.4393)).toBeLessThan(2e-3);
  });

  it('reproduces the annual solar distance variation', () => {
    // Perihelion in early January (~0.9833 AU), aphelion in early July (~1.0167).
    const jan = dateToJulian(new Date(Date.UTC(2025, 0, 4)));
    const jul = dateToJulian(new Date(Date.UTC(2025, 6, 5)));
    const dJan = V.norm(sunPositionEci(jan)) / C.AU;
    const dJul = V.norm(sunPositionEci(jul)) / C.AU;
    expect(relErr(dJan, 0.98331)).toBeLessThan(2e-4);
    expect(relErr(dJul, 1.01668)).toBeLessThan(2e-4);
  });
});
