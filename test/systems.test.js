/**
 * Validation of the spacecraft subsystem and launch-vehicle models.
 *
 * As in physics.test.js, expected values are external: closed-form results,
 * textbook link-budget examples, published vehicle performance, or physical
 * identities that must hold regardless of implementation.
 */

import { describe, it, expect } from 'vitest';

import * as C from '../src/sim/constants.js';
import * as T from '../src/sim/thermal.js';
import * as P from '../src/sim/power.js';
import * as R from '../src/sim/radiation.js';
import * as Comms from '../src/sim/comms.js';
import { VEHICLES, LAUNCH_SITES, nozzleExitArea, stageThrust, idealDeltaV, grossMass, launchAzimuth, rotationBonus } from '../src/sim/vehicles.js';
import { simulateAscent, dragCoefficient, clampAngleOfAttack } from '../src/sim/ascent.js';
import { designDatacenter } from '../src/sim/datacenter.js';
import { compare, terrestrialCost } from '../src/sim/economics.js';
import * as V from '../src/sim/vec3.js';

const relErr = (got, want) => Math.abs(got - want) / Math.abs(want);

// ---------------------------------------------------------------------------
describe('thermal', () => {
  it('reproduces the Stefan-Boltzmann law exactly', () => {
    // A blackbody at 300 K radiates sigma*T^4 = 459.3 W/m^2 from one side.
    const flux = T.radiatorFluxPerArea(300, { epsilon: 1, sides: 1, sinkTemp: 0 });
    expect(relErr(flux, C.SIGMA_SB * 300 ** 4)).toBeLessThan(1e-12);
    expect(relErr(flux, 459.3)).toBeLessThan(1e-3);
  });

  it('gives the effective temperature of a sphere at 1 AU', () => {
    // Absorbed = S * pi r^2, emitted = 4 pi r^2 sigma T^4, so T = (S/4sigma)^(1/4).
    // The textbook figure is usually quoted as 278.6 K, but that comes from the
    // older S = 1367 W/m^2. With the modern TIM value of 1361 it is 278.3 K.
    const T_eff = Math.pow(C.SOLAR_CONSTANT / (4 * C.SIGMA_SB), 0.25);
    expect(relErr(T_eff, 278.3)).toBeLessThan(1e-3);
    expect(relErr(Math.pow(1367 / (4 * C.SIGMA_SB), 0.25), 278.6)).toBeLessThan(1e-3);
    expect(relErr(T.equilibriumTemperature(C.SOLAR_CONSTANT, 1, 4), T_eff)).toBeLessThan(1e-9);
  });

  it('scales rejection as the fourth power of temperature', () => {
    const cold = T.radiatorFluxPerArea(300, { epsilon: 1, sides: 1, sinkTemp: 0 });
    const hot = T.radiatorFluxPerArea(600, { epsilon: 1, sides: 1, sinkTemp: 0 });
    expect(relErr(hot / cold, 16)).toBeLessThan(1e-9);
  });

  it('rejects about 1 kW per square metre from a double-sided 320 K radiator', () => {
    // 2 * 0.9 * sigma * 320^4 = 1046 W/m^2. This single figure is what sets the
    // size of every orbital datacenter concept.
    const flux = T.radiatorFluxPerArea(320, { epsilon: 0.9, sides: 2 });
    expect(flux).toBeGreaterThan(900);
    expect(flux).toBeLessThan(1200);
  });

  it('sizes a 1 MW radiator at roughly 1000 square metres', () => {
    const r = T.sizeRadiator({ heatLoad: 1e6, radiatorEfficiency: 1, alpha: 0.17 });
    expect(r.feasible).toBe(true);
    expect(r.area).toBeGreaterThan(700);
    expect(r.area).toBeLessThan(1600);
  });

  it('accounts for the temperature drop from junction to radiator', () => {
    // Sizing at the junction temperature instead of the radiator temperature
    // understates the area needed by roughly a third.
    const naive = T.radiatorFluxPerArea(358.15, { epsilon: 0.9, sides: 2 });
    const real = T.radiatorFluxPerArea(358.15 - 40, { epsilon: 0.9, sides: 2 });
    expect(real / naive).toBeGreaterThan(0.55);
    expect(real / naive).toBeLessThan(0.75);
  });

  it('declares a radiator infeasible when it absorbs more than it emits', () => {
    // A cold radiator facing the Sun head-on with an absorbing coating.
    const r = T.sizeRadiator({
      heatLoad: 1e6,
      junctionTemp: 300,
      junctionToCoolant: 0,
      coolantToRadiator: 0,
      alpha: 0.95,
      epsilon: 0.5,
      sunIncidenceAngle: 0,
      tiltFromNadir: 0,
    });
    expect(r.feasible).toBe(false);
    expect(r.area).toBe(Infinity);
  });

  it('makes an edge-on radiator see no Earth flux', () => {
    expect(T.earthViewFactor(C.R_EARTH_EQ + 500e3, Math.PI / 2)).toBeCloseTo(0, 12);
    // Facing straight down at 500 km it sees (Re/r)^2 = 0.86.
    expect(relErr(T.earthViewFactor(C.R_EARTH_EQ + 500e3, 0), (C.R_EARTH_EQ / (C.R_EARTH_EQ + 500e3)) ** 2)).toBeLessThan(1e-12);
  });

  it('separates albedo (solar band) from Earth IR (infrared band)', () => {
    // A radiator coating with low alpha and high epsilon absorbs little albedo
    // but plenty of Earth IR -- treating them with one coefficient is wrong.
    const flux = T.environmentalFlux({
      orbitRadius: C.R_EARTH_EQ + 500e3,
      alpha: 0.17,
      epsilon: 0.92,
      sunIncidenceAngle: Math.PI / 2,
      tiltFromNadir: 0,
    });
    expect(flux.direct).toBeCloseTo(0, 10);
    expect(flux.earthIr).toBeGreaterThan(flux.albedo * 2);
  });

  it('computes a physically sensible time to overheat with cooling lost', () => {
    // 100 t at 1 kJ/(kg K) absorbing 10 MW heats at 0.1 K/s: 45 K in ~450 s.
    const r = T.timeToOverheat({
      heatLoad: 10e6,
      thermalMass: 100e3 * 1000,
      startTemp: 313,
      limitTemp: 358,
    });
    expect(r.seconds).toBeGreaterThan(300);
    expect(r.seconds).toBeLessThan(600);
  });
});

// ---------------------------------------------------------------------------
describe('power', () => {
  it('computes array output from irradiance, area and efficiency', () => {
    const p = P.arrayPower({ area: 100, efficiency: 0.3, packingFactor: 1, sunlit: 1 });
    expect(relErr(p, 1361 * 100 * 0.3)).toBeLessThan(1e-12);
  });

  it('reduces output by the cosine of the incidence angle', () => {
    const straight = P.arrayPower({ area: 10, efficiency: 0.3, incidenceAngle: 0, packingFactor: 1 });
    const angled = P.arrayPower({ area: 10, efficiency: 0.3, incidenceAngle: Math.PI / 3, packingFactor: 1 });
    expect(relErr(angled / straight, 0.5)).toBeLessThan(1e-12);
  });

  it('applies compounding annual degradation', () => {
    const p0 = P.arrayPower({ area: 10, efficiency: 0.3, years: 0, degradationPerYear: 0.02 });
    const p10 = P.arrayPower({ area: 10, efficiency: 0.3, years: 10, degradationPerYear: 0.02 });
    expect(relErr(p10 / p0, 0.98 ** 10)).toBeLessThan(1e-12);
  });

  it('oversizes the array for eclipse and round-trip losses', () => {
    const s = P.sizeArray({ requiredPower: 1e6, sunlitFractionOfOrbit: 0.64, roundTripEfficiency: 0.92, years: 0 });
    // Duty penalty = (0.64 + 0.36/0.92)/0.64 = 1.611
    expect(relErr(s.dutyPenalty, (0.64 + 0.36 / 0.92) / 0.64)).toBeLessThan(1e-12);
    expect(s.dutyPenalty).toBeGreaterThan(1.5);
  });

  it('needs no eclipse oversizing in a continuously sunlit orbit', () => {
    const s = P.sizeArray({ requiredPower: 1e6, sunlitFractionOfOrbit: 1, years: 0 });
    expect(s.dutyPenalty).toBeCloseTo(1, 12);
  });

  it('sizes a battery from load, eclipse duration and depth of discharge', () => {
    // 1 MW for 2000 s = 555.6 kWh; at 30% DoD and 92% round trip with 15%
    // contingency the pack is 2314 kWh.
    const b = P.sizeBattery({ loadPower: 1e6, eclipseDuration: 2000 });
    expect(relErr(b.energyRequiredWh, (1e6 * 2000) / 3600)).toBeLessThan(1e-12);
    expect(relErr(b.packEnergyWh, (b.energyRequiredWh * 1.15) / (0.3 * 0.92))).toBeLessThan(1e-12);
    expect(b.mass).toBeGreaterThan(10000);
  });

  it('counts LEO battery cycles at roughly 5500 per year', () => {
    const period = 5670; // ~94.5 min
    const c = P.batteryCycles(period, 1, 0.35);
    expect(c.cyclesPerYear).toBeGreaterThan(5000);
    expect(c.cyclesPerYear).toBeLessThan(6000);
  });

  it('counts no cycles when the orbit never eclipses', () => {
    expect(P.batteryCycles(5670, 10, 0).totalCycles).toBe(0);
  });

  it('flags impractical bus currents at megawatt scale', () => {
    const low = P.distributionLosses({ power: 10e6, busVoltage: 120 });
    expect(low.current).toBeGreaterThan(80000);
    expect(low.warning).toBeTruthy();
    const high = P.distributionLosses({ power: 10e6, busVoltage: 10000 });
    expect(high.warning).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('radiation', () => {
  it('places the inner belt peak between 1000 and 10000 km', () => {
    const leo = R.annualDose({ altitude: 500e3 }).kradPerYear;
    const belt = R.annualDose({ altitude: 3000e3 }).kradPerYear;
    const geo = R.annualDose({ altitude: 35786e3 }).kradPerYear;

    expect(belt).toBeGreaterThan(leo * 50);
    expect(belt).toBeGreaterThan(geo * 20);
    expect(geo).toBeGreaterThan(leo);
  });

  it('classifies the standard orbit regimes correctly', () => {
    expect(R.radiationVerdict(400e3, 51.6).band).toBe('benign');
    expect(R.radiationVerdict(3000e3, 0).band).toBe('severe');
    expect(['moderate', 'harsh']).toContain(R.radiationVerdict(35786e3, 0).band);
  });

  it('has diminishing returns from shielding', () => {
    const f2 = R.shieldingFactor(2.54);
    const f10 = R.shieldingFactor(10);
    const f40 = R.shieldingFactor(40);

    expect(f2).toBeCloseTo(1.0, 1);
    // 2.5 -> 10 mm buys a large reduction...
    expect(f10 / f2).toBeLessThan(0.25);
    // ...but 10 -> 40 mm, four times the mass, buys comparatively little.
    expect(f40 / f10).toBeGreaterThan(0.25);
  });

  it('makes shielding mass grow linearly with thickness', () => {
    expect(relErr(R.shieldArealMass(10), 27)).toBeLessThan(1e-12);
    expect(relErr(R.shieldArealMass(20) / R.shieldArealMass(10), 2)).toBeLessThan(1e-12);
  });

  it('raises dose at polar inclinations relative to mid inclinations', () => {
    expect(R.inclinationFactor(90)).toBeGreaterThan(R.inclinationFactor(45));
  });

  it('converts dose rate into a wear-out lifetime', () => {
    expect(R.doseLifetime(1000, 30000)).toBeCloseTo(30, 9);
    expect(R.doseLifetime(0, 30000)).toBe(Infinity);
  });

  it('scales SEU count with memory size', () => {
    const small = R.seuRate({ memoryBytes: 1e12, altitude: 500e3 });
    const big = R.seuRate({ memoryBytes: 1e15, altitude: 500e3 });
    expect(relErr(big.rawUpsetsPerDay / small.rawUpsetsPerDay, 1000)).toBeLessThan(1e-9);
  });

  it('makes ECC cut uncorrected upsets by more than an order of magnitude', () => {
    const withEcc = R.seuRate({ memoryBytes: 1e15, altitude: 500e3, eccMitigation: true });
    const without = R.seuRate({ memoryBytes: 1e15, altitude: 500e3, eccMitigation: false });
    expect(withEcc.uncorrectedPerDay).toBeLessThan(without.uncorrectedPerDay / 10);
  });
});

// ---------------------------------------------------------------------------
describe('communications', () => {
  it('reproduces the standard free space path loss figure', () => {
    // 2.4 GHz over 1 km: 20*log10(4*pi*1000/0.1249) = 100.05 dB.
    expect(relErr(Comms.freeSpacePathLoss(1000, 2.4e9), 100.05)).toBeLessThan(1e-3);
    // Doubling distance adds exactly 6.02 dB.
    const a = Comms.freeSpacePathLoss(1000, 2.4e9);
    const b = Comms.freeSpacePathLoss(2000, 2.4e9);
    expect(b - a).toBeCloseTo(6.0206, 3);
  });

  it('computes aperture gain from the standard formula', () => {
    // 1 m dish at 10 GHz (lambda = 0.02998 m), 60% efficient: 38.2 dBi.
    const g = Comms.apertureGain(1.0, 10e9, 0.6);
    expect(relErr(g, 38.2)).toBeLessThan(5e-3);
    // Doubling diameter adds 6 dB.
    expect(Comms.apertureGain(2.0, 10e9, 0.6) - g).toBeCloseTo(6.0206, 3);
  });

  it('makes gain and path loss cancel for a fixed aperture pair', () => {
    // Raising frequency raises both dish gains by f^2 and path loss by f^2,
    // so a fixed-aperture link improves by exactly f^2 overall.
    const d = 1000e3;
    const at8 = Comms.apertureGain(2, 8e9) + Comms.apertureGain(10, 8e9) - Comms.freeSpacePathLoss(d, 8e9);
    const at16 = Comms.apertureGain(2, 16e9) + Comms.apertureGain(10, 16e9) - Comms.freeSpacePathLoss(d, 16e9);
    expect(at16 - at8).toBeCloseTo(6.0206, 3);
  });

  it('closes a plausible Ka-band LEO downlink', () => {
    const link = Comms.linkBudget({
      transmitPower: 100,
      transmitDiameter: 1.0,
      receiveDiameter: 10,
      distance: 1200e3,
      frequency: 26e9,
      bandwidth: 1e9,
    });
    expect(link.closed).toBe(true);
    expect(link.achievableRateBps).toBeGreaterThan(1e9);
    expect(link.achievableRateBps).toBeLessThanOrEqual(link.shannonCapacityBps);
  });

  it('never exceeds the Shannon limit', () => {
    for (const power of [1, 10, 100, 1000, 10000]) {
      const link = Comms.linkBudget({
        transmitPower: power, transmitDiameter: 1, receiveDiameter: 10,
        distance: 2000e3, frequency: 26e9, bandwidth: 500e6,
      });
      expect(link.achievableRateBps).toBeLessThanOrEqual(link.shannonCapacityBps * 1.0000001);
    }
  });

  it('fails a link that is too weak', () => {
    const link = Comms.linkBudget({
      transmitPower: 0.001, transmitDiameter: 0.05, receiveDiameter: 0.5,
      distance: 36000e3, frequency: 26e9, bandwidth: 1e9,
    });
    expect(link.closed).toBe(false);
  });

  it('computes slant range correctly at zenith and at the horizon', () => {
    const r = C.R_EARTH_EQ + 500e3;
    // Straight overhead the slant range is just the altitude.
    expect(relErr(Comms.slantRange(r, 90), 500e3)).toBeLessThan(1e-6);
    // At low elevation it is much longer.
    expect(Comms.slantRange(r, 5)).toBeGreaterThan(1800e3);
  });

  it('needs many ground stations for continuous LEO coverage', () => {
    const d = Comms.downlinkCapacity({ orbitRadius: C.R_EARTH_EQ + 500e3, peakRateBps: 1e9, stationCount: 1 });
    expect(d.stationsForContinuous).toBeGreaterThan(5);
    expect(d.coverageFraction).toBeLessThan(0.25);
  });

  it('gives an optical link enormous gain but cloud-limited availability', () => {
    const o = Comms.opticalLinkBudget({ transmitPower: 5, distance: 1000e3, cloudFreeProbability: 0.6 });
    expect(o.transmitGainDbi).toBeGreaterThan(100);
    expect(relErr(o.effectiveRateBps, o.achievableRateBps * 0.6)).toBeLessThan(1e-12);
  });
});

// ---------------------------------------------------------------------------
describe('launch vehicles', () => {
  it('infers a plausible nozzle exit area from the thrust split', () => {
    // Falcon 9 S1: (8227 - 7607) kN / 101325 Pa = 6.12 m^2 across nine engines,
    // i.e. 0.68 m^2 each, about a 0.93 m exit diameter. That is the right size
    // for a Merlin 1D.
    const ae = nozzleExitArea(VEHICLES.falcon9.stages[0]);
    expect(ae).toBeGreaterThan(5);
    expect(ae).toBeLessThan(8);
    const perEngine = ae / 9;
    expect(2 * Math.sqrt(perEngine / Math.PI)).toBeGreaterThan(0.8);
    expect(2 * Math.sqrt(perEngine / Math.PI)).toBeLessThan(1.1);
  });

  it('recovers sea-level thrust at sea level and vacuum thrust in vacuum', () => {
    const s = VEHICLES.falcon9.stages[0];
    expect(relErr(stageThrust(s, 101325).thrust, s.thrustSeaLevel)).toBeLessThan(1e-9);
    expect(relErr(stageThrust(s, 0).thrust, s.thrustVacuum)).toBeLessThan(1e-9);
  });

  it('recovers each stage published specific impulse at the right pressure', () => {
    const s = VEHICLES.falcon9.stages[0];
    // Isp at sea level should land near the published sea-level value.
    expect(relErr(stageThrust(s, 101325).isp, s.ispSeaLevel)).toBeLessThan(0.02);
    expect(relErr(stageThrust(s, 0).isp, s.ispVacuum)).toBeLessThan(1e-9);
  });

  it('gives Falcon 9 a liftoff thrust-to-weight above 1', () => {
    const glom = grossMass(VEHICLES.falcon9, 17500);
    const tw = VEHICLES.falcon9.stages[0].thrustSeaLevel / (glom * C.G0);
    expect(tw).toBeGreaterThan(1.15);
    expect(tw).toBeLessThan(1.6);
  });

  it('gives an ideal delta-v above the ~9.4 km/s LEO requirement', () => {
    // Ideal (lossless) delta-v must exceed the real requirement, since the
    // difference is exactly the losses the ascent sim then computes.
    const dv = idealDeltaV(VEHICLES.falcon9, 17500);
    expect(dv).toBeGreaterThan(9000);
    expect(dv).toBeLessThan(11000);
  });

  it('computes launch azimuth from the spherical triangle', () => {
    // Due east (90 deg) from Cape Canaveral reaches exactly the site latitude.
    const az = launchAzimuth(28.6084, 28.6084);
    expect(az.azimuthDeg).toBeCloseTo(90, 4);
    // A polar orbit needs due north.
    expect(launchAzimuth(28.6084, 90).azimuthDeg).toBeCloseTo(0, 6);
  });

  it('reports no direct azimuth for an inclination below the site latitude', () => {
    expect(launchAzimuth(45.965, 20)).toBeNull();     // Baikonur to 20 deg
    expect(launchAzimuth(5.239, 20)).not.toBeNull();  // Kourou can reach it
  });

  it('gives 465 m/s of rotation bonus at the equator, falling as cos(lat)', () => {
    expect(relErr(rotationBonus(0), 465.1)).toBeLessThan(1e-3);
    expect(relErr(rotationBonus(28.6084), 465.1 * Math.cos((28.6084 * Math.PI) / 180))).toBeLessThan(2e-3);
    expect(rotationBonus(90)).toBeCloseTo(0, 6);
  });

  it('peaks the drag coefficient transonically', () => {
    expect(dragCoefficient(1.15)).toBeGreaterThan(dragCoefficient(0.5));
    expect(dragCoefficient(1.15)).toBeGreaterThan(dragCoefficient(5));
    expect(dragCoefficient(0.3)).toBeCloseTo(0.30, 6);
  });

  it('clamps angle of attack to the commanded limit', () => {
    const vRel = [1000, 0, 0];
    const dir = V.unit([1, 1, 0]); // 45 degrees off
    const clamped = clampAngleOfAttack(dir, vRel, (5 * Math.PI) / 180);
    expect(V.angleBetween(clamped, vRel) * (180 / Math.PI)).toBeCloseTo(5, 6);
    // A direction already within the limit is returned untouched.
    const near = V.unit([1, 0.01, 0]);
    expect(clampAngleOfAttack(near, vRel, (5 * Math.PI) / 180)).toBe(near);
  });
});

// ---------------------------------------------------------------------------
describe('ascent simulation', () => {
  const baseline = {
    vehicle: VEHICLES.falcon9,
    site: LAUNCH_SITES.ksc,
    targetAltitude: 400e3,
    targetInclination: 28.6,
  };

  it('delivers Falcon 9 published LEO payload to a 400 km orbit', () => {
    const res = simulateAscent({ ...baseline, payloadMass: 22800 });
    expect(res.success).toBe(true);
    expect(res.summary.perigeeAltitude).toBeGreaterThan(350e3);
    expect(res.summary.eccentricity).toBeLessThan(0.01);
  });

  it('closes the delta-v budget exactly', () => {
    // The identity that must hold to integrator tolerance:
    //   |v_final| = |v_initial| + ideal - gravity - drag - steering
    // This is not a modelling assumption; it is the definition of the loss
    // decomposition, integrated alongside the state.
    const res = simulateAscent({ ...baseline, payloadMass: 15000 });
    const d = res.summary.deltaV;
    const predicted = d.rotationBonus + d.ideal - d.gravityLoss - d.dragLoss - d.steeringLoss;
    expect(relErr(predicted, d.achieved)).toBeLessThan(2e-3);
  });

  it('produces max dynamic pressure in the right place', () => {
    // Real launch vehicles see max-Q of 25-45 kPa somewhere between 10 and
    // 15 km. Both the value and the altitude are emergent here, not inputs.
    const res = simulateAscent({ ...baseline, payloadMass: 15000 });
    expect(res.summary.maxDynamicPressure).toBeGreaterThan(20e3);
    expect(res.summary.maxDynamicPressure).toBeLessThan(55e3);
    expect(res.summary.maxQAltitude).toBeGreaterThan(7e3);
    expect(res.summary.maxQAltitude).toBeLessThan(16e3);
  });

  it('produces realistic loss magnitudes', () => {
    const res = simulateAscent({ ...baseline, payloadMass: 15000 });
    const d = res.summary.deltaV;
    // Gravity loss for a two-stage Earth launcher is ~1.0-1.5 km/s.
    expect(d.gravityLoss).toBeGreaterThan(700);
    expect(d.gravityLoss).toBeLessThan(1800);
    // Drag loss is small but not zero.
    expect(d.dragLoss).toBeGreaterThan(5);
    expect(d.dragLoss).toBeLessThan(300);
    // Total ideal delta-v to LEO lands in the well-known 9-10 km/s band.
    expect(d.ideal).toBeGreaterThan(8500);
    expect(d.ideal).toBeLessThan(10500);
  });

  it('respects the axial acceleration limit', () => {
    const res = simulateAscent({ ...baseline, payloadMass: 15000 });
    expect(res.summary.maxAxialG).toBeLessThan(4.3);
  });

  it('keeps the trajectory structurally flyable', () => {
    const res = simulateAscent({ ...baseline, payloadMass: 15000 });
    expect(res.summary.structurallyFlyable).toBe(true);
  });

  it('fails when the payload is far beyond the vehicle', () => {
    const res = simulateAscent({ ...baseline, payloadMass: 60000 });
    expect(res.success).toBe(false);
  });

  it('achieves the requested inclination from the launch site', () => {
    const res = simulateAscent({ ...baseline, payloadMass: 15000 });
    expect(Math.abs(res.summary.inclinationDeg - 28.6)).toBeLessThan(1.5);
  });

  it('flies a retrograde sun-synchronous inclination from Vandenberg', () => {
    const res = simulateAscent({
      vehicle: VEHICLES.falcon9,
      site: LAUNCH_SITES.vandenberg,
      payloadMass: 10000,
      targetAltitude: 500e3,
      targetInclination: 97.5,
    });
    expect(res.success).toBe(true);
    expect(res.summary.inclinationDeg).toBeGreaterThan(90);
    expect(Math.abs(res.summary.inclinationDeg - 97.5)).toBeLessThan(1.5);
    // The southerly corridor is the one Vandenberg actually flies.
    expect(res.azimuthInCorridor).toBe(true);
  });

  it('costs payload to fly polar rather than due east from the same pad', () => {
    // Launching out of plane with Earth's rotation, then yawing back onto the
    // target plane, is not free. Same vehicle, same pad, same altitude.
    const east = simulateAscent({
      vehicle: VEHICLES.falcon9, site: LAUNCH_SITES.vandenberg,
      payloadMass: 12000, targetAltitude: 500e3, targetInclination: 34.7,
    });
    const polar = simulateAscent({
      vehicle: VEHICLES.falcon9, site: LAUNCH_SITES.vandenberg,
      payloadMass: 12000, targetAltitude: 500e3, targetInclination: 97.5,
    });
    const eastDv = east.summary.deltaV;
    const polarDv = polar.summary.deltaV;
    // The polar flight starts with less usable rotation velocity and spends
    // more on steering, so it needs more total impulse for the same payload.
    expect(polarDv.ideal).toBeGreaterThan(eastDv.ideal);
  });

  it('gives the equatorial site a payload advantage for a low-inclination orbit', () => {
    // Kourou at 5.2 deg keeps almost all of Earth's rotation; Baikonur at
    // 46 deg keeps much less and cannot reach low inclination at all.
    const kourou = simulateAscent({
      vehicle: VEHICLES.falcon9, site: LAUNCH_SITES.kourou,
      payloadMass: 20000, targetAltitude: 400e3, targetInclination: 6,
    });
    expect(kourou.reachableInclination).toBe(true);

    const baikonur = simulateAscent({
      vehicle: VEHICLES.falcon9, site: LAUNCH_SITES.baikonur,
      payloadMass: 20000, targetAltitude: 400e3, targetInclination: 6,
    });
    expect(baikonur.reachableInclination).toBe(false);
  });

  it('reduces payload capability when the booster is recovered', () => {
    const expendable = simulateAscent({ ...baseline, payloadMass: 20000, reusableBooster: false });
    const reusable = simulateAscent({ ...baseline, payloadMass: 20000, reusableBooster: true });
    expect(expendable.success).toBe(true);
    expect(reusable.success).toBe(false);
  });

  it('is deterministic', () => {
    const a = simulateAscent({ ...baseline, payloadMass: 15000, epoch: new Date(Date.UTC(2026, 0, 1)) });
    const b = simulateAscent({ ...baseline, payloadMass: 15000, epoch: new Date(Date.UTC(2026, 0, 1)) });
    expect(a.summary.finalSpeed).toBe(b.summary.finalSpeed);
    expect(a.summary.maxDynamicPressure).toBe(b.summary.maxDynamicPressure);
  });

  it('records a monotonically increasing time series', () => {
    const res = simulateAscent({ ...baseline, payloadMass: 15000 });
    expect(res.samples.length).toBeGreaterThan(50);
    for (let i = 1; i < res.samples.length; i++) {
      expect(res.samples[i].t).toBeGreaterThanOrEqual(res.samples[i - 1].t);
    }
    // Mass never increases.
    for (let i = 1; i < res.samples.length; i++) {
      expect(res.samples[i].mass).toBeLessThanOrEqual(res.samples[i - 1].mass + 1e-6);
    }
  });
});

// ---------------------------------------------------------------------------
describe('datacenter system model', () => {
  const base = { itPower: 10e6, altitude: 550e3, inclination: 97.6, missionYears: 10 };

  it('closes the mass budget', () => {
    const d = designDatacenter(base);
    const sum = d.mass.breakdown.reduce((a, [, v]) => a + v, 0);
    expect(relErr(sum, d.mass.total)).toBeLessThan(1e-9);
  });

  it('conserves energy: all electrical power becomes heat', () => {
    const d = designDatacenter(base);
    expect(d.thermal.heatLoad).toBe(d.power.totalPower);
    expect(d.power.totalPower).toBeGreaterThan(d.power.itPower);
  });

  it('scales radiator area and array area linearly with power', () => {
    const a = designDatacenter({ ...base, itPower: 1e6 });
    const b = designDatacenter({ ...base, itPower: 10e6 });
    expect(relErr(b.thermal.area / a.thermal.area, 10)).toBeLessThan(1e-6);
    expect(relErr(b.power.array.area / a.power.array.area, 10)).toBeLessThan(1e-6);
  });

  it('makes radiators and arrays dominate over compute hardware', () => {
    const d = designDatacenter(base);
    const infra = d.mass.radiator + d.mass.solarArray;
    expect(infra).toBeGreaterThan(d.mass.it);
  });

  it('finds the inner belt fatal for commercial electronics', () => {
    const d = designDatacenter({ ...base, altitude: 3000e3, inclination: 0 });
    expect(d.viable).toBe(false);
    expect(d.issues.some((i) => i.subsystem === 'radiation' && i.severity === 'fatal')).toBe(true);
  });

  it('finds low orbits fatal from drag', () => {
    const d = designDatacenter({ ...base, altitude: 350e3 });
    expect(d.issues.some((i) => i.subsystem === 'orbit')).toBe(true);
  });

  it('eliminates battery mass in a continuously sunlit orbit', () => {
    const eclipsed = designDatacenter({ ...base, betaAngle: 0 });
    const sunlit = designDatacenter({ ...base, betaAngle: 1.45 });
    expect(eclipsed.orbit.eclipseFraction).toBeGreaterThan(0.3);
    expect(sunlit.orbit.eclipseFraction).toBe(0);
    expect(sunlit.mass.battery).toBe(0);
    expect(eclipsed.mass.battery).toBeGreaterThan(1000);
  });

  it('makes higher orbits need less station-keeping', () => {
    const low = designDatacenter({ ...base, altitude: 450e3 });
    const high = designDatacenter({ ...base, altitude: 800e3 });
    expect(low.orbit.stationKeepingDvPerYear).toBeGreaterThan(high.orbit.stationKeepingDvPerYear);
  });

  it('reports a radiator area in the right order of magnitude per megawatt', () => {
    // About 1 kW/m^2 of rejection means roughly 1000-1500 m^2 per MW.
    const d = designDatacenter({ ...base, itPower: 1e6 });
    const perMw = d.thermal.area / (d.power.totalPower / 1e6);
    expect(perMw).toBeGreaterThan(700);
    expect(perMw).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------
describe('economics', () => {
  it('counts terrestrial hardware refreshes over the mission', () => {
    const t = terrestrialCost({ itPowerW: 10e6, years: 10 });
    expect(t.hardwareRefreshes).toBe(2); // years 4 and 8
    expect(t.electricity).toBeGreaterThan(0);
    expect(t.waterLitres).toBeGreaterThan(0);
  });

  it('scales terrestrial electricity with PUE and time', () => {
    const a = terrestrialCost({ itPowerW: 10e6, years: 5 });
    const b = terrestrialCost({ itPowerW: 10e6, years: 10 });
    expect(relErr(b.electricity / a.electricity, 2)).toBeLessThan(1e-9);
  });

  it('makes launch cost fall with a cheaper vehicle', () => {
    const d = designDatacenter({ itPower: 10e6, altitude: 550e3, inclination: 97.6, missionYears: 10, betaAngle: 1.45 });
    const expensive = compare(d, { launchVehicle: 'falcon9' });
    const cheap = compare(d, { launchVehicle: 'starshipTarget' });
    expect(cheap.orbital.launchCost).toBeLessThan(expensive.orbital.launchCost);
    expect(cheap.orbital.total).toBeLessThan(expensive.orbital.total);
  });

  it('reports a breakeven launch price', () => {
    const d = designDatacenter({ itPower: 10e6, altitude: 550e3, inclination: 97.6, missionYears: 10, betaAngle: 1.45 });
    const c = compare(d, { launchVehicle: 'starshipTarget' });
    expect(typeof c.breakevenLaunchPricePerKg).toBe('number');
    expect(c.verdict).toBeTruthy();
    expect(c.orbital.launchFraction).toBeGreaterThanOrEqual(0);
    expect(c.orbital.launchFraction).toBeLessThanOrEqual(1);
  });
});
