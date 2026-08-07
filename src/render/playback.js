/**
 * Phased mission playback in the 3D scene.
 *
 * Drives a real launch vehicle up the trajectory the ascent simulator
 * integrated, assembles the station the design sizer produced, ages it through
 * the projection, and ends it on whichever limit the engine reached.
 *
 * Five phases, and each one is a different camera problem as much as a
 * different simulation phase:
 *
 *   PAD       the vehicle is 70 m tall and the camera is 200 m away
 *   ASCENT    it climbs 700 km, so the camera has to retreat by four orders
 *             of magnitude while staying pointed at a moving target
 *   DEPLOY    flights arrive; the subject is now a 400 m structure
 *   OPERATE   twelve years pass in half a minute
 *   OUTCOME   whatever the engine says happens, happens
 *
 * The scene is in units of 1000 km and the vehicles are tens of metres, so
 * every placement goes through toScene(). The logarithmic depth buffer is what
 * makes a 70 m rocket and a 6371 km planet coexist in one frame.
 */

import * as THREE from 'three';
import { toScene, vecToScene } from './scene.js';
import { buildRocket, updateRocket, disposeRocket } from './rocket.js';
import { buildStation, updateStation, disposeStation } from './station.js';
import { R_EARTH_EQ, MU_EARTH, DEG } from '../sim/constants.js';
import { atmosphere } from '../sim/atmosphere.js';
import { geodeticAltitude } from '../sim/frames.js';
import * as V from '../sim/vec3.js';

export const PHASES = [
  { key: 'pad',     from: 0.00, to: 0.05, label: 'Pad' },
  { key: 'ascent',  from: 0.05, to: 0.36, label: 'Ascent' },
  { key: 'deploy',  from: 0.36, to: 0.54, label: 'Deployment' },
  { key: 'operate', from: 0.54, to: 0.92, label: 'Operations' },
  { key: 'outcome', from: 0.92, to: 1.00, label: 'Outcome' },
];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
const phaseAt = (p) => PHASES.find((x) => p < x.to) ?? PHASES[PHASES.length - 1];
const localP = (p, ph) => clamp((p - ph.from) / (ph.to - ph.from), 0, 1);

export function createPlayback(view) {
  const root = new THREE.Group();
  view.scene.add(root);

  let mission = null;
  let rocket = null;
  let station = null;
  let trail = null;
  let debris = null;
  let orbitRing = null;

  // Camera state, eased rather than snapped so phase changes glide.
  const camTarget = new THREE.Vector3();
  let camDist = toScene(300);
  // The camera has to be teleported, not eased, whenever the subject changes
  // scale by orders of magnitude -- easing from a whole-Earth view down to a
  // 70 m vehicle takes hundreds of frames and shows nothing but black on the
  // way. Snap on load and on every phase boundary, ease within a phase.
  let needsSnap = true;
  let lastPhase = null;

  function clear() {
    if (rocket) { root.remove(rocket.group); disposeRocket(rocket); rocket = null; }
    if (station) { root.remove(station.group); disposeStation(station); station = null; }
    for (const o of [trail, debris, orbitRing]) {
      if (o) { root.remove(o); o.geometry?.dispose?.(); o.material?.dispose?.(); }
    }
    trail = debris = orbitRing = null;
  }

  /** Load a simulateMission() result and build everything it implies. */
  function load(m) {
    clear();
    mission = m;
    needsSnap = true;
    lastPhase = null;
    if (!m?.deployment?.reference) return;

    rocket = buildRocket(m.deployment.vehicle);
    rocket.group.scale.setScalar(toScene(1));
    root.add(rocket.group);

    station = buildStation(m.design, m.deployment.flightsNeeded);
    station.group.scale.setScalar(toScene(1));
    station.group.visible = false;
    root.add(station.group);

    // Ascent trail, filled in progressively.
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array(m.deployment.reference.samples.length * 3), 3));
    geo.setDrawRange(0, 0);
    trail = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: 0xe08a4c, transparent: true, opacity: 0.9,
    }));
    root.add(trail);

    // Target orbit ring.
    const rOrb = R_EARTH_EQ + m.design.inputs.altitude;
    const pts = [];
    const inc = m.design.inputs.inclination * DEG;
    for (let i = 0; i <= 256; i++) {
      const a = (i / 256) * Math.PI * 2;
      const p = [rOrb * Math.cos(a), rOrb * Math.sin(a) * Math.cos(inc), rOrb * Math.sin(a) * Math.sin(inc)];
      pts.push(vecToScene(p));
    }
    orbitRing = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0x5fa6c6, transparent: true, opacity: 0.35 }));
    orbitRing.visible = false;
    root.add(orbitRing);

    // Debris cloud, only used if the engine ends this mission by reentry.
    const dGeo = new THREE.BufferGeometry();
    const N = 220;
    dGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    // Point size is in WORLD units with the default size attenuation, and the
    // world unit here is 1000 km. A size of 0.02 is a twenty-kilometre dot,
    // which fills the frame with solid white -- the fragments want to be a few
    // metres across, so the size has to be expressed through toScene() like
    // every other length.
    debris = new THREE.Points(dGeo, new THREE.PointsMaterial({
      color: 0xffb070, size: toScene(9), transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    debris.userData.vel = Array.from({ length: N }, () => new THREE.Vector3(
      (Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5))
      .multiplyScalar(toScene(260 + Math.random() * 700)));
    debris.visible = false;
    root.add(debris);
  }

  // ---- interpolation over the simulation outputs --------------------------
  function ascentAt(t) {
    const s = mission.deployment.reference.samples;
    if (t <= s[0].t) return s[0];
    if (t >= s[s.length - 1].t) return s[s.length - 1];
    let lo = 0, hi = s.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m].t < t) lo = m; else hi = m; }
    const f = (t - s[lo].t) / (s[hi].t - s[lo].t || 1);
    return {
      t,
      r: s[lo].r.map((v, i) => lerp(v, s[hi].r[i], f)),
      v: s[lo].v.map((v, i) => lerp(v, s[hi].v[i], f)),
      altitude: lerp(s[lo].altitude, s[hi].altitude, f),
      speed: lerp(s[lo].speed, s[hi].speed, f),
      mass: lerp(s[lo].mass, s[hi].mass, f),
      dynamicPressure: lerp(s[lo].dynamicPressure, s[hi].dynamicPressure, f),
      burning: s[lo].burning,
      stageIndex: s[lo].stageIndex,
      index: lo,
    };
  }

  function projAt(years) {
    const rows = mission.projection.rows;
    if (years <= rows[0].years) return rows[0];
    if (years >= rows[rows.length - 1].years) return rows[rows.length - 1];
    let lo = 0, hi = rows.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (rows[m].years < years) lo = m; else hi = m; }
    const f = (years - rows[lo].years) / (rows[hi].years - rows[lo].years || 1);
    const L = rows[lo], Hh = rows[hi];
    return {
      years,
      capability: lerp(L.capability, Hh.capability, f),
      arrayFactor: lerp(L.arrayFactor, Hh.arrayFactor, f),
      batteryFactor: lerp(L.batteryFactor, Hh.batteryFactor, f),
      thermalFactor: lerp(L.thermalFactor, Hh.thermalFactor, f),
      doseFactor: lerp(L.doseFactor, Hh.doseFactor, f),
      effective: lerp(L.effective, Hh.effective, f),
      petaflops: lerp(L.petaflops, Hh.petaflops, f),
      cumulativePflopYears: lerp(L.cumulativePflopYears, Hh.cumulativePflopYears, f),
      altitudeKm: lerp(L.altitudeKm, Hh.altitudeKm, f),
      propellantFraction: lerp(L.propellantFraction, Hh.propellantFraction, f),
    };
  }

  /** Position on the design orbit at a given number of revolutions. */
  function orbitPosition(altKm, revs) {
    const r = R_EARTH_EQ + altKm * 1000;
    const inc = mission.design.inputs.inclination * DEG;
    const a = revs * Math.PI * 2;
    return [r * Math.cos(a), r * Math.sin(a) * Math.cos(inc), r * Math.sin(a) * Math.sin(inc)];
  }

  /**
   * Aim the camera at a point without stealing the user's orbit angle.
   * The direction from target to camera is preserved; only the distance and
   * the look-at point are driven, so dragging still works mid-playback.
   */
  /**
   * Aim the camera at a point.
   *
   * On a snap the viewpoint is CHOSEN rather than inherited. Reusing whatever
   * angle the user last dragged to produces arbitrary framing -- a rocket seen
   * end-on down its own exhaust, a station edge-on to its own arrays. `preferred`
   * is a unit direction in scene space saying where the camera should sit
   * relative to the subject; within a phase the user can drag freely from there.
   */
  function frame(targetEci, distMetres, dt, preferred) {
    const snap = needsSnap;
    needsSnap = false;

    camTarget.copy(vecToScene(targetEci));
    const wanted = toScene(distMetres);
    // Geometric ease: distance has to cover four orders of magnitude during an
    // ascent, and a linear ease either crawls at the small end or overshoots.
    camDist = snap ? wanted : camDist * Math.pow(wanted / camDist, 1 - Math.pow(0.06, dt));

    let dir;
    if (snap && preferred) {
      dir = preferred.clone().normalize();
    } else {
      dir = view.camera.position.clone().sub(view.controls.target);
      if (dir.lengthSq() < 1e-30) dir.copy(preferred ?? new THREE.Vector3(0.6, 0.35, 1));
      dir.normalize();
    }

    const k = snap ? 1 : 1 - Math.pow(0.0008, dt);
    view.controls.target.lerp(camTarget, k);
    view.camera.position.lerp(camTarget.clone().add(dir.multiplyScalar(camDist)), k);
    view.controls.minDistance = toScene(1);
    view.controls.maxDistance = 900;
  }

  // ---- per-frame ----------------------------------------------------------
  /**
   * @param {number} p progress 0..1
   * @param {number} dt seconds since last frame
   * @returns telemetry for the HUD
   */
  function update(p, dt) {
    if (!mission || !rocket) return null;
    const ph = phaseAt(p);
    const lp = localP(p, ph);
    if (ph.key !== lastPhase) { needsSnap = true; lastPhase = ph.key; }
    const out = { phase: ph.label, key: ph.key, event: '' };

    const asc = mission.deployment.reference;
    const flightTime = asc.summary.flightTime;

    if (ph.key === 'pad' || ph.key === 'ascent') {
      // ------------------------------------------------------------ ASCENT
      const t = ph.key === 'pad' ? 0 : smooth(lp) * flightTime;
      const s = ascentAt(t);

      const pos = vecToScene(s.r);
      rocket.group.position.copy(pos);

      // Point the vehicle along the thrust axis: radial while it is still
      // vertical, along the velocity vector once it is actually flying.
      const up = new THREE.Vector3(...vecToScene(s.r).toArray()).normalize();
      const vel = vecToScene(s.v).normalize();
      const axis = s.speed > 900 ? vel : up;
      rocket.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);

      const atm = atmosphere(Math.max(s.altitude, 0));
      const boosterSepT = asc.events.find((e) => e.name === 'booster-separation')?.t ?? Infinity;
      const fairingT = asc.events.find((e) => e.name === 'fairing-jettison')?.t ?? Infinity;

      updateRocket(rocket, {
        stageIndex: s.stageIndex,
        burning: s.burning && ph.key === 'ascent',
        ambientPressure: atm.pressure ?? 0,
        boostersAttached: t < boosterSepT,
        fairingAttached: t < fairingT,
      });
      rocket.group.visible = true;
      if (station) station.group.visible = false;
      if (orbitRing) orbitRing.visible = t > flightTime * 0.5;

      // grow the trail
      const arr = trail.geometry.attributes.position.array;
      let n = 0;
      for (const smp of asc.samples) {
        if (smp.t > t) break;
        const q = vecToScene(smp.r);
        arr[n * 3] = q.x; arr[n * 3 + 1] = q.y; arr[n * 3 + 2] = q.z;
        n++;
      }
      trail.geometry.setDrawRange(0, n);
      trail.geometry.attributes.position.needsUpdate = true;
      trail.visible = n > 1;

      // Camera retreats as the vehicle grows distant from the pad: close
      // enough to read the engines at liftoff, wide enough to hold the arc
      // by insertion.
      // Stay close enough on the pad to read the engine bells, then retreat.
      // The exponent matters more than the endpoints: a square root pulls the
      // camera a kilometre away while the vehicle is still on the tower.
      // Watch the vehicle broadside: perpendicular to both the local vertical
      // and the flight direction, lifted slightly so the plume is visible.
      const sideways = new THREE.Vector3().crossVectors(up, vel);
      if (sideways.lengthSq() < 1e-12) sideways.set(1, 0, 0);
      const view0 = sideways.normalize().multiplyScalar(0.92).add(up.clone().multiplyScalar(0.28));

      const d = lerp(140, 80000, Math.pow(clamp(s.altitude / 500e3, 0, 1), 1.1));
      frame(s.r, d, dt, view0);

      const mm = String(Math.floor(t / 60)).padStart(2, '0');
      const ss = String(Math.floor(t % 60)).padStart(2, '0');
      out.clock = ph.key === 'pad' ? 'T−00:05' : `T+${mm}:${ss}`;
      out.lines = [
        ['ALT', `${(s.altitude / 1000).toFixed(1)} km`],
        ['VEL', `${Math.round(s.speed).toLocaleString()} m/s`],
        ['MASS', `${(s.mass / 1000).toFixed(0)} t`],
        ['Q', `${(s.dynamicPressure / 1000).toFixed(1)} kPa`],
      ];
      const near = asc.events.find((e) => t >= e.t - 0.5 && t <= e.t + 18);
      if (near) out.event = near.name.replace(/-/g, ' ').toUpperCase();
      if (ph.key === 'pad') { out.event = 'IGNITION'; out.phase = 'Pre-launch'; }

    } else {
      // -------------------------------------------- DEPLOY / OPERATE / END
      const deployYears = mission.deployment.deploymentYears;
      const endYears = mission.projection.endYears;
      let years;
      if (ph.key === 'deploy') years = smooth(lp) * deployYears;
      else if (ph.key === 'operate') years = lerp(deployYears, endYears, smooth(lp));
      else years = endYears;

      const pr = projAt(years);
      const failing = ph.key === 'outcome' && mission.projection.endReason !== 'planned end of mission';
      const reentering = failing && /decay|propellant/i.test(mission.projection.endReason);

      rocket.group.visible = false;
      trail.visible = false;
      if (orbitRing) orbitRing.visible = true;
      station.group.visible = true;

      // Fall out of orbit if that is how the engine ended this mission.
      const altKm = reentering ? lerp(pr.altitudeKm, 95, smooth(lp)) : pr.altitudeKm;
      const revs = years * (365.25 * 86400) / mission.design.orbit.period;
      const eci = orbitPosition(altKm, revs);

      station.group.position.copy(vecToScene(eci));

      // Truss along-track, arrays face the Sun.
      const rHat = new THREE.Vector3(...vecToScene(eci).toArray()).normalize();
      const hHat = new THREE.Vector3(0, 1, 0).cross(rHat).normalize();
      const alongTrack = new THREE.Vector3().crossVectors(rHat, hHat).normalize();
      const basis = new THREE.Matrix4().makeBasis(alongTrack, rHat, hHat);
      station.group.quaternion.setFromRotationMatrix(basis);

      updateStation(station, {
        assembly: pr.capability,
        thermal: pr.thermalFactor,
        array: pr.arrayFactor,
        dose: pr.doseFactor,
      });

      // Break-up: scatter the debris cloud from the station's position.
      if (reentering && lp > 0.45) {
        debris.visible = true;
        const f = (lp - 0.45) / 0.55;
        const pa = debris.geometry.attributes.position.array;
        for (let i = 0; i < pa.length / 3; i++) {
          const v = debris.userData.vel[i];
          pa[i * 3] = station.group.position.x + v.x * f;
          pa[i * 3 + 1] = station.group.position.y + v.y * f;
          pa[i * 3 + 2] = station.group.position.z + v.z * f;
        }
        debris.geometry.attributes.position.needsUpdate = true;
        // Fragments brighten as they hit the atmosphere, then burn out.
        debris.material.opacity = Math.min(1, f * 3) * (1 - Math.pow(f, 2.2) * 0.8);
        debris.material.size = toScene(9) * (1 + f * 2.2);
        debris.material.color.setRGB(1, 0.72 - 0.28 * f, 0.42 - 0.34 * f);
        station.group.visible = f < 0.5;
      } else if (debris) {
        debris.visible = false;
      }

      // Close on the structure during deployment, back off for operations so
      // the orbit reads, then close again on whatever is killing it.
      const span = station.span;
      // Three-quarter view weighted toward the RADIAL direction. The array
      // normals point radially (they face the Sun) and the radiator normals lie
      // along the orbit normal, so a camera placed on the orbit normal sees the
      // arrays perfectly edge-on -- the largest structure on the vehicle
      // reduced to a line. Favouring radial shows the arrays as surfaces and
      // still catches the radiators at an angle.
      const view0 = rHat.clone().multiplyScalar(0.82)
        .add(hHat.clone().multiplyScalar(0.42))
        .add(alongTrack.clone().multiplyScalar(0.30));

      // Pull back through the break-up so the debris field stays in frame.
      const d = ph.key === 'deploy' ? span * 1.5
        : ph.key === 'operate' ? lerp(span * 1.6, span * 2.6, lp)
        : reentering ? lerp(span * 1.8, span * 8, smooth(lp))
        : span * 1.5;
      frame(eci, d, dt, view0);

      out.clock = `Y+${years.toFixed(1)}`;
      out.lines = [
        ['ONLINE', `${Math.round(pr.capability * 100)}%`],
        ['NET', `${Math.round(pr.effective * 100)}%`],
        ['THERMAL', `${Math.round(pr.thermalFactor * 100)}%`],
        ['ALT', `${altKm.toFixed(0)} km`],
      ];
      out.telemetry = pr;
      if (ph.key === 'deploy') {
        out.event = `FLIGHT ${Math.max(1, Math.ceil(pr.capability * mission.deployment.flightsNeeded))} OF ${mission.deployment.flightsNeeded}`;
      } else if (ph.key === 'outcome') {
        out.event = mission.projection.endReason.toUpperCase();
      }
    }

    return out;
  }

  return { load, update, clear, root, get mission() { return mission; } };
}
