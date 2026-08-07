/**
 * Booster recovery: the flight back down.
 *
 * The ascent simulator throws a spent stage away at separation. This module
 * flies it home, because that trajectory is a real and demanding piece of the
 * mission -- and because a booster that cannot get back is not reusable,
 * whatever the propellant reserve claimed.
 *
 * The sequence is the one flown in practice:
 *
 *   BOOSTBACK   burn retrograde to kill downrange velocity and aim at the pad.
 *               Only flown for a return-to-launch-site profile; a droneship
 *               landing skips it and catches the booster downrange, which is
 *               exactly why droneship missions lift more payload.
 *   COAST       ballistic arc back into the atmosphere.
 *   ENTRY       burn through the upper atmosphere to bleed speed before the
 *               dynamic pressure and heating peak.
 *   LANDING     a continuous deceleration timed to arrive at zero.
 *
 * ON THE BURNS: boostback happens in near-vacuum over tens of seconds and is
 * modelled impulsively. Entry and landing are NOT -- they are integrated as
 * continuous thrust, because the whole difficulty of a landing is that it is a
 * race between deceleration and the ground. An impulsive landing burn at 6 km
 * leaves the vehicle to free-fall the rest of the way and arrive at 340 m/s,
 * which is not a landing.
 *
 * The landing burn is a suicide burn: full thrust, started at the last possible
 * moment, because a booster hovering is a booster burning propellant it does
 * not have. The trigger altitude falls straight out of the kinematics --
 * h = v^2 / 2a -- and the margin on it is the entire flight.
 */

import { propagate } from './integrate.js';
import { earthGravity } from './gravity.js';
import { atmosphere } from './atmosphere.js';
import {
  relativeVelocity, geodeticAltitude, eciToEcef, ecefToGeodetic, gmst,
} from './frames.js';
import { R_EARTH_EQ, G0 } from './constants.js';
import * as V from './vec3.js';

/** Recovery profiles. */
export const RECOVERY_MODES = {
  none: { name: 'Expendable', boostback: false, recovered: false },
  droneship: { name: 'Downrange droneship', boostback: false, recovered: true },
  rtls: { name: 'Return to launch site', boostback: true, recovered: true },
};

/**
 * A returning booster falls engines-first with grid fins deployed. In that
 * attitude it is a blunt high-drag body, nothing like the slender coefficient
 * it had on the way up, and that drag does most of the braking.
 */
const CD_RETURN = 1.4;

export function simulateRecovery(cfg) {
  const {
    r0, v0, t0 = 0,
    dryMass, propellant, isp = 300,
    diameter = 3.7,
    engineThrust = 845000,   // one engine at full throttle [N]
    landingEngines = 1,
    // Falcon 9 lights three engines for the entry burn and one for landing.
    // Three matters: the entry burn has to shed speed fast, in a short window,
    // against a booster that is still heavy.
    entryEngines = 3,
    mode = 'droneship',
    siteEci = null,
    /** Launch site geodetic position and epoch, for a correct downrange figure. */
    siteLatLon = null,
    jd0 = null,
    f107 = 150,
    sampleInterval = 1.5,
  } = cfg;

  const profile = RECOVERY_MODES[mode] ?? RECOVERY_MODES.droneship;
  const area = Math.PI * (diameter / 2) ** 2;
  const landingThrust = engineThrust * landingEngines;
  const entryThrust = engineThrust * entryEngines;
  let maxThrust = landingThrust;

  let mass = dryMass + propellant;
  let propRemaining = propellant;
  const samples = [];
  const events = [];
  const massFlow = () => maxThrust / (isp * G0);

  // ---- shared dynamics ---------------------------------------------------
  // `thrustMode` selects what the engines are doing: nothing, a fixed retro
  // burn, or the terminal landing burn.
  let thrustMode = 'coast';

  const derivative = (t, y) => {
    const r = [y[0], y[1], y[2]];
    const v = [y[3], y[4], y[5]];
    const m = y[6];
    const alt = geodeticAltitude(r);
    const atm = atmosphere(Math.max(alt, 0), { f107 });
    const vRel = relativeVelocity(r, v);
    const vMag = V.norm(vRel);

    let acc = earthGravity(r, { harmonics: 2 });

    if (atm.density > 0 && vMag > 0) {
      const f = 0.5 * atm.density * vMag * vMag * CD_RETURN * area;
      const d = V.scale(vRel, -f / (m * vMag));
      acc = V.add(acc, d);
    }

    let mdot = 0;
    if (thrustMode !== 'coast' && m > dryMass && vMag > 0.5) {
      // Thrust straight down the airspeed vector: retrograde is the only
      // direction that both slows the vehicle and keeps it stable.
      const dir = V.scale(vRel, -1 / vMag);

      let thrust = maxThrust;
      if (thrustMode === 'landing') {
        // Throttle to track the profile that arrives at zero.
        //
        // Full thrust all the way down does not land: the vehicle either stops
        // short and then falls again, or -- because thrust cannot be trimmed --
        // never quite matches the deceleration the remaining altitude requires
        // and flies into the ground with a hundred metres per second left. A
        // real landing burn solves a = v^2 / 2h continuously and throttles to
        // it, which is why boosters touch down at walking pace rather than
        // arriving with whatever the open-loop burn happened to leave.
        const need = (vMag * vMag) / (2 * Math.max(alt, 1)) + 9.5;
        thrust = Math.max(0, Math.min(maxThrust, need * m));
      }

      acc = V.add(acc, V.scale(dir, thrust / m));
      mdot = thrust / (isp * G0);
    }

    return [v[0], v[1], v[2], acc[0], acc[1], acc[2], -mdot];
  };

  let lastSample = -Infinity;
  const record = (t, y) => {
    if (t - lastSample < sampleInterval && samples.length) return;
    lastSample = t;
    const r = [y[0], y[1], y[2]];
    const v = [y[3], y[4], y[5]];
    const alt = geodeticAltitude(r);
    const atm = atmosphere(Math.max(alt, 0), { f107 });
    const vRel = relativeVelocity(r, v);
    samples.push({
      t, r: [...r], v: [...v],
      altitude: alt,
      speed: V.norm(v),
      relativeSpeed: V.norm(vRel),
      dynamicPressure: 0.5 * atm.density * V.norm(vRel) ** 2,
      mass: y[6],
      burning: thrustMode !== 'coast',
    });
  };

  /** Impulsive burn, for the vacuum boostback only. */
  function impulse(state, deltaV, label, t) {
    const dvMag = V.norm(deltaV);
    if (dvMag < 1e-6) return state;
    const m = state[6];
    const need = m * (1 - Math.exp(-dvMag / (isp * G0)));
    const used = Math.min(need, propRemaining);
    const achieved = used >= need ? dvMag : isp * G0 * Math.log(m / (m - used));
    const dir = V.scale(deltaV, 1 / dvMag);

    propRemaining -= used;
    events.push({
      name: label, t, deltaV: achieved, requested: dvMag,
      propellantUsed: used,
      altitude: geodeticAltitude([state[0], state[1], state[2]]),
      short: achieved < dvMag - 1,
    });
    return [
      state[0], state[1], state[2],
      state[3] + dir[0] * achieved,
      state[4] + dir[1] * achieved,
      state[5] + dir[2] * achieved,
      m - used,
    ];
  }

  const groundEvent = {
    name: 'touchdown',
    g: (tt, y) => geodeticAltitude([y[0], y[1], y[2]]),
    terminal: true, direction: -1,
  };
  const run = (tEnd, evts) => propagate({
    f: derivative, t0: tRef, y0: state, tEnd,
    h0: 0.1, hMax: 3, rtol: 1e-8, atol: 1e-3,
    events: evts, eventTol: 1e-3, onStep: record,
  });

  let state = [r0[0], r0[1], r0[2], v0[0], v0[1], v0[2], mass];
  let tRef = t0;

  // --- BOOSTBACK ----------------------------------------------------------
  if (profile.boostback && siteEci) {
    const up = V.unit([state[0], state[1], state[2]]);
    // Velocity RELATIVE TO THE ROTATING EARTH, not inertial velocity. The pad
    // is bolted to a planet turning at 408 m/s at this latitude, so nulling
    // inertial velocity would leave the booster stationary in space while its
    // landing site slid out from under it -- and it charges ~400 m/s for the
    // privilege.
    const vel = relativeVelocity([state[0], state[1], state[2]], [state[3], state[4], state[5]]);
    const vHoriz = V.rejectFrom(vel, up);

    // How far downrange the booster already is, and how long it has before it
    // comes back down. The return velocity only has to cover that gap -- flying
    // home at 1400 m/s, as a naive target does, costs a 3900 m/s burn the stage
    // does not have.
    const toSite = V.rejectFrom(V.sub(siteEci, [state[0], state[1], state[2]]), up);
    const gap = V.norm(toSite);
    const vUp = V.dot(vel, up);
    const alt = geodeticAltitude([state[0], state[1], state[2]]);
    // Rough time to fall back from apogee of this arc.
    const fallTime = (vUp + Math.sqrt(Math.max(0, vUp * vUp + 2 * 9.5 * alt))) / 9.5;

    const homeDir = gap > 1 ? V.unit(toSite) : V.unit(V.neg(vHoriz));
    // The booster has minutes of fall time to cover the downrange gap, so the
    // return velocity it needs is modest. Capping it low keeps the boostback
    // near the ~1500-2000 m/s a real RTLS flies rather than a full reversal.
    const returnSpeed = Math.min(gap / Math.max(fallTime, 30), 450);
    const target = V.scale(homeDir, returnSpeed);
    state = impulse(state, V.sub(target, vHoriz), 'boostback', tRef);
  }

  // --- COAST TO ENTRY -----------------------------------------------------
  const entryTrigger = {
    name: 'entry-altitude',
    g: (tt, y) => geodeticAltitude([y[0], y[1], y[2]]) - 60e3,
    terminal: true, direction: -1,
  };
  let res = run(tRef + 1800, [groundEvent, entryTrigger]);
  tRef = res.t; state = res.y;
  let reason = res.events[res.events.length - 1]?.name;

  // --- ENTRY BURN ---------------------------------------------------------
  // Continuous, for a fixed duration, to take the top off the entry velocity.
  let entryDone = false;
  if (reason === 'entry-altitude' && propRemaining > 0) {
    const vRel0 = V.norm(relativeVelocity(
      [state[0], state[1], state[2]], [state[3], state[4], state[5]]));
    // Target roughly half the entry speed; the burn ends on whichever comes
    // first, the speed target or the propellant budget.
    const targetSpeed = vRel0 * 0.55;
    thrustMode = 'entry';
    maxThrust = entryThrust;
    const startProp = propRemaining;
    const startMass = state[6];

    // A real entry burn is a short, hard pulse -- Falcon 9's runs about 20
    // seconds. Letting it run for a minute drags it down through 50 km of
    // atmosphere and spends the landing propellant on the wrong phase.
    res = propagate({
      f: derivative, t0: tRef, y0: state, tEnd: tRef + 22,
      h0: 0.05, hMax: 1, rtol: 1e-8, atol: 1e-3,
      events: [
        groundEvent,
        {
          name: 'entry-speed',
          g: (tt, y) => V.norm(relativeVelocity([y[0], y[1], y[2]], [y[3], y[4], y[5]])) - targetSpeed,
          terminal: true, direction: -1,
        },
        {
          // Never spend more than 40% of what is left: the landing burn is not
          // optional and it comes after this one.
          name: 'entry-budget',
          g: (tt, y) => y[6] - (startMass - startProp * 0.55),
          terminal: true, direction: -1,
        },
      ],
      eventTol: 1e-3, onStep: record,
    });
    thrustMode = 'coast';
    maxThrust = landingThrust;
    propRemaining -= startMass - res.y[6];
    events.push({
      name: 'entry-burn', t: tRef,
      deltaV: vRel0 - V.norm(relativeVelocity(
        [res.y[0], res.y[1], res.y[2]], [res.y[3], res.y[4], res.y[5]])),
      propellantUsed: startMass - res.y[6],
      altitude: geodeticAltitude([res.y[0], res.y[1], res.y[2]]),
      short: false,
    });
    tRef = res.t; state = res.y;
    entryDone = true;
  }

  // --- COAST TO THE LANDING BURN -----------------------------------------
  //
  // The trigger is the kinematic one: start when the distance needed to stop at
  // the achievable deceleration equals the distance remaining. Anything earlier
  // means hovering; anything later means a crater.
  const landingTrigger = {
    name: 'landing-ignition',
    g: (tt, y) => {
      const alt = geodeticAltitude([y[0], y[1], y[2]]);
      const vRel = relativeVelocity([y[0], y[1], y[2]], [y[3], y[4], y[5]]);
      const speed = V.norm(vRel);
      const decel = Math.max(1, maxThrust / y[6] - 9.5);
      const stopDistance = (speed * speed) / (2 * decel);

      // Ignition altitude is the LOWER of the kinematic requirement and a hard
      // ceiling. The ceiling matters: a booster arriving fast at 30 km has a
      // kinematic stopping distance longer than its remaining altitude, so a
      // purely kinematic trigger lights the engines immediately and burns the
      // landing propellant in thin air where it buys nothing. The atmosphere
      // between 30 km and 8 km does most of the braking for free -- Falcon 9
      // sheds roughly 1100 m/s to 350 m/s on drag alone across that band -- so
      // the vehicle should fall through it and burn low.
      // The ceiling only exists to stop the engines lighting in near-vacuum at
      // 30 km, where thrust buys nothing and the atmosphere below would have
      // done the work for free. It must sit clear of the kinematic requirement
      // or it becomes the binding constraint and the vehicle ignites late: one
      // Merlin on a 48 t booster needs to start at 8.3 km, and an 8 km ceiling
      // costs exactly the 300 m of stopping distance that matters.
      // Ceiling keeps the engines from lighting in near-vacuum where thrust
      // buys nothing and the atmosphere below would brake for free.
      const ignite = Math.min(12000, stopDistance * 1.15);
      return alt - ignite;
    },
    terminal: true, direction: -1,
  };

  // The trigger is a sign change, so it only fires if the vehicle is still
  // ABOVE its ignition altitude when the coast starts. A booster that arrives
  // already below it is not "not yet time to burn" -- it is late, and the only
  // useful response is to light immediately. Check the sign first.
  const triggerNow = landingTrigger.g(tRef, state) <= 0;
  if (!triggerNow) {
    res = run(tRef + 900, [groundEvent, landingTrigger]);
    tRef = res.t; state = res.y;
    reason = res.events[res.events.length - 1]?.name;
  } else {
    reason = 'landing-ignition';
  }

  // --- LANDING BURN -------------------------------------------------------
  let landingDone = false;
  if (reason === 'landing-ignition' && propRemaining > 0) {
    thrustMode = 'landing';
    const startMass = state[6];
    const igniteAlt = geodeticAltitude([state[0], state[1], state[2]]);

    res = propagate({
      f: derivative, t0: tRef, y0: state, tEnd: tRef + 120,
      h0: 0.02, hMax: 0.5, rtol: 1e-9, atol: 1e-4,
      events: [
        groundEvent,
        {
          name: 'stopped',
          g: (tt, y) => V.norm(relativeVelocity([y[0], y[1], y[2]], [y[3], y[4], y[5]])) - 1.5,
          terminal: true, direction: -1,
        },
        { name: 'tanks-dry', g: (tt, y) => y[6] - dryMass, terminal: true, direction: -1 },
      ],
      eventTol: 1e-4, onStep: record,
    });
    thrustMode = 'coast';
    propRemaining -= startMass - res.y[6];
    events.push({
      name: 'landing-burn', t: tRef,
      deltaV: 0,
      propellantUsed: startMass - res.y[6],
      altitude: igniteAlt,
      short: res.events[res.events.length - 1]?.name === 'tanks-dry',
    });
    tRef = res.t; state = res.y;
    landingDone = true;
    reason = res.events[res.events.length - 1]?.name;

    // If it stopped above the ground, let it settle the last few metres.
    if (reason === 'stopped') {
      const alt = geodeticAltitude([state[0], state[1], state[2]]);
      if (alt > 1) {
        res = run(tRef + 30, [groundEvent]);
        tRef = res.t; state = res.y;
      }
    }
  }

  record(tRef, state);

  // --- outcome ------------------------------------------------------------
  const touchdownR = [state[0], state[1], state[2]];
  const touchdownSpeed = V.norm(relativeVelocity(
    touchdownR, [state[3], state[4], state[5]]));
  const touchdownAlt = geodeticAltitude(touchdownR);

  // A landing is a landing if the vehicle arrives slowly enough to stand on its
  // legs. Falcon 9 touches down around 2 m/s; above roughly 10 it is an impact.
  const softLanding = landingDone && touchdownSpeed < 10 && touchdownAlt < 500;

  // Downrange has to be measured in the EARTH-FIXED frame. Comparing inertial
  // positions counts the planet's own rotation as distance the booster flew:
  // over a 350 s flight that is 2800 km of pure bookkeeping error, and it turns
  // a return-to-launch-site landing into an apparent 4000 km miss.
  let downrangeKm = null;
  if (siteLatLon && jd0 != null) {
    const thetaLand = gmst(jd0 + tRef / 86400);
    const g = ecefToGeodetic(eciToEcef(touchdownR, thetaLand));
    const φ1 = siteLatLon.latitude * Math.PI / 180;
    const λ1 = siteLatLon.longitude * Math.PI / 180;
    const φ2 = g.latitude * Math.PI / 180;
    const λ2 = g.longitude * Math.PI / 180;
    // Haversine on the mean sphere.
    const dφ = φ2 - φ1;
    const dλ = λ2 - λ1;
    const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
    downrangeKm = (2 * Math.asin(Math.min(1, Math.sqrt(h))) * R_EARTH_EQ) / 1000;
    var landingSite = { latitude: g.latitude, longitude: g.longitude };
  } else if (siteEci) {
    const a = V.unit(siteEci);
    const b = V.unit(touchdownR);
    downrangeKm = (Math.acos(Math.max(-1, Math.min(1, V.dot(a, b)))) * R_EARTH_EQ) / 1000;
  }

  return {
    mode, profile, samples, events,
    softLanding,
    touchdownSpeed,
    touchdownAltitude: touchdownAlt,
    downrangeKm,
    landingSite: typeof landingSite !== 'undefined' ? landingSite : null,
    propellantUsed: propellant - propRemaining,
    propellantRemaining: propRemaining,
    propellantSufficient: propRemaining > 0 && !events.some((e) => e.short),
    flightTime: tRef - t0,
    entryDone,
    landingDone,
  };
}
