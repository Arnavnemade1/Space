/**
 * Three-degree-of-freedom launch ascent simulation.
 *
 * Integrated in ECI with a rotating atmosphere, so the launch site's eastward
 * velocity and the air-relative drag both fall out of the geometry rather than
 * being added as fudge terms.
 *
 * WHAT IS MODELLED
 *   - Pressure-corrected thrust: F(h) = F_vac - A_e * P(h), with A_e inferred
 *     from each stage's published sea-level/vacuum thrust split.
 *   - Drag against the co-rotating atmosphere, with a Mach-dependent drag
 *     coefficient.
 *   - J2 gravity.
 *   - Staging, fairing jettison on the free-molecular-heating criterion,
 *     throttling to an axial acceleration limit.
 *   - Exact delta-v loss decomposition (gravity, drag, steering), integrated
 *     alongside the state rather than differenced afterwards.
 *
 * WHAT IS NOT MODELLED
 *   - Rotational dynamics, control authority, gimbal limits, bending modes.
 *     This is a 3DOF point-mass sim: it will happily fly a trajectory no real
 *     vehicle could hold, so unreasonable guidance inputs give unreasonable
 *     results without complaint.
 *   - Winds, wind shear, and the resulting angle-of-attack loads.
 *   - Engine-out, propellant slosh, ullage, residuals, boil-off.
 *   - Booster recovery: reserved propellant is deducted from the first stage
 *     if `reusableBooster` is set, but the return trajectory is not flown.
 */

import { MU_EARTH, R_EARTH_EQ, G0, DEG } from './constants.js';
import { atmosphere } from './atmosphere.js';
import { earthGravity } from './gravity.js';
import { propagate } from './integrate.js';
import {
  relativeVelocity, geodeticToEcef, ecefToEci, gmst, ecefToGeodetic, eciToEcef,
  geodeticAltitude,
} from './frames.js';
import { rvToElements, trueToMean } from './orbit.js';
import { nozzleExitArea, boosterExitArea, boosterMass, liftoffThrust } from './vehicles.js';
import * as V from './vec3.js';

// State layout: position(3), velocity(3), mass(1), four loss accumulators, and
// the propellant remaining in any strap-on boosters.
//
// Booster propellant has to be integrated separately rather than inferred from
// total mass: while boosters and core burn together the stack loses mass from
// two tanks at two different rates, and only the booster tank running dry
// triggers separation.
const IX = 0, IY = 1, IZ = 2, IVX = 3, IVY = 4, IVZ = 5, IM = 6;
const I_DV_IDEAL = 7, I_DV_GRAV = 8, I_DV_DRAG = 9, I_DV_STEER = 10;
const I_BOOST_PROP = 11;
const STATE_SIZE = 12;

/**
 * Drag coefficient of a slender launch vehicle versus Mach number.
 *
 * Piecewise-linear through the classic transonic rise and supersonic decay.
 * Real vehicles publish CFD-derived tables; this curve reproduces the shape
 * and the peak location (Cd ~ 0.75 near Mach 1.2, falling to ~0.25 by Mach 5)
 * that drives where max-Q lands. It is a shape model, not vehicle-specific
 * aerodynamics -- a different fairing changes these numbers by tens of percent.
 */
export function dragCoefficient(mach) {
  const pts = [
    [0.0, 0.30], [0.6, 0.30], [0.8, 0.36], [0.95, 0.60], [1.05, 0.75],
    [1.2, 0.74], [1.5, 0.63], [2.0, 0.50], [3.0, 0.36], [5.0, 0.26],
    [10.0, 0.22], [25.0, 0.20],
  ];
  if (mach <= pts[0][0]) return pts[0][1];
  if (mach >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 1; i < pts.length; i++) {
    if (mach <= pts[i][0]) {
      const [m0, c0] = pts[i - 1];
      const [m1, c1] = pts[i];
      return c0 + ((c1 - c0) * (mach - m0)) / (m1 - m0);
    }
  }
  return 0.2;
}

/**
 * Sutton-Graves stagnation-point convective heating rate [W/m^2].
 *   q = k * sqrt(rho / Rn) * V^3,  k = 1.7415e-4 for Earth air (SI units).
 * Used as the aerothermal indicator; `Rn` is the nose radius.
 */
export function stagnationHeatFlux(rho, velocity, noseRadius = 1.0) {
  return 1.7415e-4 * Math.sqrt(rho / noseRadius) * velocity ** 3;
}

/** Free-molecular heating flux [W/m^2], the standard fairing-jettison criterion. */
export const freeMolecularHeatFlux = (rho, velocity) => 0.5 * rho * velocity ** 3;

/**
 * Local vertical / downrange basis at a state.
 *
 * `horizontal` points downrange within the TARGET orbital plane when one is
 * supplied, and within the current osculating plane otherwise.
 *
 * Using the target plane matters: on the pad the vehicle's only inertial
 * velocity is Earth's rotation, which points due east. Deriving the steering
 * plane from the current velocity therefore locks every launch into an
 * eastward trajectory, and the achieved inclination silently collapses to the
 * launch site's latitude no matter what inclination was requested. A polar
 * launch from Vandenberg has to steer out of that eastward start, and paying
 * for it is exactly why polar launches carry less payload.
 */
function localFrame(r, v, planeNormal) {
  const up = V.unit(r);
  const h = planeNormal ?? V.cross(r, v);
  let horizontal;
  if (V.norm(h) < 1e-3) {
    // Purely radial motion with no target plane: fall back to any vector
    // perpendicular to up.
    const ref = Math.abs(up[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    horizontal = V.unit(V.rejectFrom(ref, up));
  } else {
    horizontal = V.unit(V.rejectFrom(V.cross(h, r), up));
  }
  return { up, horizontal };
}

/**
 * Yaw steering: add an out-of-plane thrust component that drives the velocity
 * back into the target orbital plane.
 *
 * Proportional on the out-of-plane velocity component, limited to `maxYaw` so
 * the correction never dominates the pitch command. This is the same job real
 * launch guidance does under the name "yaw steering" -- it is what makes the
 * achieved inclination match the targeted one rather than drifting toward the
 * site latitude.
 *
 * Gated to the vacuum phase, and for two independent reasons. Aerodynamically,
 * yawing into a 400 m/s crosswind of one's own making is sideslip, and sideslip
 * loads are what the q-alpha budget exists to prevent. Energetically, on the
 * pad the ENTIRE inertial velocity is Earth's rotation, so the out-of-plane
 * fraction is 1.0 and an ungated proportional law commands full deflection --
 * which tips a thrust-to-weight of 1.4 far enough off vertical that the vehicle
 * never leaves the ground. Out of the atmosphere the residual is a few percent
 * of orbital speed and costs almost nothing to null.
 */
function applyYawSteering(dir, v, planeNormal, gain, maxYaw, active) {
  if (!planeNormal || !active) return dir;
  const speed = V.norm(v);
  if (speed < 1) return dir;

  const outOfPlane = V.dot(v, planeNormal) / speed;
  const correction = Math.max(-Math.sin(maxYaw), Math.min(Math.sin(maxYaw), -gain * outOfPlane));
  return V.unit(V.add(dir, V.scale(planeNormal, correction)));
}

/** Flight path angle: angle of the velocity vector above the local horizon [rad]. */
export function flightPathAngle(r, v) {
  const speed = V.norm(v);
  if (speed === 0) return Math.PI / 2;
  return Math.asin(Math.min(1, Math.max(-1, V.dot(V.unit(r), v) / speed)));
}

/**
 * Rotate a commanded thrust direction back toward the airspeed vector so the
 * angle of attack never exceeds `maxAlpha`.
 *
 * This is the constraint that actually shapes a real ascent. A launch vehicle
 * is a long thin tube with almost no lifting surface; flying it at an angle to
 * the airflow generates a normal force that has to be reacted by the airframe
 * and trimmed by gimballing the engines. Trajectory designers therefore fly a
 * pitch profile subject to a q-alpha limit, and the limiter -- not the profile
 * -- is what makes the atmospheric phase look like a gravity turn.
 */
export function clampAngleOfAttack(dir, vRel, maxAlpha) {
  const speed = V.norm(vRel);
  if (speed < 30 || maxAlpha >= Math.PI / 2) return dir;

  const vHat = V.scale(vRel, 1 / speed);
  const alpha = V.angleBetween(dir, vHat);
  if (alpha <= maxAlpha) return dir;

  const axis = V.cross(vHat, dir);
  if (V.norm(axis) < 1e-12) return dir;
  return V.rotateAbout(vHat, V.unit(axis), maxAlpha);
}

/**
 * Guidance law. Pure function of state -- no hidden mode variables -- so a
 * trajectory is exactly reproducible and the law itself is unit-testable.
 *
 * Phases:
 *   1. Vertical rise   - clear the tower, thrust straight up.
 *   2. Pitch profile   - commanded pitch above the local horizon following
 *                        gamma(h) = 90 * (1 - (h/h_turn)^n). This is how real
 *                        vehicles actually fly the atmosphere: a stored
 *                        profile shaped to approximate a gravity turn, not an
 *                        open-loop gravity turn itself. A true zero-AoA turn
 *                        is only neutrally stable -- kick a degree too hard at
 *                        low speed and the vehicle pitches over and flies into
 *                        the sea, which is precisely why nobody flies one.
 *                        The simulator reports the resulting angle of attack
 *                        so an unflyable profile is visible rather than silent.
 *   3. Closed loop     - above the sensible atmosphere, steer proportionally
 *                        on apoapsis error until the target apoapsis is met.
 *
 * Setting `mode: 'gravity-turn'` flies the pure zero-AoA turn instead, for
 * comparison. It is genuinely what the physics does with no control input --
 * and it is genuinely hard to make reach orbit, which is a real result.
 */
export function guidanceDirection(t, y, ctx) {
  const r = [y[IX], y[IY], y[IZ]];
  const v = [y[IVX], y[IVY], y[IVZ]];
  const vRel = relativeVelocity(r, v);
  const { up, horizontal } = localFrame(r, v, ctx.planeNormal);
  const g = ctx.guidance;
  const alt = geodeticAltitude(r);

  // --- Phase 1: vertical rise ----------------------------------------------
  if (t < g.verticalRiseTime) {
    return { dir: up, phase: 'vertical', pitchCmd: Math.PI / 2 };
  }

  // Build a thrust direction from a commanded pitch above the local horizon,
  // held in the current orbital plane so steering never perturbs inclination.
  const yawActive = alt > g.yawSteeringAltitude;
  const fromPitch = (pitch) =>
    applyYawSteering(
      V.unit(V.add(V.scale(up, Math.sin(pitch)), V.scale(horizontal, Math.cos(pitch)))),
      v,
      ctx.planeNormal,
      g.yawGain,
      g.maxYaw,
      yawActive,
    );

  // --- Phase 3 gate --------------------------------------------------------
  const inClosedLoop = alt > g.pitchProgramAltitude || ctx.stageIndex > 0;

  if (!inClosedLoop) {
    if (g.mode === 'gravity-turn') {
      // Pure zero-angle-of-attack turn: thrust exactly along the airspeed
      // vector. Needs a pitch kick to start, since a perfectly vertical
      // trajectory never turns.
      const kickEnd = g.verticalRiseTime + g.kickDuration;
      if (t < kickEnd) {
        const frac = (t - g.verticalRiseTime) / g.kickDuration;
        const axis = V.unit(V.cross(up, ctx.azimuthDir));
        const dir = V.norm(axis) < 1e-9 ? up : V.rotateAbout(up, axis, g.kickAngle * frac);
        return { dir, phase: 'kick', pitchCmd: Math.PI / 2 - g.kickAngle * frac };
      }
      const speed = V.norm(vRel);
      if (speed < 1) return { dir: up, phase: 'gravity-turn', pitchCmd: Math.PI / 2 };
      return {
        dir: V.scale(vRel, 1 / speed),
        phase: 'gravity-turn',
        pitchCmd: flightPathAngle(r, vRel),
      };
    }

    // --- Phase 2: commanded atmospheric pitch profile, q-alpha limited ------
    const frac = Math.min(1, Math.max(0, alt / g.turnAltitude));
    const pitchCmd = Math.max(
      g.minAtmosphericPitch,
      (Math.PI / 2) * (1 - Math.pow(frac, g.turnExponent)),
    );

    // The allowable angle of attack is set by the q-alpha budget: generous
    // while the air is thin, tight through max-Q. This is what keeps the
    // commanded profile from tearing the vehicle apart, and it is why the
    // resulting trajectory closely tracks a gravity turn without inheriting
    // its instability.
    const rho = atmosphere(Math.max(alt, 0), { f107: ctx.f107 }).density;
    const q = 0.5 * rho * V.norm(vRel) ** 2;
    const alphaLimit = q > 1
      ? Math.min(g.maxAlphaLowQ, (g.qAlphaLimit / q) * DEG)
      : g.maxAlphaLowQ;

    const dir = clampAngleOfAttack(fromPitch(pitchCmd), vRel, alphaLimit);
    return { dir, phase: 'pitch-profile', pitchCmd, alphaLimit };
  }

  // --- Phase 3: closed loop on apoapsis, biased off prograde ----------------
  //
  // The command is the CURRENT flight path angle plus a bias proportional to
  // the apoapsis shortfall, not an absolute pitch angle.
  //
  // That distinction is worth ~500 m/s. Commanding an absolute pitch means the
  // thrust vector sits at whatever angle to the velocity the trajectory
  // happens to produce -- once the vehicle is flying nearly horizontally at
  // 150 km, an absolute 15 deg command is a 15 deg angle of attack held for
  // minutes, and cos(15 deg) of the thrust is simply thrown away. Anchoring to
  // the flight path angle keeps thrust near prograde and spends only the bias
  // on shaping the orbit, which is what real closed-loop ascent guidance
  // (powered explicit guidance and its relatives) converges to.
  const el = rvToElements(r, v);
  const apoErrorFraction =
    el.e < 1 && Number.isFinite(el.ra)
      ? (ctx.targetRadius - el.ra) / ctx.targetRadius
      : -0.1;

  const gammaNow = flightPathAngle(r, v);
  const bias = Math.min(
    g.maxPitchBias,
    Math.max(g.minPitchBias, g.apoapsisGain * apoErrorFraction),
  );

  // Reference flight path angle schedule.
  //
  // Anchoring the command to prograde alone is efficient but has no memory of
  // where the trajectory SHOULD be: it faithfully preserves whatever angle the
  // lower stages happened to leave behind. A vehicle handed over at 48 degrees
  // stays lofted, coasts to 660 km with 5 km/s, and strands its upper stage --
  // which is exactly what Vulcan and Ariane 6 did.
  //
  // So a reference is added: gamma should decay from its initial value to zero
  // as speed approaches orbital, because an orbit IS the state where the
  // velocity is horizontal. The gain term below vanishes when the trajectory is
  // on schedule, so the efficient prograde anchoring is preserved in the
  // nominal case and only a genuinely off-nominal trajectory pays steering loss
  // to be corrected.
  const speedNow = V.norm(v);
  const vOrbitTarget = Math.sqrt(MU_EARTH / ctx.targetRadius);
  const speedFrac = Math.min(1, Math.max(0, speedNow / vOrbitTarget));
  const gammaRef = g.gammaRefMax * Math.pow(1 - speedFrac, g.gammaRefExponent);

  let pitchCmd = Math.min(
    g.maxPitch,
    Math.max(
      g.minPitch,
      gammaNow + g.gammaTrackGain * (gammaRef - gammaNow) + bias + g.terminalPitch,
    ),
  );

  // Altitude floor. Anchoring purely to prograde lets the flight path angle go
  // negative once the apoapsis bias relaxes -- the vehicle levels off, then
  // starts sinking back toward the atmosphere while still gaining speed. It
  // can technically still reach the target apoapsis that way, but it reaches
  // it on the DESCENDING branch, which is not a trajectory anyone flies: the
  // coast to apoapsis is then behind the vehicle rather than ahead of it.
  //
  // The pitch that holds altitude is not something to servo toward with a
  // guessed gain -- it follows from a force balance. Level flight needs the
  // vertical thrust component to cancel whatever gravity the centrifugal term
  // has not already cancelled:
  //
  //     (T/m) sin(pitch) = mu/r^2 - v_horizontal^2 / r
  //
  // As horizontal speed approaches orbital, the right-hand side goes to zero
  // and the required pitch goes to zero on its own. That is the whole reason
  // an ascent can flatten out at all.
  // Two distinct ways a powered trajectory can end up in the atmosphere, and
  // they need opposite responses.
  //
  //   CLIMB   - the apoapsis itself is still inside the atmosphere. The
  //             vehicle is on its way up but the arc it is on does not clear.
  //             Worth a modest pitch-up, but only if the stage can win: a
  //             low-thrust upper stage told to fight gravity vertically spends
  //             everything climbing, still falls, and arrives with no
  //             horizontal speed. Above `maxHoldPitch` the correct answer is
  //             to thrust horizontally instead and let orbital speed relieve
  //             gravity through the centrifugal term.
  //
  //   ARREST  - the vehicle is DESCENDING toward a perigee inside the
  //             atmosphere. Here there is no "let it arc out" option, because
  //             the arc is what is killing it. Vulcan's Centaur reached 8.1
  //             km/s at 57 km -- comfortably past orbital speed for that
  //             radius -- and burned up anyway, purely because the velocity
  //             was pointed 7 degrees down. Pitch up as hard as needed.
  //
  // Keying the whole test off apoapsis alone conflates them: once apoapsis
  // rises past the threshold the floor switches off, even when the apoapsis is
  // behind the vehicle and it is falling away from it.
  // Both tests are keyed to the ATMOSPHERE, not to the target orbit.
  //
  // Keying them to the target instead makes low targets harder than high ones,
  // which is backwards. Asking Vulcan for 200 km made perigee sit below the
  // "safe" altitude for the entire flight, so the arrest logic held the vehicle
  // in a permanent climb and it never converged -- while the same vehicle
  // reached 600 km without complaint. The only thing the vehicle actually has
  // to avoid is coming back into the air; where it is trying to end up is the
  // guidance loop's business, not the survival floor's.
  const atmosphereFloor = g.atmosphereFloor;
  const apoapsisAlt = el.e < 1 && Number.isFinite(el.ra) ? el.ra - R_EARTH_EQ : Infinity;
  const perigeeAlt = el.e < 1 && Number.isFinite(el.rp) ? el.rp - R_EARTH_EQ : -Infinity;

  const rMag = V.norm(r);
  const radialSpeed = V.dot(v, up);

  const mustClimb = apoapsisAlt < atmosphereFloor;
  const mustArrest = radialSpeed < 0 && perigeeAlt < atmosphereFloor;

  if ((mustClimb || mustArrest) && ctx.thrustAccel > 0) {
    const horizontalSpeed2 = Math.max(0, V.norm2(v) - radialSpeed * radialSpeed);
    const gNet = MU_EARTH / (rMag * rMag) - horizontalSpeed2 / rMag;

    if (gNet > 0) {
      const ratio = gNet / ctx.thrustAccel;
      if (mustArrest) {
        pitchCmd = Math.max(pitchCmd, Math.min(g.maxPitch, Math.asin(Math.min(1, ratio))));
      } else if (ratio < Math.sin(g.maxHoldPitch)) {
        pitchCmd = Math.max(pitchCmd, Math.min(g.maxPitch, Math.asin(ratio)));
      }
    }
  }

  return { dir: fromPitch(pitchCmd), phase: 'closed-loop', pitchCmd, bias };
}

/** Default guidance parameters. Every one of these is meant to be tuned. */
export const DEFAULT_GUIDANCE = {
  mode: 'profile',              // 'profile' | 'gravity-turn'
  verticalRiseTime: 10,         // [s] straight up off the pad
  turnAltitude: 75e3,           // [m] altitude at which commanded pitch hits 0
  turnExponent: 0.55,           // shape of the atmospheric pitch profile
  minAtmosphericPitch: 8 * DEG, // [rad] floor while still in the atmosphere
  pitchProgramAltitude: 60e3,   // [m] hand over to closed-loop guidance
  terminalPitch: 0,             // [rad] trim added to the closed-loop command
  apoapsisGain: 4,              // closed-loop gain on fractional apoapsis error
  maxPitchBias: 12 * DEG,       // [rad] most the command may lead prograde by
  minPitchBias: -10 * DEG,      // [rad] most it may trail prograde by
  gammaRefMax: 32 * DEG,        // [rad] reference flight path angle at zero speed
  gammaRefExponent: 1.2,        // how the reference decays toward orbital speed
  gammaTrackGain: 1.4,          // how hard to correct back onto the reference
  maxPitch: 45 * DEG,
  minPitch: -15 * DEG,
  atmosphereFloor: 130e3,       // [m] altitude the trajectory must clear
  maxHoldPitch: 35 * DEG,       // [rad] give up on altitude-hold beyond this
  maxAxialAccel: 4 * G0,        // [m/s^2] throttle down to hold this

  // Structural limits on atmospheric steering.
  // 1.4e5 Pa-deg is about 3000 psf-deg, a commonly cited launch-vehicle design
  // limit. It is a rule of thumb, not a spec for any particular vehicle --
  // real limits are trajectory- and airframe-specific.
  qAlphaLimit: 1.4e5,           // [Pa deg]
  maxAlphaLowQ: 15 * DEG,       // [rad] cap where dynamic pressure is negligible

  // Yaw steering onto the target orbital plane. Vacuum only -- see
  // applyYawSteering for why it must not run in the atmosphere.
  yawGain: 3,
  maxYaw: 25 * DEG,
  yawSteeringAltitude: 55e3,    // [m] above which yaw steering engages

  // Only used when mode === 'gravity-turn'.
  kickDuration: 6,
  kickAngle: 2 * DEG,
};

/**
 * Run an ascent.
 *
 * @param {object} cfg
 * @param {object} cfg.vehicle          entry from VEHICLES
 * @param {object} cfg.site             entry from LAUNCH_SITES
 * @param {number} cfg.payloadMass      [kg]
 * @param {number} cfg.targetAltitude   [m] circular target altitude
 * @param {number} [cfg.targetInclination] [deg]; defaults to the site latitude
 * @param {object} [cfg.guidance]       overrides for DEFAULT_GUIDANCE
 * @param {number} [cfg.referenceArea]  [m^2]; defaults to the vehicle diameter
 * @param {boolean} [cfg.reusableBooster] reserve first-stage propellant for RTLS
 * @param {number} [cfg.f107]           solar flux for the atmosphere model
 * @param {Date}   [cfg.epoch]          launch epoch (sets Earth/Sun geometry)
 * @param {number} [cfg.sampleInterval] [s] trajectory sampling cadence
 */
export function simulateAscent(cfg) {
  const {
    vehicle,
    site,
    payloadMass,
    targetAltitude,
    targetInclination = Math.abs(site.latitude),
    reusableBooster = false,
    f107 = 150,
    epoch = new Date(),
    sampleInterval = 1.0,
    maxTime = 3000,
  } = cfg;

  // --- guidance defaults, scaled to the vehicle ----------------------------
  //
  // The atmospheric pitch profile cannot be one fixed curve for every vehicle.
  // How fast a rocket must turn depends on how fast it is leaving the
  // atmosphere, and that is set by its liftoff thrust-to-weight.
  //
  // A T/W of 1.35 (Falcon 9) spends ~150 s climbing through the air, and the
  // q-alpha limiter has time to walk the vehicle round to a shallow angle. A
  // T/W of 1.95 (Vulcan, Ariane 6 -- both solid-boosted) leaves the sensible
  // atmosphere in ~90 s, and with the SAME profile it arrives at handover
  // still pitched up near 48 degrees. It then flies a hugely lofted trajectory
  // and strands its upper stage, which is precisely what Vulcan did here
  // before this scaling existed.
  //
  // So the reference turn altitude is scaled by (1.35 / TW)^1.5: punchier
  // vehicles are told to start turning lower and earlier. Any explicit
  // turnAltitude the caller passes overrides this.
  const stack0 = vehicle.stages.reduce(
    (a, st) => a + st.dryMass + st.propellantMass + boosterMass(st), 0);
  const liftoffTW =
    liftoffThrust(vehicle.stages[0]) /
    ((stack0 + (vehicle.fairingMass ?? 0) + payloadMass) * G0);

  const autoTurnAltitude = Math.max(
    28e3,
    Math.min(110e3, DEFAULT_GUIDANCE.turnAltitude * Math.pow(1.35 / Math.max(liftoffTW, 0.5), 1.5)),
  );

  const guidance = {
    ...DEFAULT_GUIDANCE,
    turnAltitude: autoTurnAltitude,
    ...(cfg.guidance ?? {}),
  };
  const referenceArea = cfg.referenceArea ?? Math.PI * (vehicle.diameter / 2) ** 2;
  const targetRadius = R_EARTH_EQ + targetAltitude;

  // --- initial conditions ---------------------------------------------------
  const jd = epoch.getTime() / 86400000 + 2440587.5;
  const theta0 = gmst(jd);
  const rEcef = geodeticToEcef(site.latitude, site.longitude, site.altitude);
  const r0 = ecefToEci(rEcef, theta0);
  // On the pad the vehicle is at rest with respect to the ground, so its
  // inertial velocity is purely Earth's rotation. This is the "free" 400+ m/s.
  const v0 = [-7.292115e-5 * r0[1], 7.292115e-5 * r0[0], 0];

  // --- target orbital plane -------------------------------------------------
  //
  // The plane must contain the launch site, so its normal is perpendicular to
  // r0, and its inclination fixes the normal's z-component: cos(i) = n_z.
  // Working through the local horizon basis gives
  //
  //     cos(i) = sin(azimuth) * cos(geocentric latitude)
  //
  // Note GEOCENTRIC latitude, not geodetic. The site database stores geodetic
  // latitude (what a map gives you), and the two differ by up to 0.19 deg --
  // small, but it lands directly on the achieved inclination, so it is worth
  // converting rather than ignoring.
  const upEcef = V.unit(rEcef);
  const northEcef = V.unit(V.rejectFrom([0, 0, 1], upEcef));
  const eastEcef = V.cross(northEcef, upEcef);

  const geocentricLat = Math.asin(upEcef[2]);
  const sinAz = Math.cos(targetInclination * DEG) / Math.cos(geocentricLat);
  const reachableInclination = Math.abs(sinAz) <= 1;

  // Two azimuths give the same inclination -- one northerly, one southerly.
  // Pick whichever lies inside the site's flown corridor; that corridor is a
  // range-safety constraint, not a physical one, and it is the real reason a
  // given pad cannot fly a given inclination.
  const azPrimary = Math.asin(Math.max(-1, Math.min(1, sinAz))) / DEG;
  const azAlternate = 180 - azPrimary;
  const inCorridor = (a) => {
    const w = ((a % 360) + 360) % 360;
    const lo = ((site.azimuthMin % 360) + 360) % 360;
    const hi = ((site.azimuthMax % 360) + 360) % 360;
    return lo <= hi ? w >= lo && w <= hi : w >= lo || w <= hi;
  };
  const azimuthDeg = !reachableInclination
    ? 90
    : inCorridor(azPrimary)
      ? azPrimary
      : inCorridor(azAlternate)
        ? azAlternate
        : azPrimary;

  const azRad = azimuthDeg * DEG;
  const azDirEcef = V.add(V.scale(northEcef, Math.cos(azRad)), V.scale(eastEcef, Math.sin(azRad)));
  const azimuthDir = ecefToEci(azDirEcef, theta0);
  const azimuthInCorridor = reachableInclination && inCorridor(azimuthDeg);

  // --- stage mass bookkeeping ----------------------------------------------
  const stages = vehicle.stages.map((s) => ({ ...s }));
  // How much first-stage propellant recovery holds back. A downrange droneship
  // landing needs entry and landing burns only; returning to the launch site
  // adds a boostback that has to cancel the entire downrange velocity, and that
  // is by far the biggest of the three. The reserve is what forces an RTLS
  // booster to stage early and slow -- and it is why RTLS missions carry
  // noticeably less payload than the same vehicle landing downrange.
  //
  // The numbers are small, and deliberately so. Working the real burns for a
  // Falcon 9 booster: landing needs about 4.5 t, the entry burn about 9 t, and
  // boostback about 23 t -- roughly 37 t against a 411 t first-stage load, so
  // under 10%. Reserving 25-40%, as a first guess suggests, leaves the booster
  // arriving at the pad with a hundred tonnes of dead propellant and a
  // thrust-to-weight below one: it cannot decelerate, and it cannot land.
  const RECOVERY_RESERVE = { none: 0, droneship: 0.12, rtls: 0.18 };
  const recoveryMode = cfg.recoveryMode ?? (reusableBooster ? 'droneship' : 'none');
  const reserveFraction = RECOVERY_RESERVE[recoveryMode] ?? 0;
  if (reserveFraction > 0 && stages.length > 1) {
    stages[0] = {
      ...stages[0],
      propellantMass: stages[0].propellantMass * (1 - reserveFraction),
    };
  }

  const fairingMass = vehicle.fairingMass ?? 0;

  /**
   * Ideal vacuum delta-v still available from every stage ABOVE index `i`.
   * Used to decide whether a lower stage may shut down early.
   */
  const upperStagesDeltaV = (i, fairingOn) => {
    let above = payloadMass + (fairingOn ? fairingMass : 0);
    let dv = 0;
    for (let j = stages.length - 1; j > i; j--) {
      const st = stages[j];
      const m0 = st.dryMass + st.propellantMass + above;
      const mf = st.dryMass + above;
      if (mf > 0 && m0 > mf) dv += st.ispVacuum * G0 * Math.log(m0 / mf);
      above += st.dryMass + st.propellantMass;
    }
    return dv;
  };
  const upperMassAbove = (i) => {
    let m = payloadMass;
    for (let j = i + 1; j < stages.length; j++) {
      m += stages[j].dryMass + stages[j].propellantMass + boosterMass(stages[j]);
    }
    return m;
  };

  let mass =
    stages.reduce((s, st) => s + st.dryMass + st.propellantMass + boosterMass(st), 0) +
    fairingMass +
    payloadMass;

  // Boosters are attached to stage 0 only. `boosterAttached` mirrors
  // `fairingAttached`: a discrete jettison partway through a stage's burn.
  let boosterAttached = !!stages[0].boosters;

  // --- derivative function --------------------------------------------------
  const samples = [];
  const events = [];
  let maxQ = 0, maxQAlt = 0, maxQTime = 0;
  let maxAccel = 0, maxHeatFlux = 0, maxMach = 0;
  let maxAoA = 0, maxQAlpha = 0;
  let fairingAttached = fairingMass > 0;

  // Target orbital plane: the plane containing the launch site and the
  // commanded azimuth. h = r x v, and at liftoff the intended velocity lies
  // along the azimuth direction, so the normal is r_hat x azimuth_hat.
  const planeNormal = V.unit(V.cross(V.unit(r0), V.unit(azimuthDir)));

  const ctx = {
    guidance,
    azimuthDir,
    planeNormal,
    targetRadius,
    stageIndex: 0,
    f107,
  };

  const makeDerivative = (stageIndex, burning) => (t, y) => {
    const r = [y[IX], y[IY], y[IZ]];
    const v = [y[IVX], y[IVY], y[IVZ]];
    const m = y[IM];

    const rMag = V.norm(r);
    const alt = geodeticAltitude(r);
    const atm = atmosphere(Math.max(alt, 0), { f107 });

    const vRel = relativeVelocity(r, v);
    const vRelMag = V.norm(vRel);
    const speed = V.norm(v);

    // --- thrust -----------------------------------------------------------
    const stage = stages[stageIndex];
    let thrust = 0;
    let massFlow = 0;
    let boosterFlow = 0;
    let dir = V.unit(r);

    if (burning && m > 0) {
      const pAmb = atm.pressure ?? 0;
      const b = stage.boosters;
      const boostersLive = !!b && y[I_BOOST_PROP] > 0;

      // Core. While boosters are burning the core may be deliberately
      // throttled down to bank propellant for after separation.
      const coreThrottleCmd = boostersLive ? (b.coreThrottle ?? 1) : 1;
      const coreVac = stage.thrustVacuum * coreThrottleCmd;
      const coreFull = Math.max(0, coreVac - nozzleExitArea(stage) * pAmb * coreThrottleCmd);
      const coreFlowFull = coreVac / (stage.ispVacuum * G0);

      // Boosters. Solids cannot throttle, so only the core responds to the
      // acceleration limiter -- which is exactly the real constraint.
      // Solid motors are not constant-thrust. Their grain geometry gives a
      // regressive profile: high thrust at ignition when the burning surface
      // is largest, tailing off toward burnout. Modelling them flat puts peak
      // acceleration at the END of the burn, when the stack is lightest, and
      // produces axial loads no solid-boosted vehicle actually sees -- Ariane
      // 6 came out at 7.9 g that way against a real limit near 4.5 g.
      //
      // Mass flow follows thrust (mdot = F / (Isp g0)), so total impulse and
      // total delta-v are unchanged; only the timing shifts.
      const boostFrac = boostersLive && b.propellantMass > 0
        ? Math.max(0, Math.min(1, 1 - y[I_BOOST_PROP] / b.propellantMass))
        : 0;
      const taperStart = b?.taperStart ?? 1.25;
      const taperEnd = b?.taperEnd ?? 0.75;
      const taper = boostersLive ? taperStart + (taperEnd - taperStart) * boostFrac : 0;

      const boostFull = boostersLive
        ? Math.max(0, b.thrustVacuum * taper - boosterExitArea(stage) * pAmb)
        : 0;
      const boostFlow = boostersLive ? (b.thrustVacuum * taper) / (b.ispVacuum * G0) : 0;

      // Throttle the core to respect the axial acceleration limit, floored at
      // its minimum throttle.
      let throttle = 1;
      const combinedFull = coreFull + boostFull;
      if (combinedFull / m > guidance.maxAxialAccel) {
        const allowedCore = guidance.maxAxialAccel * m - boostFull;
        throttle = allowedCore > 0
          ? Math.max(stage.minThrottle ?? 1, Math.min(1, allowedCore / Math.max(coreFull, 1e-9)))
          : (stage.minThrottle ?? 1);
      }

      thrust = coreFull * throttle + boostFull;
      massFlow = coreFlowFull * throttle + boostFlow;
      boosterFlow = boostFlow;

      const gd = guidanceDirection(t, y, { ...ctx, stageIndex, thrustAccel: thrust / m });
      dir = gd.dir;
    }

    // --- drag --------------------------------------------------------------
    let dragAccel = [0, 0, 0];
    let dragMag = 0;
    if (atm.density > 0 && vRelMag > 0) {
      const mach = atm.soundSpeed && Number.isFinite(atm.soundSpeed)
        ? vRelMag / atm.soundSpeed
        : 25;
      const cd = dragCoefficient(mach);
      const q = 0.5 * atm.density * vRelMag * vRelMag;
      const dragForce = q * cd * referenceArea;
      dragMag = dragForce / m;
      dragAccel = V.scale(vRel, -dragForce / (m * vRelMag));
    }

    // --- gravity -----------------------------------------------------------
    const gAccel = earthGravity(r, { harmonics: 2 });

    const thrustAccel = V.scale(dir, thrust / m);
    const accel = V.add(V.add(thrustAccel, dragAccel), gAccel);

    // --- loss accounting ----------------------------------------------------
    // Exact decomposition of d|v|/dt into its four contributions, integrated
    // by the same scheme as the state so the books balance to integrator
    // tolerance rather than to a differencing error.
    const vHat = speed > 1e-6 ? V.scale(v, 1 / speed) : [0, 0, 0];
    const cosAlpha = speed > 1e-6 ? V.dot(dir, vHat) : 1;
    const aThrust = thrust / m;

    const dDvIdeal = aThrust;
    const dDvSteer = aThrust * (1 - Math.max(-1, Math.min(1, cosAlpha)));
    const dDvDrag = speed > 1e-6 ? -V.dot(dragAccel, vHat) : dragMag;
    const dDvGrav = speed > 1e-6 ? -V.dot(gAccel, vHat) : 0;

    return [
      v[0], v[1], v[2],
      accel[0], accel[1], accel[2],
      -massFlow,
      dDvIdeal, dDvGrav, dDvDrag, dDvSteer,
      -boosterFlow,
    ];
  };

  // --- sampling -------------------------------------------------------------
  let lastSample = -Infinity;
  const record = (t, y, stageIndex, burning) => {
    if (t - lastSample < sampleInterval && samples.length > 0) return;
    lastSample = t;

    const r = [y[IX], y[IY], y[IZ]];
    const v = [y[IVX], y[IVY], y[IVZ]];
    const rMag = V.norm(r);
    const alt = geodeticAltitude(r);
    const atm = atmosphere(Math.max(alt, 0), { f107 });
    const vRel = relativeVelocity(r, v);
    const vRelMag = V.norm(vRel);
    const q = 0.5 * atm.density * vRelMag * vRelMag;
    const mach = Number.isFinite(atm.soundSpeed) ? vRelMag / atm.soundSpeed : NaN;
    const heat = stagnationHeatFlux(atm.density, vRelMag);

    if (q > maxQ) { maxQ = q; maxQAlt = alt; maxQTime = t; }
    if (Number.isFinite(mach) && mach > maxMach) maxMach = mach;
    if (heat > maxHeatFlux) maxHeatFlux = heat;

    const stage = stages[stageIndex];
    let axialAccel = 0;
    if (burning) {
      const pAmb = atm.pressure ?? 0;
      const b = stage.boosters;
      const boostersLive = !!b && y[I_BOOST_PROP] > 0;
      const coreThrottleCmd = boostersLive ? (b.coreThrottle ?? 1) : 1;
      const coreFull = Math.max(
        0, stage.thrustVacuum * coreThrottleCmd - nozzleExitArea(stage) * pAmb * coreThrottleCmd);
      const boostFrac = boostersLive && b.propellantMass > 0
        ? Math.max(0, Math.min(1, 1 - y[I_BOOST_PROP] / b.propellantMass)) : 0;
      const taper = boostersLive
        ? (b.taperStart ?? 1.25) + ((b.taperEnd ?? 0.75) - (b.taperStart ?? 1.25)) * boostFrac : 0;
      const boostFull = boostersLive
        ? Math.max(0, b.thrustVacuum * taper - boosterExitArea(stage) * pAmb) : 0;
      let throttle = 1;
      if ((coreFull + boostFull) / y[IM] > guidance.maxAxialAccel) {
        const allowedCore = guidance.maxAxialAccel * y[IM] - boostFull;
        throttle = allowedCore > 0
          ? Math.max(stage.minThrottle ?? 1, Math.min(1, allowedCore / Math.max(coreFull, 1e-9)))
          : (stage.minThrottle ?? 1);
      }
      axialAccel = (coreFull * throttle + boostFull) / y[IM];
    }
    if (axialAccel > maxAccel) maxAccel = axialAccel;

    // Angle of attack between the commanded thrust axis and the airspeed
    // vector, and the q-alpha product that actually sets the structural side
    // load. Real vehicles hold |q-alpha| below roughly 2000-4000 Pa-deg
    // through max-Q; a profile that exceeds that is not flyable, however
    // cheerfully this point-mass model integrates it.
    let aoaDeg = 0;
    let qAlpha = 0;
    if (burning && vRelMag > 50) {
      const gd = guidanceDirection(t, y, {
        ...ctx, stageIndex, thrustAccel: axialAccel,
      });
      aoaDeg = V.angleBetween(gd.dir, vRel) / DEG;
      qAlpha = q * aoaDeg;
      if (q > 1000) {
        if (aoaDeg > maxAoA) maxAoA = aoaDeg;
        if (qAlpha > maxQAlpha) maxQAlpha = qAlpha;
      }
    }

    const theta = gmst(jd + t / 86400);
    const geo = ecefToGeodetic(eciToEcef(r, theta));

    samples.push({
      angleOfAttack: aoaDeg,
      qAlpha,
      t,
      r: [...r],
      v: [...v],
      altitude: alt,
      speed: V.norm(v),
      relativeSpeed: vRelMag,
      mass: y[IM],
      dynamicPressure: q,
      mach,
      heatFlux: heat,
      axialAccel,
      // Inertial flight path angle starts near zero on the pad (the vehicle is
      // already moving east at 400+ m/s with the ground), so the air-relative
      // angle is the one that means "how steeply am I climbing".
      flightPathAngle: flightPathAngle(r, vRel) / DEG,
      inertialFlightPathAngle: flightPathAngle(r, v) / DEG,
      latitude: geo.latitude,
      longitude: geo.longitude,
      stageIndex,
      burning,
      dvIdeal: y[I_DV_IDEAL],
      dvGravityLoss: y[I_DV_GRAV],
      dvDragLoss: y[I_DV_DRAG],
      dvSteeringLoss: y[I_DV_STEER],
    });
  };

  // --- main phase loop ------------------------------------------------------
  let y = [
    r0[0], r0[1], r0[2],
    v0[0], v0[1], v0[2],
    mass,
    0, 0, 0, 0,
    stages[0].boosters ? stages[0].boosters.propellantMass : 0,
  ];
  let t = 0;
  let status = 'running';
  let stageIndex = 0;

  const groundEvent = {
    name: 'ground-impact',
    g: (tt, yy) => geodeticAltitude([yy[IX], yy[IY], yy[IZ]]) - site.altitude,
    terminal: true,
    direction: -1,
  };

  while (stageIndex < stages.length && t < maxTime && status === 'running') {
    const stage = stages[stageIndex];
    ctx.stageIndex = stageIndex;
    // Core burnout is when the CORE tank is empty. With boosters still
    // attached the stack also carries their dry mass and whatever propellant
    // they have left, so the threshold is state-dependent.
    const coreBurnoutMass = (yy) =>
      stage.dryMass + upperMassAbove(stageIndex) + (fairingAttached ? fairingMass : 0) +
      (boosterAttached && stage.boosters ? stage.boosters.dryMass + Math.max(0, yy[I_BOOST_PROP]) : 0);

    // The apoapsis cutoff used to be restricted to the final stage, because a
    // high-energy first stage would trip it while still low and slow and
    // strand the upper stage. The flight-path-angle reference removed that
    // failure mode, and keeping the restriction now causes the opposite one:
    // SLS's core burns to depletion and overshoots a 400 km request by 3000 km.
    // Real vehicles command MECO on a targeted state, not on an empty tank.
    const isFinalStage = stageIndex === stages.length - 1;

    const segmentEvents = [
      groundEvent,
      {
        name: 'burnout',
        g: (tt, yy) => yy[IM] - coreBurnoutMass(yy),
        terminal: true,
        direction: -1,
      },
    ];

    // Cutting off at the target apoapsis is only meaningful on the LAST stage.
    // A high-energy first stage -- Ariane 6's solids, Vulcan's core -- can loft
    // the apoapsis past the target long before it is empty, and stopping there
    // would strand the vehicle on stage one with its upper stage never lit.
    // Real vehicles burn the lower stages to depletion and shape the orbit
    // with the last one.
    {
      // If the lower stages have already lofted the apoapsis past the target
      // by the time the final stage lights, there is no zero crossing left for
      // an ascending-edge event to catch, and the stage would burn to
      // depletion -- Ariane 6 ran to a 9500 km orbit that way while reporting
      // success. Cut off immediately in that case and let the coast-and-
      // circularise phase salvage whatever orbit is actually reachable.
      const elAtIgnition = rvToElements(
        [y[IX], y[IY], y[IZ]], [y[IVX], y[IVY], y[IVZ]]);
      const alreadyPastTarget =
        geodeticAltitude([y[IX], y[IY], y[IZ]]) > 60e3 &&
        elAtIgnition.e < 1 && elAtIgnition.ra >= targetRadius;

      if (alreadyPastTarget) {
        events.push({
          t,
          name: 'apoapsis-already-exceeded',
          altitude: geodeticAltitude([y[IX], y[IY], y[IZ]]),
          stageIndex,
        });
        status = 'apoapsis-reached';
        break;
      }

      segmentEvents.push({
        name: 'target-apoapsis',
        g: (tt, yy) => {
          const rr = [yy[IX], yy[IY], yy[IZ]];
          const vv = [yy[IVX], yy[IVY], yy[IVZ]];
          if (geodeticAltitude(rr) < 60e3) return -1;
          const el = rvToElements(rr, vv);
          if (el.e >= 1) return 1;
          // Only cut off on the ASCENDING branch. Reaching the target apoapsis
          // while already descending means the apoapsis is behind the vehicle,
          // and the "coast to apoapsis" that follows would have nothing to
          // coast to -- it would circularise at the current low altitude.
          if (V.dot(rr, vv) < 0) return -1;

          // A lower stage may only shut down early if what is left above it can
          // actually finish the job.
          //
          // This is the condition that separates SLS from Ariane 6. SLS's core
          // has so much energy that burning it dry overshoots a 400 km request
          // by 3000 km, and its ICPS can easily circularise -- so it should cut
          // off on target. Ariane 6's core reaches the same apoapsis with a
          // Vinci that cannot close the gap, so cutting off there strands the
          // vehicle. Same event, opposite correct answers, and the difference
          // is nothing but the upper stage's remaining delta-v.
          if (!isFinalStage) {
            const vApo = Math.sqrt(MU_EARTH * (2 / el.ra - 1 / el.a));
            const dvToCircularise = Math.sqrt(MU_EARTH / el.ra) - vApo;
            const dvAvailable = upperStagesDeltaV(stageIndex, fairingAttached);
            if (dvAvailable < dvToCircularise * 1.2) return -1;

            // Having the delta-v is necessary but not sufficient. The upper
            // stage also has to be able to SPEND it in the time available.
            //
            // Comparing an ideal delta-v against an impulsive requirement
            // flatters a low-thrust stage enormously. Ariane 6's Vinci clears
            // the energy test with 4000 m/s against a 2400 m/s need -- and then
            // takes 675 seconds to deliver it, against roughly 120 seconds of
            // coast before apoapsis. It burns straight through the apex and
            // sinks from 400 km to 170 km while still thrusting, because a
            // thrust-to-weight of 0.33 cannot hold that altitude at that speed.
            //
            // So require the burn to fit, roughly, inside the ballistic arc it
            // has to work within. This is the test that distinguishes Ariane's
            // core (must burn to depletion) from SLS's core (must shut down
            // early), which the energy test alone cannot.
            const next = stages[stageIndex + 1];
            const mAfterStaging = yy[IM] - stage.dryMass -
              (boosterAttached && stage.boosters
                ? stage.boosters.dryMass + Math.max(0, yy[I_BOOST_PROP]) : 0);
            const propNeeded =
              mAfterStaging * (1 - Math.exp(-dvToCircularise / (next.ispVacuum * G0)));
            const nextFlow = next.thrustVacuum / (next.ispVacuum * G0);
            const burnSeconds = propNeeded / nextFlow;

            const meanAnom = trueToMean(el.nu, el.e);
            const nMotion = (2 * Math.PI) / el.period;
            const secondsToApoapsis = Math.max(0, (Math.PI - meanAnom) / nMotion);

            if (burnSeconds > 2 * secondsToApoapsis) return -1;
          }

          return el.ra - targetRadius;
        },
        terminal: true,
        direction: 1,
      });
    }

    if (boosterAttached && stage.boosters) {
      segmentEvents.push({
        name: 'booster-separation',
        g: (tt, yy) => yy[I_BOOST_PROP],
        terminal: true,
        direction: -1,
      });
    }

    if (fairingAttached) {
      segmentEvents.push({
        name: 'fairing-jettison',
        // Industry criterion: jettison once free-molecular heating falls below
        // 1135 W/m^2 (0.1 BTU/ft^2/s). Typically around 110 km.
        g: (tt, yy) => {
          const rr = [yy[IX], yy[IY], yy[IZ]];
          const alt = geodeticAltitude(rr);
          if (alt < 60e3) return 1;
          const vv = relativeVelocity(rr, [yy[IVX], yy[IVY], yy[IVZ]]);
          const rho = atmosphere(alt, { f107 }).density;
          return freeMolecularHeatFlux(rho, V.norm(vv)) - 1135;
        },
        terminal: true,
        direction: -1,
      });
    }

    const res = propagate({
      f: makeDerivative(stageIndex, true),
      t0: t,
      y0: y,
      tEnd: maxTime,
      h0: 0.05,
      hMax: 2,
      rtol: 1e-9,
      atol: 1e-6,
      events: segmentEvents,
      eventTol: 1e-3,
      onStep: (tt, yy) => record(tt, yy, stageIndex, true),
    });

    t = res.t;
    y = res.y;
    const fired = res.events[res.events.length - 1];
    const reason = fired?.name ?? res.status;

    events.push({ t, name: reason, altitude: geodeticAltitude([y[IX], y[IY], y[IZ]]), stageIndex });

    if (reason === 'ground-impact') { status = 'crashed'; break; }
    if (reason === 'target-apoapsis') {
      status = 'apoapsis-reached';
      // If a LOWER stage commanded the cutoff, stage before coasting. The
      // circularisation burn belongs to what is above, not to the spent stage
      // that just shut down -- otherwise Ariane 6 tries to circularise on its
      // core and never lights the Vinci at all.
      if (stageIndex < stages.length - 1) {
        y = [...y];
        y[IM] -= stage.dryMass;
        if (boosterAttached && stage.boosters) {
          y[IM] -= stage.boosters.dryMass + Math.max(0, y[I_BOOST_PROP]);
          boosterAttached = false;
        }
        y[I_BOOST_PROP] = 0;
        stageIndex++;
        ctx.stageIndex = stageIndex;
        events.push({
          t,
          name: 'stage-separation',
          altitude: geodeticAltitude([y[IX], y[IY], y[IZ]]),
          stageIndex,
        });
      }
      break;
    }

    if (reason === 'booster-separation') {
      // Throw away the empty booster casings. The core keeps burning, now at
      // full throttle and with a far better thrust-to-weight.
      boosterAttached = false;
      y = [...y];
      y[IM] -= stage.boosters.dryMass;
      y[I_BOOST_PROP] = 0;
      continue;
    }

    if (reason === 'fairing-jettison') {
      fairingAttached = false;
      y = [...y];
      y[IM] -= fairingMass;
      continue; // same stage keeps burning
    }

    if (reason === 'burnout') {
      // Drop the spent stage, plus any boosters still attached (they cannot
      // outlast the core, but be defensive rather than leak their mass).
      y = [...y];
      y[IM] -= stage.dryMass;
      if (boosterAttached && stage.boosters) {
        y[IM] -= stage.boosters.dryMass + Math.max(0, y[I_BOOST_PROP]);
        boosterAttached = false;
      }
      y[I_BOOST_PROP] = 0;
      stageIndex++;
      if (stageIndex >= stages.length) { status = 'propellant-exhausted'; break; }
      events.push({ t, name: 'stage-separation', altitude: geodeticAltitude([y[IX], y[IY], y[IZ]]), stageIndex });
      continue;
    }

    status = res.status === 'max-steps' ? 'max-steps' : 'timeout';
    break;
  }

  // --- coast to apoapsis, then finite circularisation burn ------------------
  //
  // MECO leaves the vehicle on an ellipse whose perigee is inside the Earth --
  // that is normal and is what real launches do. The orbit only becomes an
  // orbit after the circularisation burn at apoapsis, so that burn is
  // simulated rather than approximated impulsively: a finite burn at 1-2 m/s^2
  // spread over a minute has real cosine losses and real gravity losses.

  let circularisation = null;
  const propellantAt = (yy, si) => {
    if (si >= stages.length) return 0;
    const st = stages[si];
    const burnoutMass =
      st.dryMass + upperMassAbove(si) + (fairingAttached ? fairingMass : 0) +
      (boosterAttached && st.boosters ? st.boosters.dryMass + Math.max(0, yy[I_BOOST_PROP]) : 0);
    return Math.max(0, yy[IM] - burnoutMass);
  };

  if (status === 'apoapsis-reached' && stageIndex < stages.length) {
    const stage = stages[stageIndex];
    ctx.stageIndex = stageIndex;

    const elMeco = rvToElements([y[IX], y[IY], y[IZ]], [y[IVX], y[IVY], y[IVZ]]);
    const ra = elMeco.ra;
    const vApo = Math.sqrt(MU_EARTH * (2 / ra - 1 / elMeco.a));
    const dvNeeded = Math.sqrt(MU_EARTH / ra) - vApo;

    const propAvail = propellantAt(y, stageIndex);
    const dvAvailable =
      propAvail > 0 ? stage.ispVacuum * G0 * Math.log(y[IM] / (y[IM] - propAvail)) : 0;

    // Centre the burn on apoapsis, as real missions do, so half the burn
    // happens before the apsis and half after.
    const massFlow = stage.thrustVacuum / (stage.ispVacuum * G0);
    const propNeeded = y[IM] * (1 - Math.exp(-dvNeeded / (stage.ispVacuum * G0)));
    const burnDuration = propNeeded / massFlow;

    // Coast: thrust off, integrate to (time of apoapsis - burnDuration/2).
    const coastDerivative = (tt, yy) => {
      const rr = [yy[IX], yy[IY], yy[IZ]];
      const vv = [yy[IVX], yy[IVY], yy[IVZ]];
      const alt = geodeticAltitude(rr);
      const atm = atmosphere(Math.max(alt, 0), { f107 });
      const vRel = relativeVelocity(rr, vv);
      const vRelMag = V.norm(vRel);
      let dragAccel = [0, 0, 0];
      if (atm.density > 0 && vRelMag > 0) {
        const cd = 2.2;
        const force = 0.5 * atm.density * vRelMag * vRelMag * cd * referenceArea;
        dragAccel = V.scale(vRel, -force / (yy[IM] * vRelMag));
      }
      const gAccel = earthGravity(rr, { harmonics: 2 });
      const a = V.add(dragAccel, gAccel);
      const speed = V.norm(vv);
      const vHat = speed > 1e-6 ? V.scale(vv, 1 / speed) : [0, 0, 0];
      return [
        vv[0], vv[1], vv[2], a[0], a[1], a[2], 0,
        0,
        -V.dot(gAccel, vHat),
        -V.dot(dragAccel, vHat),
        0,
        0,
      ];
    };

    // Time from MECO to apoapsis, from Kepler rather than from a rate
    // approximation: the coast can be several minutes and the radial rate
    // changes a lot over it.
    const meanAnomaly = trueToMean(elMeco.nu, elMeco.e);
    const meanMotionMeco = (2 * Math.PI) / elMeco.period;
    const timeToApoapsis = Math.max(0, (Math.PI - meanAnomaly) / meanMotionMeco);
    const coastDuration = Math.max(0, timeToApoapsis - burnDuration / 2);

    const coastRes = propagate({
      f: coastDerivative,
      t0: t,
      y0: y,
      tEnd: t + coastDuration,
      h0: 1,
      hMax: 10,
      rtol: 1e-10,
      atol: 1e-4,
      events: [groundEvent],
      eventTol: 1e-2,
      onStep: (tt, yy) => record(tt, yy, stageIndex, false),
    });

    const coastStart = t;
    t = coastRes.t;
    y = coastRes.y;
    const coastReason = coastRes.events[coastRes.events.length - 1]?.name;
    events.push({ t, name: 'coast-to-apoapsis', altitude: geodeticAltitude([y[IX], y[IY], y[IZ]]), stageIndex });

    if (coastReason === 'ground-impact') {
      status = 'crashed-during-coast';
    } else {
      // Circularisation burn: thrust prograde until the periapsis reaches the
      // target radius, or the tanks run dry.
      // Velocity-to-be-gained steering.
      //
      // The target is the full circular velocity VECTOR at the current radius:
      // circular speed, directed horizontally in the current orbital plane.
      // Thrust is aimed along the difference between that and the actual
      // velocity, so the burn simultaneously builds horizontal speed and nulls
      // the residual radial rate. Thrusting merely prograde and cutting off at
      // circular SPEED leaves an ellipse whenever the vehicle is still
      // climbing -- speed alone does not make an orbit circular, the direction
      // has to be right too. This is the same idea as the cross-product
      // steering used for real terminal guidance.
      const velocityToGo = (rr, vv) => {
        const h = V.cross(rr, vv);
        const horiz = V.unit(V.cross(h, rr));
        const vCirc = Math.sqrt(MU_EARTH / V.norm(rr));
        return V.sub(V.scale(horiz, vCirc), vv);
      };

      const burnDerivative = (tt, yy) => {
        const rr = [yy[IX], yy[IY], yy[IZ]];
        const vv = [yy[IVX], yy[IVY], yy[IVZ]];
        const m = yy[IM];
        const vGo = velocityToGo(rr, vv);
        const dir = V.norm(vGo) > 1e-6 ? V.unit(vGo) : V.unit(vv);
        // Same axial acceleration limit as the ascent -- a nearly empty upper
        // stage would otherwise pull well past its structural limit.
        let throttleB = 1;
        if (stage.thrustVacuum / m > guidance.maxAxialAccel) {
          throttleB = Math.max(
            stage.minThrottle ?? 1,
            (guidance.maxAxialAccel * m) / stage.thrustVacuum,
          );
        }
        const thrust = stage.thrustVacuum * throttleB;
        const massFlowB = thrust / (stage.ispVacuum * G0);
        const gAccel = earthGravity(rr, { harmonics: 2 });
        const a = V.add(V.scale(dir, thrust / m), gAccel);
        const speed = V.norm(vv);
        const vHat = speed > 1e-6 ? V.scale(vv, 1 / speed) : [0, 0, 0];
        // The circularisation burn steers on velocity-to-be-gained, so its
        // thrust is deliberately NOT aligned with the velocity vector -- that
        // misalignment is exactly what nulls the radial rate. It therefore
        // incurs a real cosine loss, and recording it as zero silently broke
        // the delta-v identity by up to 200 m/s on long low-thrust burns.
        const cosAlphaB = speed > 1e-6 ? Math.max(-1, Math.min(1, V.dot(dir, vHat))) : 1;
        return [
          vv[0], vv[1], vv[2], a[0], a[1], a[2], -massFlowB,
          thrust / m,
          -V.dot(gAccel, vHat),
          0,
          (thrust / m) * (1 - cosAlphaB),
          0,
        ];
      };

      const burnoutMass =
        stage.dryMass + upperMassAbove(stageIndex) + (fairingAttached ? fairingMass : 0) +
        (boosterAttached && stage.boosters
          ? stage.boosters.dryMass + Math.max(0, y[I_BOOST_PROP]) : 0);

      const burnRes = propagate({
        f: burnDerivative,
        t0: t,
        y0: y,
        tEnd: t + burnDuration * 4 + 60,
        h0: 0.1,
        hMax: 1,
        rtol: 1e-10,
        atol: 1e-5,
        events: [
          // Without this the burn can integrate straight through the surface
          // and report altitudes hundreds of kilometres underground.
          groundEvent,
          { name: 'tanks-dry', g: (tt, yy) => yy[IM] - burnoutMass, terminal: true, direction: -1 },
          {
            name: 'circularised',
            // Cut off once the velocity-to-be-gained is essentially spent.
            // Note this is deliberately NOT "perigee reaches target radius":
            // perigee can never rise above the vehicle's current radius, so if
            // the coast apoapsis ends up even a few km low (drag during the
            // coast will do that), that condition is unreachable and the stage
            // burns itself into an escape trajectory.
            g: (tt, yy) =>
              V.norm(velocityToGo([yy[IX], yy[IY], yy[IZ]], [yy[IVX], yy[IVY], yy[IVZ]])) - 1.0,
            terminal: true,
            direction: -1,
          },
        ],
        eventTol: 1e-3,
        onStep: (tt, yy) => record(tt, yy, stageIndex, true),
      });

      t = burnRes.t;
      y = burnRes.y;
      const burnReason = burnRes.events[burnRes.events.length - 1]?.name ?? burnRes.status;
      events.push({ t, name: `circularisation-${burnReason}`, altitude: geodeticAltitude([y[IX], y[IY], y[IZ]]), stageIndex });
      status = burnReason === 'circularised' ? 'orbit' : 'circularisation-short';

      circularisation = {
        deltaVNeeded: dvNeeded,
        deltaVAvailable: dvAvailable,
        burnDuration: t - coastRes.t,
        apoapsisAltitude: ra - R_EARTH_EQ,
        coastTime: coastRes.t - coastStart,
        predictedBurnDuration: burnDuration,
        sufficient: burnReason === 'circularised',
      };
    }
  }

  // --- orbit raise: park low, then Hohmann up -------------------------------
  //
  // A low-thrust upper stage often cannot insert directly into a high orbit --
  // Vulcan's Centaur sits at a thrust-to-weight near 0.29 and simply cannot
  // hold 400 km while it spends 19 minutes of propellant. What such vehicles
  // actually fly is a two-burn profile: circularise into whatever low parking
  // orbit is reachable, coast, then Hohmann-transfer up to the target.
  //
  // The transfer is priced impulsively via the rocket equation rather than
  // integrated. That is a fair approximation here and not elsewhere: both burns
  // are short compared with the orbital period, and unlike the ascent there is
  // no atmosphere and no altitude to lose while thrusting. The finite-burn
  // penalty it omits is a few m/s, against transfer costs of hundreds.
  let orbitRaise = null;
  {
    const elParked = rvToElements([y[IX], y[IY], y[IZ]], [y[IVX], y[IVY], y[IVZ]]);
    const parkedAlt = (elParked.ra + elParked.rp) / 2 - R_EARTH_EQ;
    const needsRaise =
      status === 'orbit' &&
      elParked.e < 0.05 &&
      parkedAlt > 100e3 &&
      parkedAlt < targetAltitude * 0.95;

    if (needsRaise && stageIndex < stages.length) {
      const st = stages[stageIndex];
      const r1 = R_EARTH_EQ + parkedAlt;
      const r2 = targetRadius;
      const aT = (r1 + r2) / 2;

      const dv1 = Math.sqrt(MU_EARTH * (2 / r1 - 1 / aT)) - Math.sqrt(MU_EARTH / r1);
      const dv2 = Math.sqrt(MU_EARTH / r2) - Math.sqrt(MU_EARTH * (2 / r2 - 1 / aT));
      const dvTotal = dv1 + dv2;

      const propAvail = propellantAt(y, stageIndex);
      const mNow = y[IM];
      const dvAvail = propAvail > 0
        ? st.ispVacuum * G0 * Math.log(mNow / (mNow - propAvail))
        : 0;
      const propNeeded = mNow * (1 - Math.exp(-dvTotal / (st.ispVacuum * G0)));

      orbitRaise = {
        fromAltitude: parkedAlt,
        toAltitude: targetAltitude,
        deltaV1: dv1,
        deltaV2: dv2,
        deltaVTotal: dvTotal,
        deltaVAvailable: dvAvail,
        propellantNeeded: propNeeded,
        transferTime: Math.PI * Math.sqrt(aT ** 3 / MU_EARTH),
        sufficient: dvAvail >= dvTotal,
        impulsive: true,
      };

      if (orbitRaise.sufficient) {
        // Apply the transfer: circular at r2, in the same plane.
        const h = V.cross([y[IX], y[IY], y[IZ]], [y[IVX], y[IVY], y[IVZ]]);
        const nHat = V.unit(h);
        const rHat = V.unit([y[IX], y[IY], y[IZ]]);
        const newR = V.scale(rHat, r2);
        const newV = V.scale(V.unit(V.cross(nHat, rHat)), Math.sqrt(MU_EARTH / r2));

        const speedBefore = V.norm([y[IVX], y[IVY], y[IVZ]]);
        const speedAfter = Math.sqrt(MU_EARTH / r2);

        y = [...y];
        y[IX] = newR[0]; y[IY] = newR[1]; y[IZ] = newR[2];
        y[IVX] = newV[0]; y[IVY] = newV[1]; y[IVZ] = newV[2];
        y[IM] = mNow - propNeeded;

        // Keep the delta-v books balanced across the impulsive transfer.
        //
        // The identity the whole loss decomposition rests on is
        //   |v| = |v0| + ideal - gravity - drag - steering,
        // and teleporting the state to a new orbit would silently break it.
        // The propellant spent is real impulse, so it goes into `ideal`; the
        // part that did not show up as speed went into potential energy, and
        // climbing against gravity is exactly what the gravity-loss term
        // means. A raise makes the vehicle SLOWER while costing delta-v, so
        // this term is large and positive -- as it should be.
        y[I_DV_IDEAL] += dvTotal;
        y[I_DV_GRAV] += dvTotal - (speedAfter - speedBefore);

        t += orbitRaise.transferTime;

        events.push({ t, name: 'orbit-raise', altitude: targetAltitude, stageIndex });
      } else {
        events.push({ t, name: 'orbit-raise-short', altitude: parkedAlt, stageIndex });
      }
    }
  }

  record(t, y, Math.min(stageIndex, stages.length - 1), false);

  // --- outcome --------------------------------------------------------------
  const rFinal = [y[IX], y[IY], y[IZ]];
  const vFinal = [y[IVX], y[IVY], y[IVZ]];
  const elements = rvToElements(rFinal, vFinal);
  const propellantRemaining = propellantAt(y, stageIndex);

  // An orbit is achieved when the perigee clears the atmosphere. 100 km is the
  // conventional line; below ~120 km drag will bring it down within days, so
  // anything marginal is reported rather than rounded up to success.
  // A stable orbit is necessary but not sufficient: delivering a payload to
  // 9500 km when 400 km was requested is a failed mission, not a successful
  // one, and reporting otherwise would let a badly lofted trajectory pass as a
  // win. Both the stability and the target have to be met.
  const stableOrbit =
    status === 'orbit' && elements.e < 1 && elements.rp > R_EARTH_EQ + 100e3;

  const achievedAltitude = (elements.ra + elements.rp) / 2 - R_EARTH_EQ;
  const altitudeError = Math.abs(achievedAltitude - targetAltitude) / targetAltitude;
  const onTarget = altitudeError <= (cfg.altitudeTolerance ?? 0.2);

  const reachedOrbit = stableOrbit && onTarget;

  const finalMass = y[IM];

  return {
    success: reachedOrbit,
    stableOrbit,
    onTarget,
    altitudeError,
    achievedAltitude,
    // Never report a bare 'orbit' for something that is not one. The raw
    // status records which phase ended the run; this is the mission verdict.
    status: stableOrbit
      ? (onTarget ? 'orbit' : 'wrong-altitude')
      : (status === 'orbit' ? 'unstable-orbit' : status),
    samples,
    events,
    elements,
    circularisation,
    orbitRaise,
    reachableInclination,
    azimuthInCorridor,
    azimuthDeg,
    recoveryMode,
    recoveryReserveKg: vehicle.stages[0].propellantMass * reserveFraction,
    liftoffTW,
    guidance,
    payloadMass,
    summary: {
      flightTime: t,
      maxDynamicPressure: maxQ,
      maxQAltitude: maxQAlt,
      maxQTime,
      maxAxialAccel: maxAccel,
      maxAxialG: maxAccel / G0,
      maxMach,
      maxHeatFlux,
      maxAngleOfAttack: maxAoA,
      maxQAlpha,
      // 10% margin over the configured limit, to allow for the discrete
      // sampling cadence rather than to relax the constraint itself.
      structurallyFlyable: maxQAlpha < guidance.qAlphaLimit * 1.1,
      finalAltitude: geodeticAltitude(rFinal),
      finalSpeed: V.norm(vFinal),
      apoapsisAltitude: elements.ra === Infinity ? Infinity : elements.ra - R_EARTH_EQ,
      perigeeAltitude: elements.rp - R_EARTH_EQ,
      inclinationDeg: elements.i / DEG,
      eccentricity: elements.e,
      deltaV: {
        ideal: y[I_DV_IDEAL],
        gravityLoss: y[I_DV_GRAV],
        dragLoss: y[I_DV_DRAG],
        steeringLoss: y[I_DV_STEER],
        // The identity that must hold: achieved = ideal - losses + initial.
        achieved: V.norm(vFinal),
        rotationBonus: V.norm(v0),
      },
      massToOrbit: reachedOrbit ? payloadMass : 0,
      finalMass,
      propellantRemaining,
    },
  };
}

/**
 * Search for the maximum payload a vehicle can deliver to a target orbit.
 *
 * Bisection on payload mass, re-flying the ascent at each trial. Slow but
 * honest: it uses the same integrated trajectory as a single run rather than
 * a rocket-equation shortcut, so gravity and drag losses scale correctly with
 * the vehicle's changing thrust-to-weight.
 *
 * @returns {{payload:number, iterations:number, result:object}}
 */
export function findMaxPayload(cfg, opts = {}) {
  const { tolerance = 50, maxIterations = 22 } = opts;

  let lo = 0;
  let hi = cfg.vehicle.payloadLeoExpendable * 1.6 + 1000;
  let best = null;
  let iterations = 0;

  // Confirm the lower bound flies at all; if not, the configuration is
  // hopeless and bisection would report a meaningless zero.
  const zeroPayload = simulateAscent({ ...cfg, payloadMass: 1 });
  if (!zeroPayload.success) {
    return { payload: 0, iterations: 1, result: zeroPayload, feasible: false };
  }
  best = zeroPayload;

  while (hi - lo > tolerance && iterations < maxIterations) {
    const mid = (lo + hi) / 2;
    const res = simulateAscent({ ...cfg, payloadMass: mid });
    iterations++;
    if (res.success) {
      lo = mid;
      best = res;
    } else {
      hi = mid;
    }
  }

  return { payload: lo, iterations, result: best, feasible: true };
}
