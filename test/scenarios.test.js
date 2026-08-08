/**
 * Scenario engine tests.
 *
 * The point of these is not to pin down exact numbers -- those belong to the
 * physics modules and are tested there. It is to prove the engine actually
 * discriminates: that every documented failure mode TRIPS on a configuration
 * chosen to provoke it, and CLEARS when the documented engineering solution is
 * applied. A scenario that is always green tests nothing.
 */

import { describe, it, expect } from 'vitest';
import {
  SCENARIOS, SCENARIO_BY_ID, assess, solve, applyRemedy, autoResolve,
  singleEventEffects, downlinkBalance, STATUS_RANK,
} from '../src/sim/scenarios.js';
import { designDatacenter } from '../src/sim/datacenter.js';

/** Baseline the README calls the architecture the physics favours. */
const SSO = {
  itPower: 10e6, altitude: 700e3, inclination: 97.9,
  missionYears: 10, betaAngle: Math.PI / 2,
};

const statusOf = (a, id) => a.verdicts.find((v) => v.id === id).status;

describe('scenario engine structure', () => {
  it('gives every scenario a failure mode, a viability condition and remedies', () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(7);
    for (const s of SCENARIOS) {
      expect(s.id, `${s.name} id`).toMatch(/^[a-zA-Z]+$/);
      expect(s.failure.length, `${s.id} failure`).toBeGreaterThan(20);
      expect(s.viableWhen.length, `${s.id} viableWhen`).toBeGreaterThan(20);
      expect(s.remedies.length, `${s.id} remedies`).toBeGreaterThan(0);
      for (const r of s.remedies) {
        expect(r.summary.length, `${s.id}/${r.id} summary`).toBeGreaterThan(20);
      }
    }
  });

  it('grades every scenario on any config it is handed', () => {
    const a = assess(SSO);
    expect(a.verdicts).toHaveLength(SCENARIOS.length);
    for (const v of a.verdicts) {
      expect(['viable', 'marginal', 'fail']).toContain(v.status);
      expect(Number.isFinite(v.score), `${v.id} score`).toBe(true);
      expect(v.metrics.length).toBeGreaterThan(0);
    }
    expect(a.counts.viable + a.counts.marginal + a.counts.fail).toBe(SCENARIOS.length);
  });

  it('never mutates the config it is given', () => {
    const cfg = { ...SSO };
    const snapshot = JSON.stringify(cfg);
    assess(cfg);
    solve(cfg, 'thermal');
    autoResolve(cfg);
    expect(JSON.stringify(cfg)).toBe(snapshot);
  });
});

describe('each failure mode trips when provoked', () => {
  it('thermal: radiator area explodes past 40,000 m² at 100 MW', () => {
    // Radiator area is linear in IT power, so the README's ">40,000 m²"
    // failure threshold is crossed by scaling the compute alone.
    const ten = assess({ ...SSO });
    const hundred = assess({ ...SSO, itPower: 100e6 });
    expect(statusOf(ten, 'thermal')).toBe('viable');
    expect(statusOf(hundred, 'thermal')).toBe('fail');
    expect(hundred.design.thermal.area).toBeGreaterThan(40000);
    // And it really is linear, within the environmental-flux correction.
    expect(hundred.design.thermal.area / ten.design.thermal.area).toBeGreaterThan(8);
  });

  it('radiation: the inner proton belt brings dose lifetime below the mission', () => {
    const belt = assess({ ...SSO, altitude: 2500e3, inclination: 51.6, betaAngle: 0 });
    expect(statusOf(belt, 'radiationTid')).toBe('fail');
    expect(belt.design.radiation.lifetimeYears).toBeLessThan(SSO.missionYears);
    // The README's claim is that this band is qualitatively different, not
    // merely worse: an order of magnitude above a 700 km dose rate.
    const low = assess(SSO);
    expect(belt.design.radiation.kradPerYear)
      .toBeGreaterThan(low.design.radiation.kradPerYear * 10);
  });

  it('eclipse power: a mid-inclination orbit carries a punitive battery', () => {
    const mid = assess({ ...SSO, altitude: 550e3, inclination: 51.6, betaAngle: 0 });
    expect(statusOf(mid, 'eclipsePower')).not.toBe('viable');
    // The README puts this at ">220 tonnes" for 10 MW.
    expect(mid.design.mass.battery).toBeGreaterThan(150e3);
    expect(mid.design.orbit.eclipseFraction).toBeGreaterThan(0.25);
  });

  it('drag: a low orbit decays inside the mission', () => {
    const low = assess({ ...SSO, altitude: 400e3, inclination: 51.6, betaAngle: 0 });
    expect(statusOf(low, 'drag')).toBe('fail');
    expect(low.design.orbit.decayYears).toBeLessThan(2);
  });

  it('single-event: without current limiting, latchup destroys the fleet', () => {
    const unprotected = assess({
      ...SSO, altitude: 2500e3, inclination: 51.6, betaAngle: 0, latchupProtection: 'none',
    });
    expect(statusOf(unprotected, 'singleEvent')).toBe('fail');
    const see = singleEventEffects(unprotected.design, {
      ...SSO, altitude: 2500e3, inclination: 51.6, latchupProtection: 'none',
    });
    expect(see.capacityLostToLatchup).toBeGreaterThan(0.05);
  });

  it('economics: launch cost keeps orbital compute above the terrestrial baseline', () => {
    const a = assess(SSO);
    const econ = a.verdicts.find((v) => v.id === 'economics');
    // The README's range is 5x to 15x at current launch pricing.
    expect(econ.extra.ratio).toBeGreaterThan(1.5);
    expect(econ.status).not.toBe('viable');
  });
});

describe('each documented remedy does what the README says', () => {
  it('high-Tj silicon cuts radiator area sharply (T⁴ scaling)', () => {
    const hot = { ...SSO, itPower: 100e6 };
    const base = designDatacenter(hot);
    const fixed = designDatacenter(applyRemedy(hot, { patch: { junctionTemp: 400 } }));
    const reduction = 1 - fixed.thermal.area / base.thermal.area;
    // The README claims 60-70%. Accept anything in that neighbourhood -- the
    // exact figure depends on the environmental flux at this orbit.
    expect(reduction).toBeGreaterThan(0.4);
  });

  it('dawn-dusk SSO removes the battery entirely', () => {
    const mid = { ...SSO, altitude: 550e3, inclination: 51.6, betaAngle: 0 };
    const s = solve(mid, 'eclipsePower');
    const dawn = s.options.find((o) => o.remedy.id === 'dawnDuskSso');
    expect(dawn.cleared).toBe(true);
    expect(dawn.deltaMassKg).toBeLessThan(0);
  });

  it('over-current protection converts latchup destruction into downtime', () => {
    const belt = { ...SSO, altitude: 2500e3, inclination: 51.6, betaAngle: 0 };
    const design = designDatacenter(belt);
    const without = singleEventEffects(design, { ...belt, latchupProtection: 'none' });
    const with_ = singleEventEffects(design, { ...belt, latchupProtection: 'ocp' });
    expect(without.capacityLostToLatchup).toBeGreaterThan(0);
    expect(with_.capacityLostToLatchup).toBe(0);
  });

  it('edge filtering cuts downlink demand by two orders of magnitude', () => {
    const design = designDatacenter(SSO);
    const raw = downlinkBalance(design, SSO);
    const filtered = downlinkBalance(design, { ...SSO, edgeFiltering: true });
    expect(filtered.requiredBytesPerSecond)
      .toBeCloseTo(raw.requiredBytesPerSecond * 0.01, 6);
  });

  it('cheaper launch actually moves the cost, rather than silently no-opping', () => {
    // Regression: orbitalCost keys on `launchVehicle`. Passing `vehicle`
    // fell through to the default and every launch remedy reported an
    // identical figure.
    const dear = assess({ ...SSO, costVehicle: 'ariane6' });
    const cheap = assess({ ...SSO, costVehicle: 'starshipTarget' });
    const r = (a) => a.verdicts.find((v) => v.id === 'economics').extra.ratio;
    expect(r(cheap)).toBeLessThan(r(dear));
  });
});

describe('coupling between scenarios', () => {
  it('escaping drag by climbing walks into the proton belt', () => {
    // The single most important thing the engine does that a table cannot:
    // the rows are not independent.
    const low = { ...SSO, altitude: 400e3, inclination: 51.6, betaAngle: 0 };
    const s = solve(low, 'drag');
    const climb = s.options.find((o) => o.remedy.id === 'raiseTo1000');
    expect(climb.resolved).toBe(true);
    expect(climb.sideEffects.map((e) => e.id)).toContain('radiationTid');
  });

  it('ranks a clean fix above one that breaks something else', () => {
    const low = { ...SSO, altitude: 400e3, inclination: 51.6, betaAngle: 0 };
    const { options } = solve(low, 'drag');
    const firstWithSideEffects = options.findIndex((o) => o.sideEffects.length > 0);
    const lastClean = options.map((o) => o.sideEffects.length === 0).lastIndexOf(true);
    if (firstWithSideEffects >= 0 && lastClean >= 0) {
      expect(lastClean).toBeLessThan(firstWithSideEffects);
    }
  });
});

describe('auto-resolve', () => {
  it('never descopes its way out of a problem', () => {
    // "Halve the compute load" would trivially fix thermal, radiator mass and
    // cost. It changes the requirement instead of meeting it, so the resolver
    // must not reach for it.
    const r = autoResolve({ ...SSO, itPower: 100e6 });
    expect(r.applied.map((a) => a.remedy)).not.toContain('lowerPower');
  });

  it('terminates, and reports honestly when it cannot close a design', () => {
    const r = autoResolve({ ...SSO, itPower: 100e6 });
    expect(r.converged).toBe(false);
    expect(r.reason).toBeTruthy();
    // It should still have made real progress before giving up.
    expect(r.applied.length).toBeGreaterThan(0);
    const before = assess({ ...SSO, itPower: 100e6 });
    expect(r.assessment.design.thermal.area).toBeLessThan(before.design.thermal.area);
  });

  it('never applies the same remedy twice', () => {
    const r = autoResolve({ ...SSO, altitude: 2500e3, inclination: 51.6, betaAngle: 0 });
    const ids = r.applied.map((a) => a.remedy);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('improves or holds the overall verdict, never degrades it', () => {
    for (const cfg of [
      { ...SSO, altitude: 400e3, inclination: 51.6, betaAngle: 0 },
      { ...SSO, altitude: 2500e3, inclination: 51.6, betaAngle: 0 },
      { ...SSO, itPower: 100e6 },
    ]) {
      const before = assess(cfg);
      const after = autoResolve(cfg).assessment;
      expect(STATUS_RANK[after.verdict]).toBeGreaterThanOrEqual(STATUS_RANK[before.verdict]);
    }
  });
});

describe('solve()', () => {
  it('rejects an unknown scenario rather than returning nothing', () => {
    expect(() => solve(SSO, 'nonsense')).toThrow(/unknown scenario/);
  });

  it('offers every remedy the scenario declares', () => {
    for (const s of SCENARIOS) {
      const { options } = solve(SSO, s.id);
      expect(options).toHaveLength(s.remedies.length);
    }
  });

  it('reports the mass a fix costs or saves', () => {
    const { options } = solve({ ...SSO, altitude: 2500e3, betaAngle: 0 }, 'radiationTid');
    const shield = options.find((o) => o.remedy.id === 'gradedZShield');
    // 20 mm of aluminium over a large vehicle is not free.
    expect(shield.deltaMassKg).toBeGreaterThan(0);
  });
});

describe('scenario ids are stable', () => {
  it('exposes the documented set by id', () => {
    for (const id of ['thermal', 'radiationTid', 'singleEvent', 'eclipsePower',
      'drag', 'downlink', 'economics']) {
      expect(SCENARIO_BY_ID[id], id).toBeDefined();
    }
  });
});
