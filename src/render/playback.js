/**
 * Phased mission playback in the 3D scene.
 *
 * TWO SHOTS AT ONCE, which is how a launch is actually broadcast.
 *
 *   The MAIN view holds the globe. It never chases the vehicle. Held wide, you
 *   see the rocket leave the pad, arc downrange, drop its booster, watch that
 *   booster fall back and land while the upper stage carries on to orbit --
 *   all in one frame, and all at TRUE SCALE.
 *
 *   The TRACKING inset rides a few hundred metres from whatever matters right
 *   now: the stack on ascent, the booster on the way home, the station under
 *   assembly. This is what makes the wide shot affordable. Earlier versions
 *   drew the hardware 7000x oversized so it would be visible from planetary
 *   range, which made a 70 m rocket 460 km tall standing next to the planet --
 *   the single most artificial thing in the scene. With a close camera already
 *   showing the vehicle, the wide shot no longer has to lie: the geometry is
 *   at true scale and the vehicle is represented there by a screen-space
 *   beacon and its contrail, which is exactly what you see of a real launch
 *   from any distance.
 *
 * Seven phases:
 *
 *   PAD        globe framed on the launch site, engines lit
 *   ASCENT     vehicle climbs, contrail draws behind it
 *   SEPARATION booster falls away and flies its own return trajectory
 *   RECOVERY   boostback, entry burn, landing burn, touchdown -- or not
 *   ASSEMBLY   flights arrive, the datacenter grid builds out module by module
 *   OPERATIONS years of degradation
 *   OUTCOME    whatever the engine decided ends the mission
 */

import * as THREE from 'three';
import { toScene, vecToScene } from './scene.js';
import { buildRocket, updateRocket, disposeRocket } from './rocket.js';
import { buildStation, updateStation, disposeStation } from './station.js';
import { R_EARTH_EQ, OMEGA_EARTH } from '../sim/constants.js';
import { atmosphere } from '../sim/atmosphere.js';
import { gmst, dateToJulian, sunPositionEci } from '../sim/frames.js';

export const PHASES = [
  { key: 'pad',        from: 0.00, to: 0.04, label: 'Pad' },
  { key: 'ascent',     from: 0.04, to: 0.28, label: 'Ascent' },
  { key: 'separation', from: 0.28, to: 0.44, label: 'Separation' },
  { key: 'recovery',   from: 0.44, to: 0.56, label: 'Booster recovery' },
  { key: 'assembly',   from: 0.56, to: 0.72, label: 'Assembly' },
  { key: 'operations', from: 0.72, to: 0.93, label: 'Operations' },
  { key: 'outcome',    from: 0.93, to: 1.00, label: 'Outcome' },
];

/**
 * Piecewise-linear time map: [[phaseFraction, missionSeconds], ...] ascending.
 *
 * The upper stage flies for twenty minutes and almost all of it is a silent
 * coast. Mapped linearly, staging and fairing jettison -- the two events worth
 * watching -- land inside a single frame while seventy percent of the phase is
 * spent on a vehicle doing nothing. This lets a phase dwell on the events and
 * fast-forward the coast, the way any launch replay is cut.
 */
function mapTime(lp, knots) {
  for (let i = 1; i < knots.length; i++) {
    if (lp <= knots[i][0]) {
      const [p0, t0] = knots[i - 1];
      const [p1, t1] = knots[i];
      return t0 + (t1 - t0) * ((lp - p0) / (p1 - p0 || 1));
    }
  }
  return knots[knots.length - 1][1];
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
const phaseAt = (p) => PHASES.find((x) => p < x.to) ?? PHASES[PHASES.length - 1];
const localP = (p, ph) => clamp((p - ph.from) / (ph.to - ph.from), 0, 1);

/**
 * How much faster than real time the orbital phases run.
 *
 * The mission spans a decade. Advancing the globe and the orbit by the true
 * elapsed time would step them thousands of revolutions per frame -- the
 * planet strobes, the station teleports around its orbit, and the whole thing
 * aliases into noise. So the orbital motion runs on its own compressed clock
 * at a rate you can actually watch, while the YEAR counter and every number in
 * the HUD stay on true mission time. The ratio is reported in the HUD rather
 * than hidden.
 */
const ORBITS_PER_PHASE = { assembly: 1.6, operations: 2.2, outcome: 0.9 };

/** Soft radial dot, for beacons, contrails and plume glows. */
function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.85)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createPlayback(view) {
  const root = new THREE.Group();
  view.scene.add(root);

  const DOT = dotTexture();

  let mission = null;
  let rocket = null;
  let boosterModel = null;
  let station = null;
  let disposed = [];

  // Trails and markers
  let ascentTrail = null;
  let returnTrail = null;
  let orbitRing = null;
  let debris = null;
  let padSmoke = null;
  let padModel = null;
  let altSpoke = null;
  const beacons = {};

  // Set on a phase change and cleared at the END of update(), so BOTH cameras
  // see it. Having holdGlobe clear it directly meant aimTrack -- which runs
  // afterwards -- never saw a snap at all, and the tracking camera spent every
  // phase easing in from wherever the previous one left it. On the ascent that
  // put it 12 km behind a vehicle it was supposed to be 190 m from.
  let needsSnap = true;
  let lastPhase = null;
  let camDist = toScene(3.0e7);
  let userDist = null;      // distance the user dragged to, honoured until phase change
  let jd0 = null;
  let altRefH = 550e3;   // target altitude: where the wide-shot gain returns to 1

  // Orbital plane of the delivered station, taken from the state the ascent
  // actually injected into rather than assumed. Filled in by load().
  let plane = null;

  // Tracking-camera state: the OFFSET from the subject, in scene units. The
  // camera position itself is never smoothed -- see aimTrack.
  const trackOffset = new THREE.Vector3();
  let trackReady = false;

  // Standoff in subject-lengths. Tighter than it was: a launch broadcast frames
  // the vehicle large in a long lens, it does not sit it in the middle of a
  // wide empty field.
  const TRACK_STANDOFF = 2.25;

  function syncEarth(seconds) {
    if (jd0 == null) return;
    const jd = jd0 + seconds / 86400;
    view.setEarthRotation(gmst(jd));
    view.setSunDirection(sunPositionEci(jd));
  }

  function track(o) { disposed.push(o); return o; }

  function clear() {
    if (rocket) { root.remove(rocket.group); disposeRocket(rocket); rocket = null; }
    if (boosterModel) { root.remove(boosterModel.group); disposeRocket(boosterModel); boosterModel = null; }
    if (station) { root.remove(station.group); disposeStation(station); station = null; }
    for (const o of disposed) {
      root.remove(o);
      o.traverse?.((c) => {
        c.geometry?.dispose?.();
        if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose());
        else c.material?.dispose?.();
      });
    }
    disposed = [];
    ascentTrail = returnTrail = orbitRing = debris = padSmoke = null;
    padModel = null;
    altSpoke = null;
    plane = null;
    trackReady = false;
    for (const k of Object.keys(beacons)) delete beacons[k];
  }

  function dispose() {
    clear();
    view.scene.remove(root);
    DOT.dispose();
  }

  /**
   * A beacon is a single point drawn at a constant pixel size. Without one the
   * vehicles are invisible in the wide shot: at a range that frames the whole
   * planet, a rocket really is about a ten-thousandth of a pixel across. This
   * is the honest way to show it -- a marker that says "it is here", rather
   * than geometry inflated until it is big enough to see.
   */
  function makeBeacon(color, sizePx) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    const m = new THREE.PointsMaterial({
      color, size: sizePx, sizeAttenuation: false, map: DOT,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const p = new THREE.Points(g, m);
    p.frustumCulled = false;
    p.visible = false;
    root.add(track(p));
    return p;
  }


  // ------------------------------------------------------- wide-shot altitude
  /**
   * Altitude gain for the WIDE SHOT only.
   *
   * A whole-globe view cannot show an ascent honestly, and the arithmetic is
   * brutal: the vehicle is 6 km up a minute after liftoff, on a planet 12,756
   * km across. Measured on screen, that put it 0.1 px above the surface while
   * the marker drawn on it was 18 px wide -- the marker covered a hundred and
   * eighty times the height the rocket had gained, so it sat welded to the limb
   * for the entire climb even though the tracking camera clearly showed it
   * leaving. Zooming does not help: altitude over Earth diameter is a ratio, so
   * it stays 3.9% at any camera range.
   *
   * So the wide shot exaggerates altitude, and says so in the HUD. The map is
   *
   *     h' = K.h / (1 + (K-1).h/H)
   *
   * which is monotone, exactly zero at the ground, and exactly TRUE at the
   * target altitude H -- its slope is K near the surface and 1/K at H. That
   * last property is the point: by the time the vehicle reaches orbit the
   * exaggeration has wound itself back to nothing, so the injected vehicle, the
   * orbit ring and the station all sit at the same true radius and nothing
   * downstream has to know this function exists.
   *
   * It is applied ONLY to the wide-shot devices -- beacons, contrails, the
   * altitude spoke. The 3-D geometry stays where the physics put it, which is
   * what the tracking inset is looking at, and every number in the HUD is the
   * true one.
   */
  const ALT_GAIN = 15;

  function liftEci(r, h) {
    if (!(h > 0)) return r;
    const hd = (ALT_GAIN * h) / (1 + ((ALT_GAIN - 1) * h) / altRefH);
    const R = Math.hypot(r[0], r[1], r[2]);
    const k = (R + (hd - h)) / R;
    return [r[0] * k, r[1] * k, r[2] * k];
  }

  /** Drop a position onto the surface directly below it. */
  function dropEci(r, h) {
    const R = Math.hypot(r[0], r[1], r[2]);
    const k = (R - Math.max(h, 0)) / R;
    return [r[0] * k, r[1] * k, r[2] * k];
  }

  function setBeacon(b, vecEci, visible = true, altitude = null) {
    b.visible = visible;
    if (!visible) return;
    const v = vecToScene(altitude == null ? vecEci : liftEci(vecEci, altitude));
    const a = b.geometry.attributes.position;
    a.array[0] = v.x; a.array[1] = v.y; a.array[2] = v.z;
    a.needsUpdate = true;
  }

  /**
   * Contrail: a hairline path with an additive glow strung along it.
   *
   * WebGL ignores `linewidth` on LineBasicMaterial -- it is 1 px on every
   * desktop driver, whatever you set -- so a line on its own can never read as
   * a trail. The glow points carry the visual weight and fade toward the tail,
   * which also encodes age: the bright end is where the vehicle is now.
   */
  function makeTrail(color, maxPoints, glowPx = 5) {
    const g = new THREE.Group();

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(maxPoints * 3), 3));
    lineGeo.setDrawRange(0, 0);
    const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({
      color, transparent: true, opacity: 0.55,
    }));
    line.frustumCulled = false;
    g.add(line);

    const glowGeo = new THREE.BufferGeometry();
    glowGeo.setAttribute('position', lineGeo.attributes.position);
    glowGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(maxPoints * 3), 3));
    glowGeo.setDrawRange(0, 0);
    const glow = new THREE.Points(glowGeo, new THREE.PointsMaterial({
      size: glowPx, sizeAttenuation: false, map: DOT, vertexColors: true,
      transparent: true, opacity: 0.85, depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    glow.frustumCulled = false;
    g.add(glow);

    g.userData = { line, glow, base: new THREE.Color(color), maxPoints };
    root.add(track(g));
    return g;
  }

  function fillTrail(trail, samples, upTo) {
    const { line, glow, base, maxPoints } = trail.userData;
    const pos = line.geometry.attributes.position.array;
    const col = glow.geometry.attributes.color.array;

    let n = 0;
    for (const s of samples) {
      if (s.t > upTo) break;
      const v = vecToScene(liftEci(s.r, s.altitude));
      pos[n * 3] = v.x; pos[n * 3 + 1] = v.y; pos[n * 3 + 2] = v.z;
      n++;
      if (n >= maxPoints) break;
    }
    // Fade the tail. The head keeps full colour so the leading edge reads as
    // the current position even when the beacon is behind the planet.
    for (let i = 0; i < n; i++) {
      const age = n > 1 ? i / (n - 1) : 1;
      const f = 0.12 + 0.88 * Math.pow(age, 2.0);
      col[i * 3] = base.r * f;
      col[i * 3 + 1] = base.g * f;
      col[i * 3 + 2] = base.b * f;
    }

    line.geometry.setDrawRange(0, n);
    line.geometry.attributes.position.needsUpdate = true;
    glow.geometry.setDrawRange(0, n);
    glow.geometry.attributes.color.needsUpdate = true;
    trail.visible = n > 1;
    return n;
  }

  // ------------------------------------------------------------------ load
  function load(m) {
    clear();
    mission = m;
    needsSnap = true;
    userDist = null;
    lastPhase = null;
    if (!m?.deployment?.reference) return;

    altRefH = Math.max(m.design.inputs.altitude, 120e3);
    jd0 = dateToJulian(m.deployment.startDate);
    syncEarth(0);

    const veh = m.deployment.vehicle;

    // METRES -> SCENE UNITS. The models are built in metres and a scene unit
    // is 1000 km, so this factor is not optional: without it a 70 m rocket is
    // drawn 70 scene units tall, which is 70,000 km -- eleven Earth radii of
    // black cylinder straight through the planet. True scale means applying
    // the conversion, not skipping it.
    rocket = buildRocket(veh);
    rocket.group.scale.setScalar(toScene(1));
    root.add(rocket.group);

    // The discarded first stage gets its own model so it can fly home while the
    // upper stage carries on.
    boosterModel = buildRocket(veh, { firstStageOnly: true });
    boosterModel.group.scale.setScalar(toScene(1));
    boosterModel.group.visible = false;
    root.add(boosterModel.group);

    station = buildStation(m.design, m.deployment.flightsNeeded);
    station.group.scale.setScalar(toScene(1));
    station.group.visible = false;
    root.add(station.group);

    const asc = m.deployment.reference;
    ascentTrail = makeTrail(0xffa040, asc.samples.length + 4, 5);
    returnTrail = makeTrail(0x6fc8ff, (m.deployment.recovery?.samples.length ?? 0) + 4, 4);

    // Deliberately small. An 18 px blob on a vehicle 2 px above the limb hides
    // the very thing it is there to show.
    beacons.vehicle = makeBeacon(0xfff0d8, 10);
    beacons.booster = makeBeacon(0x9fe4ff, 8);
    beacons.station = makeBeacon(0x9dffc9, 14);
    beacons.site = makeBeacon(0xff8a6b, 9);
    beacons.subpoint = makeBeacon(0xff8a6b, 5);

    // Altitude spoke: a line from the point on the surface directly beneath the
    // vehicle up to the vehicle. A gap of a few pixels is ambiguous on its own;
    // a line with a marker at each end is not, and it is what makes "it has
    // left the ground" legible at planetary range.
    const spokeGeo = new THREE.BufferGeometry();
    spokeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    altSpoke = new THREE.Line(spokeGeo, new THREE.LineBasicMaterial({
      color: 0xffb066, transparent: true, opacity: 0.65,
    }));
    altSpoke.frustumCulled = false;
    altSpoke.visible = false;
    root.add(track(altSpoke));

    // ---- orbital plane -----------------------------------------------------
    // Taken from the injection state, not from the requested inclination with
    // an assumed zero right ascension. Getting this wrong is very visible: the
    // rocket ascends in one plane and the station then appears orbiting in a
    // completely different one, with no path between them.
    const inj = asc.samples[asc.samples.length - 1];
    const rv = new THREE.Vector3(...inj.r);
    const vv = new THREE.Vector3(...inj.v);
    const hHat = new THREE.Vector3().crossVectors(rv, vv).normalize();
    const e1 = rv.clone().normalize();
    const e2 = new THREE.Vector3().crossVectors(hHat, e1).normalize();
    plane = { e1, e2, hHat };

    // Target orbit, drawn in that same plane.
    const rOrb = R_EARTH_EQ + m.design.inputs.altitude;
    const pts = [];
    for (let i = 0; i <= 256; i++) {
      const a = (i / 256) * Math.PI * 2;
      const p = e1.clone().multiplyScalar(rOrb * Math.cos(a))
        .add(e2.clone().multiplyScalar(rOrb * Math.sin(a)));
      pts.push(vecToScene([p.x, p.y, p.z]));
    }
    orbitRing = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0x5fa6c6, transparent: true, opacity: 0.30 }));
    orbitRing.visible = false;
    root.add(track(orbitRing));

    // ---- pad exhaust cloud -------------------------------------------------
    // Only visible in the tracking inset, where it is the difference between a
    // model lifting off and a launch.
    padSmoke = makeSmoke(rocket.radius);
    root.add(track(padSmoke));

    padModel = makePad(rocket.height, rocket.radius);
    root.add(track(padModel));

    // ---- break-up debris ---------------------------------------------------
    // Used only if the engine ends the mission by reentry. The spread has to be
    // tens of kilometres to register against a planet 12,700 km across; a
    // realistic few-hundred-metre debris field is a single dot at this range.
    const N = 320;
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    debris = new THREE.Points(dg, new THREE.PointsMaterial({
      color: 0xffb070, size: 4.0, sizeAttenuation: false, map: DOT,
      transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    debris.frustumCulled = false;
    debris.userData.vel = Array.from({ length: N }, () => {
      // Along-track spread dominates: a break-up strings out into a corridor,
      // it does not expand as a ball.
      const v = new THREE.Vector3(
        (Math.random() - 0.5) * 6, (Math.random() - 0.5), (Math.random() - 0.5));
      return v.multiplyScalar(toScene(40e3 + Math.random() * 90e3));
    });
    debris.visible = false;
    root.add(track(debris));
  }


  /**
   * Launch complex, modelled in METRES with +Y up and the origin at the deck.
   *
   * A rocket standing alone on a sphere has no sense of scale -- there is
   * nothing next to it to be 70 m tall against. The pad is what makes the
   * vehicle read as enormous: a strongback almost as tall as the first stage,
   * lightning masts taller still, and a deck wide enough that the flame trench
   * is visibly a canyon. It also gives the liftoff somewhere to happen, so the
   * vehicle rises AWAY from something instead of just drifting.
   *
   * Proportions follow a real single-stick pad (SLC-4E): deck about 1.6 vehicle
   * heights across, three masts on a 1.1-height radius.
   */
  function makePad(vehicleHeight, vehicleRadius) {
    const g = new THREE.Group();
    const H = vehicleHeight;
    const R = vehicleRadius;

    const concrete = new THREE.MeshStandardMaterial({
      color: 0x6e7178, roughness: 0.94, metalness: 0.02,
    });
    const dark = new THREE.MeshStandardMaterial({
      color: 0x24272c, roughness: 0.88, metalness: 0.05,
    });
    const steel = new THREE.MeshStandardMaterial({
      color: 0x9aa3ad, roughness: 0.55, metalness: 0.75,
    });

    // Deck, sunk slightly so the vehicle sits on it rather than in it.
    const deck = new THREE.Mesh(new THREE.BoxGeometry(H * 1.6, H * 0.035, H * 1.6), concrete);
    deck.position.y = -H * 0.0175;
    g.add(deck);

    // Flame trench: a slot through the deck, with a deflector wedge under the
    // engines that throws the exhaust sideways.
    const trench = new THREE.Mesh(
      new THREE.BoxGeometry(R * 5.5, H * 0.05, H * 1.62), dark);
    trench.position.y = -H * 0.024;
    g.add(trench);
    const deflector = new THREE.Mesh(
      new THREE.ConeGeometry(R * 2.4, R * 3.2, 4), dark);
    deflector.position.y = -H * 0.035 + R * 1.6;
    deflector.rotation.y = Math.PI / 4;
    g.add(deflector);

    // Strongback / transporter-erector: four legs and cross bracing, standing
    // just clear of the vehicle.
    const sbH = H * 0.62;
    const sbX = R + Math.max(R * 0.9, 2.5);
    const sbW = R * 1.5;
    const legR = Math.max(R * 0.07, 0.35);
    const strongback = new THREE.Group();
    for (const dx of [-1, 1]) {
      for (const dz of [-1, 1]) {
        const leg = new THREE.Mesh(
          new THREE.CylinderGeometry(legR, legR, sbH, 6), steel);
        leg.position.set(dx * sbW * 0.5, sbH / 2, dz * sbW * 0.5);
        strongback.add(leg);
      }
    }
    const bays = Math.max(6, Math.round(sbH / (sbW * 1.1)));
    for (let i = 0; i <= bays; i++) {
      const yy = (i / bays) * sbH;
      for (const [ax, az] of [[1, 0], [0, 1]]) {
        const bar = new THREE.Mesh(
          new THREE.BoxGeometry(ax ? sbW : legR * 1.6, legR * 1.6, az ? sbW : legR * 1.6), steel);
        bar.position.set(ax ? 0 : sbW * 0.5, yy, az ? 0 : sbW * 0.5);
        strongback.add(bar);
        const bar2 = bar.clone();
        bar2.position.set(ax ? 0 : -sbW * 0.5, yy, az ? 0 : -sbW * 0.5);
        strongback.add(bar2);
      }
    }
    // Umbilical arms reaching across to the vehicle.
    for (const frac of [0.28, 0.72]) {
      const arm = new THREE.Mesh(
        new THREE.BoxGeometry(sbX - sbW * 0.5, legR * 2.2, legR * 3.0), steel);
      arm.position.set(-(sbX - sbW * 0.5) / 2 - sbW * 0.25, sbH * frac, 0);
      strongback.add(arm);
    }
    strongback.position.set(sbX + sbW * 0.5, 0, 0);
    g.add(strongback);

    // Lightning masts. Taller than the vehicle by definition -- that is their
    // whole job, to put the strike termination above the stack.
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.6;
      const mh = H * 1.28;
      const mast = new THREE.Mesh(
        new THREE.CylinderGeometry(legR * 0.8, legR * 1.8, mh, 6), steel);
      mast.position.set(Math.cos(a) * H * 0.55, mh / 2, Math.sin(a) * H * 0.55);
      g.add(mast);
      const tip = new THREE.Mesh(
        new THREE.CylinderGeometry(0.02, legR * 0.8, mh * 0.08, 5), steel);
      tip.position.set(Math.cos(a) * H * 0.55, mh * 1.04, Math.sin(a) * H * 0.55);
      g.add(tip);
    }

    // Propellant tanks off the pad edge, for scale and because every pad has
    // them.
    for (const [tx, tz, tr] of [[-H * 0.62, H * 0.34, R * 1.3], [-H * 0.62, -H * 0.30, R * 1.1]]) {
      const tank = new THREE.Mesh(
        new THREE.CapsuleGeometry(tr, tr * 2.6, 4, 12), concrete);
      tank.rotation.z = Math.PI / 2;
      tank.position.set(tx, tr, tz);
      g.add(tank);
    }

    g.scale.setScalar(toScene(1));
    return g;
  }

  /**
   * Stand the pad up at the launch site in the ROTATING frame.
   *
   * Same reasoning as the exhaust cloud: the site is carried east at several
   * hundred metres a second, so anything pinned to an inertial point slides
   * off the pad within seconds.
   */
  function placePad(padEci0, t) {
    if (!padModel) return;
    const th = OMEGA_EARTH * t;
    const c = Math.cos(th), sn = Math.sin(th);
    const eci = [
      padEci0[0] * c - padEci0[1] * sn,
      padEci0[0] * sn + padEci0[1] * c,
      padEci0[2],
    ];
    const p = vecToScene(eci);
    padModel.position.copy(p);
    padModel.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), p.clone().normalize());
  }

  /** Billowing exhaust cloud at the pad, in vehicle-scale metres. */
  function makeSmoke(radius) {
    const N = 220;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({
      size: toScene(radius * 5), sizeAttenuation: true, map: DOT, vertexColors: true,
      transparent: true, opacity: 0.5, depthWrite: false,
      blending: THREE.NormalBlending,
    }));
    pts.frustumCulled = false;
    pts.visible = false;
    pts.userData.seeds = Array.from({ length: N }, () => ({
      a: Math.random() * Math.PI * 2,
      r: 0.25 + Math.random() * 1.0,
      up: 0.15 + Math.random() * 0.9,
      t0: Math.random() * 0.5,
      spin: (Math.random() - 0.5) * 0.6,
    }));
    return pts;
  }

  /**
   * Drive the pad cloud.
   *
   * Anchored to the launch site in the ROTATING frame: the pad is carried east
   * at 380 m/s at Vandenberg's latitude, so a cloud pinned to an inertial
   * point would visibly slide away from the pad within seconds.
   */
  function updateSmoke(padEci0, t, vehicleRadius) {
    if (!padSmoke) return;
    const live = t > 0 && t < 32;
    padSmoke.visible = live;
    if (!live) return;

    const th = OMEGA_EARTH * t;
    const c = Math.cos(th), s = Math.sin(th);
    const pad = [
      padEci0[0] * c - padEci0[1] * s,
      padEci0[0] * s + padEci0[1] * c,
      padEci0[2],
    ];
    const base = vecToScene(pad);
    const up = base.clone().normalize();
    const side = new THREE.Vector3(0, 1, 0).cross(up);
    if (side.lengthSq() < 1e-12) side.set(1, 0, 0);
    side.normalize();
    const fwd = new THREE.Vector3().crossVectors(up, side).normalize();

    const pos = padSmoke.geometry.attributes.position.array;
    const col = padSmoke.geometry.attributes.color.array;
    const seeds = padSmoke.userData.seeds;
    for (let i = 0; i < seeds.length; i++) {
      const sd = seeds[i];
      const age = clamp((t - sd.t0 * 6) / 26, 0, 1);
      // Spreads fast at first, then stalls as it entrains air and cools.
      const grow = Math.pow(age, 0.55);
      const rr = toScene(vehicleRadius * (2 + 46 * grow * sd.r));
      const hh = toScene(vehicleRadius * (1 + 26 * grow * sd.up));
      const a = sd.a + sd.spin * grow;
      const p = base.clone()
        .add(side.clone().multiplyScalar(Math.cos(a) * rr))
        .add(fwd.clone().multiplyScalar(Math.sin(a) * rr))
        .add(up.clone().multiplyScalar(hh));
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;

      // Hot and orange at the root, cooling to grey-white steam.
      const heat = Math.max(0, 1 - age * 3.2);
      const g = 0.72 - 0.22 * heat;
      col[i * 3] = 0.80 + 0.20 * heat;
      col[i * 3 + 1] = g;
      col[i * 3 + 2] = 0.66 - 0.36 * heat;
    }
    padSmoke.geometry.attributes.position.needsUpdate = true;
    padSmoke.geometry.attributes.color.needsUpdate = true;
    padSmoke.material.opacity = 0.55 * (1 - clamp((t - 20) / 12, 0, 1));
    padSmoke.material.size = toScene(vehicleRadius * 6);
  }

  /** Draw the altitude spoke under a vehicle, or hide it. */
  function setSpoke(r, h) {
    if (!altSpoke) return;
    if (!(h > 0)) {
      altSpoke.visible = false;
      setBeacon(beacons.subpoint, null, false);
      return;
    }
    const foot = dropEci(r, h);
    const a = vecToScene(foot);
    const b = vecToScene(liftEci(r, h));
    const arr = altSpoke.geometry.attributes.position.array;
    arr[0] = a.x; arr[1] = a.y; arr[2] = a.z;
    arr[3] = b.x; arr[4] = b.y; arr[5] = b.z;
    altSpoke.geometry.attributes.position.needsUpdate = true;
    altSpoke.visible = true;
    setBeacon(beacons.subpoint, foot, true);
  }

  // ---------------------------------------------------- sample interpolation
  function sampleAt(list, t) {
    if (!list?.length) return null;
    if (t <= list[0].t) return list[0];
    if (t >= list[list.length - 1].t) return list[list.length - 1];
    let lo = 0, hi = list.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (list[m].t < t) lo = m; else hi = m; }
    const f = (t - list[lo].t) / (list[hi].t - list[lo].t || 1);
    const a = list[lo], b = list[hi];
    return {
      t,
      r: a.r.map((v, i) => lerp(v, b.r[i], f)),
      v: a.v.map((v, i) => lerp(v, b.v[i], f)),
      altitude: lerp(a.altitude, b.altitude, f),
      speed: lerp(a.speed, b.speed, f),
      relativeSpeed: lerp(a.relativeSpeed ?? a.speed, b.relativeSpeed ?? b.speed, f),
      mass: lerp(a.mass, b.mass, f),
      dynamicPressure: lerp(a.dynamicPressure ?? 0, b.dynamicPressure ?? 0, f),
      thrust: lerp(a.thrust ?? 0, b.thrust ?? 0, f),
      burning: a.burning,
      stageIndex: a.stageIndex ?? 0,
    };
  }

  function projAt(years) {
    const rows = mission.projection.rows;
    if (years <= rows[0].years) return rows[0];
    if (years >= rows[rows.length - 1].years) return rows[rows.length - 1];
    let lo = 0, hi = rows.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (rows[m].years < years) lo = m; else hi = m; }
    const f = (years - rows[lo].years) / (rows[hi].years - rows[lo].years || 1);
    const A = rows[lo], B = rows[hi];
    const L = (k) => lerp(A[k], B[k], f);
    return {
      years,
      capability: L('capability'), arrayFactor: L('arrayFactor'),
      batteryFactor: L('batteryFactor'), thermalFactor: L('thermalFactor'),
      doseFactor: L('doseFactor'), effective: L('effective'),
      petaflops: L('petaflops'), cumulativePflopYears: L('cumulativePflopYears'),
      altitudeKm: L('altitudeKm'), propellantFraction: L('propellantFraction'),
    };
  }

  /** Position on the injected orbital plane, `revs` revolutions after injection. */
  function orbitPosition(altKm, revs) {
    const r = R_EARTH_EQ + altKm * 1000;
    const a = revs * Math.PI * 2;
    const p = plane.e1.clone().multiplyScalar(r * Math.cos(a))
      .add(plane.e2.clone().multiplyScalar(r * Math.sin(a)));
    return [p.x, p.y, p.z];
  }

  /**
   * Orient a group flying along an orbit: local +X along track, +Y up (away
   * from Earth), +Z along the orbit normal.
   *
   * The normal comes from the stored orbital plane rather than from a cross
   * product with the polar axis. The obvious `up x r` construction collapses
   * to a zero vector whenever the vehicle is over a pole -- and this station
   * flies a 97.6 degree sun-synchronous orbit, so it passes within 7.6 degrees
   * of the pole twice every ninety minutes. That produced a degenerate basis
   * and a NaN quaternion, i.e. the station vanishing, twice per orbit.
   */
  function orient(group, eci) {
    const rHat = vecToScene(eci).normalize();
    const hHat = new THREE.Vector3(plane.hHat.x, plane.hHat.z, -plane.hHat.y).normalize();
    const along = new THREE.Vector3().crossVectors(hHat, rHat).normalize();
    if (along.lengthSq() < 0.5) return;   // never true for a real orbit; cheap guard
    const up = new THREE.Vector3().crossVectors(along, hHat).normalize();
    group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(along, up, hHat));
  }

  // ------------------------------------------------------------------ camera
  /**
   * Hold the globe. `lookAtEci` only biases which limb is toward the viewer --
   * the camera stays at planetary range and never locks onto a vehicle.
   *
   * User input wins. If the viewer has dragged the camera to a different
   * distance, that distance is kept until the next phase change, so the
   * documented "zoom in and the real geometry is there" is actually true
   * instead of being fought by this function every frame.
   */
  function holdGlobe(lookAtEci, distMetres, dt) {
    const snap = needsSnap;

    const current = view.camera.position.distanceTo(view.controls.target);
    if (!snap && Math.abs(current - camDist) > camDist * 0.02) {
      userDist = current;   // the viewer zoomed; respect it
    }
    const wanted = snap ? toScene(distMetres) : (userDist ?? toScene(distMetres));
    camDist = snap ? wanted : camDist * Math.pow(wanted / camDist, 1 - Math.pow(0.15, dt));

    // Frame Earth's centre, offset toward the point of interest so the action
    // sits on the visible limb rather than behind the planet.
    const target = new THREE.Vector3(0, 0, 0);
    let dir;
    if (snap && lookAtEci) {
      dir = vecToScene(lookAtEci).normalize().multiplyScalar(0.78)
        .add(new THREE.Vector3(0, 0.42, 0)).normalize();
    } else {
      dir = view.camera.position.clone().sub(view.controls.target);
      if (dir.lengthSq() < 1e-30) dir.set(0.6, 0.35, 1);
      dir.normalize();
    }

    const k = snap ? 1 : 1 - Math.pow(0.02, dt);
    view.controls.target.lerp(target, k);
    view.camera.position.lerp(target.clone().add(dir.multiplyScalar(camDist)), k);
    view.controls.minDistance = toScene(1);
    view.controls.maxDistance = 900;
  }

  /**
   * Aim the tracking camera at a subject.
   *
   * THE CAMERA IS RIGIDLY ATTACHED TO THE SUBJECT. Only the framing OFFSET is
   * smoothed, never the absolute position.
   *
   * That distinction is the whole function. Smoothing the world position looks
   * fine on a paused frame and is completely broken in motion: an exponential
   * filter lags a moving target by roughly v*tau, and this target does two
   * kilometres a second, so within a few frames of pressing play the vehicle
   * was 250 m outside a frame 200 m wide -- measured at NDC (-2.7, +4.7),
   * where anything beyond +/-1 is off screen. The inset showed empty space and
   * a bit of Earth, which is exactly what it looked like.
   *
   * Attaching the camera to the subject and easing only the direction it sits
   * in gives zero tracking lag, while still letting the shot swing gently
   * between phases instead of cutting.
   *
   * @param subjectEci  ECI position of the thing to frame [m]
   * @param sizeMetres  characteristic size, sets the standoff distance
   * @param azimuth     radians, slow orbit of the camera around the subject
   */
  function aimTrack(subjectEci, sizeMetres, azimuth, dt, elevation = -0.16,
                    aimUpMetres = 0, sideHint = null) {
    const cam = view.trackCamera;
    const p = vecToScene(subjectEci);
    const up = p.clone().normalize();

    // Build a frame around the local vertical. `sideHint` lets a caller pick
    // which way "around" means -- the station wants the camera off the orbit
    // normal, so the truss runs across frame and the radiators and arrays are
    // both at an angle to the eye. Framed from within the orbit plane instead,
    // the whole structure is edge-on and reads as a line.
    const side = sideHint ? sideHint.clone() : new THREE.Vector3(0, 1, 0).cross(up);
    side.sub(up.clone().multiplyScalar(side.dot(up)));   // make it perpendicular to up
    if (side.lengthSq() < 1e-10) side.set(1, 0, 0);
    side.normalize();
    const fwd = new THREE.Vector3().crossVectors(up, side).normalize();

    const dist = toScene(Math.max(sizeMetres, 1) * TRACK_STANDOFF);
    const wantOffset = side.clone().multiplyScalar(Math.cos(azimuth) * dist)
      .add(fwd.clone().multiplyScalar(Math.sin(azimuth) * dist))
      .add(up.clone().multiplyScalar(elevation * dist));

    if (!trackReady || needsSnap) {
      trackOffset.copy(wantOffset);
      trackReady = true;
    } else {
      trackOffset.lerp(wantOffset, 1 - Math.pow(0.01, dt));
    }

    cam.position.copy(p).add(trackOffset);
    cam.up.copy(up);
    // Aim slightly above the subject's origin so it sits low in frame with sky
    // behind it. The offset is in METRES along the local vertical, not a
    // fraction of the standoff -- scaling by standoff once put the aim point
    // 29 degrees above a subject in a 28 degree frame.
    cam.lookAt(p.clone().add(up.clone().multiplyScalar(toScene(aimUpMetres))));

    // Near plane just inside the standoff keeps depth precision on the subject
    // rather than spread across the 3 million km far plane.
    cam.near = Math.max(toScene(0.5), dist * 0.02);
    cam.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------ update
  function update(p, dt) {
    if (!mission || !rocket) return null;
    const ph = phaseAt(p);
    const lp = localP(p, ph);
    if (ph.key !== lastPhase) { needsSnap = true; userDist = null; lastPhase = ph.key; }

    const out = { phase: ph.label, key: ph.key, event: '', lines: [] };
    const asc = mission.deployment.reference;
    const rec = mission.deployment.recovery;
    const flightTime = asc.summary.flightTime;
    const sepT = asc.events.find((e) => e.name === 'stage-separation')?.t ?? flightTime * 0.35;
    const fairJetT = asc.events.find((e) => e.name === 'fairing-jettison')?.t ?? sepT + 50;
    const padEci0 = asc.samples[0].r;

    const showSite = () => {
      setBeacon(beacons.site, padEci0, true);
      return padEci0;
    };

    // ------------------------------------------------- PAD / ASCENT / SEP --
    if (ph.key === 'pad' || ph.key === 'ascent' || ph.key === 'separation') {
      // Linear in time inside each phase. Easing here looked smooth in
      // isolation but made the vehicle decelerate to a standstill at staging
      // and start again, which no rocket does.
      let t;
      if (ph.key === 'pad') t = 0;
      else if (ph.key === 'ascent') t = lp * sepT;
      else t = mapTime(lp, [
        [0.00, sepT],                                        // separation
        [0.30, Math.min(sepT + 30, flightTime)],             // ullage, ignition
        [0.62, Math.min(fairJetT + 20, flightTime)],         // fairing away
        [0.82, Math.min(sepT + 400, flightTime)],            // burn to apoapsis
        [1.00, flightTime],                                  // coast, circularise
      ]);

      const s = sampleAt(asc.samples, t);
      const siteEci = showSite();

      rocket.group.visible = true;
      rocket.group.position.copy(vecToScene(s.r));
      const up = vecToScene(s.r).normalize();
      const vel = vecToScene(s.v).normalize();
      rocket.group.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0), s.speed > 900 ? vel : up);

      const atm = atmosphere(Math.max(s.altitude, 0));
      const fairingT = fairJetT;
      const boostSepT = asc.events.find((e) => e.name === 'booster-separation')?.t ?? Infinity;
      // Mach against the AIR, not against the inertial frame: the atmosphere
      // is carried round with the planet, and at Vandenberg that is 380 m/s of
      // difference -- more than enough to put the condensation collar at the
      // wrong moment.
      const airSpeed = s.relativeSpeed ?? s.speed;
      const mach = atm.soundSpeed > 0 ? airSpeed / atm.soundSpeed : 0;
      updateRocket(rocket, {
        stageIndex: s.stageIndex,
        burning: s.burning && ph.key !== 'pad',
        ambientPressure: atm.pressure ?? 0,
        boostersAttached: t < boostSepT,
        fairingAttached: t < fairingT,
        fairingSep: clamp((t - fairingT) / 9, 0, 1),
        sepFlash: clamp(1 - Math.abs(t - sepT) / 5, 0, 1),
        mach,
        throttle: 1,
        time: t,
      });

      setBeacon(beacons.vehicle, s.r, true, s.altitude);
      setSpoke(s.r, s.altitude);
      fillTrail(ascentTrail, asc.samples, t);
      updateSmoke(padEci0, t, rocket.radius);
      placePad(padEci0, t);
      // The pad is only worth drawing while it is still a recognisable object
      // in the tracking shot; past a few tens of kilometres it is sub-pixel.
      if (padModel) padModel.visible = s.altitude < 60e3;
      syncEarth(t);

      // Once the stage is gone, fly it separately on its own trajectory.
      if (rec && t >= sepT) {
        const b = sampleAt(rec.samples, t);
        if (b) {
          boosterModel.group.visible = true;
          boosterModel.group.position.copy(vecToScene(b.r));
          orientBooster(b, t, rec);
          updateRocket(boosterModel, {
            stageIndex: 0, burning: b.burning,
            ambientPressure: atmosphere(Math.max(b.altitude, 0)).pressure ?? 0,
            boostersAttached: false, fairingAttached: false,
            retro: true, throttle: 0.6, time: t,
            legDeploy: 0, finDeflect: 0.3,
          });
          setBeacon(beacons.booster, b.r, true, b.altitude);
          fillTrail(returnTrail, rec.samples, t);
        }
      } else {
        boosterModel.group.visible = false;
        setBeacon(beacons.booster, null, false);
      }

      if (orbitRing) orbitRing.visible = t > flightTime * 0.6;
      station.group.visible = false;
      setBeacon(beacons.station, null, false);

      // Hold the globe. Pull back a little as the vehicle climbs so the whole
      // arc stays in frame, but never leave planetary range.
      holdGlobe(siteEci, lerp(2.85e7, 3.30e7, clamp(s.altitude / 700e3, 0, 1)), dt);

      // Tracking shot: tight on the pad, easing back through the ascent so the
      // exhaust plume and the curvature of the Earth both stay in frame.
      const frame = rocket.height * lerp(1.0, 1.7, clamp(t / flightTime, 0, 1));
      aimTrack(s.r, frame, 0.6 + t * 0.012, dt, -0.04, rocket.height * 0.5);
      out.track = ph.key === 'pad' ? 'PAD CAM' : 'TRACKING CAM';

      const mm = String(Math.floor(t / 60)).padStart(2, '0');
      const ss = String(Math.floor(t % 60)).padStart(2, '0');
      out.clock = ph.key === 'pad' ? 'T−00:05' : `T+${mm}:${ss}`;
      out.lines = [
        ['ALT', `${(s.altitude / 1000).toFixed(1)} km`],
        ['VEL', `${Math.round(s.speed).toLocaleString()} m/s`],
        ['MASS', `${(s.mass / 1000).toFixed(0)} t`],
        ['Q', `${(s.dynamicPressure / 1000).toFixed(1)} kPa`],
      ];
      out.scaleNote = `wide view: altitude ×${ALT_GAIN} near the ground, true at orbit`;
      const near = asc.events.find((e) => t >= e.t - 0.5 && t <= e.t + 20);
      if (near) out.event = near.name.replace(/-/g, ' ').toUpperCase();
      if (ph.key === 'pad') { out.event = 'IGNITION'; out.phase = 'Pre-launch'; }

    // ------------------------------------------------------------ RECOVERY --
    } else if (ph.key === 'recovery') {
      const siteEci = showSite();
      rocket.group.visible = false;
      station.group.visible = false;
      setBeacon(beacons.station, null, false);
      if (orbitRing) orbitRing.visible = true;
      fillTrail(ascentTrail, asc.samples, flightTime);
      const inj = asc.samples[asc.samples.length - 1];
      setBeacon(beacons.vehicle, inj.r, true, inj.altitude);
      if (padSmoke) padSmoke.visible = false;
      if (padModel) padModel.visible = false;

      if (rec && rec.samples.length) {
        const last = rec.samples[rec.samples.length - 1].t;
        const t = lerp(sepT, last, lp);
        const b = sampleAt(rec.samples, t);
        boosterModel.group.visible = true;
        boosterModel.group.position.copy(vecToScene(b.r));
        orientBooster(b, t, rec);

        const alt = Math.max(b.altitude, 0);
        const landingT = rec.events.find((e) => /landing/.test(e.name))?.t ?? Infinity;
        updateRocket(boosterModel, {
          stageIndex: 0, burning: b.burning,
          ambientPressure: atmosphere(alt).pressure ?? 0,
          boostersAttached: false, fairingAttached: false,
          retro: true, throttle: b.burning ? 0.85 : 0, time: t,
          // Legs come out late in the landing burn, fins bite once there is air.
          legDeploy: clamp((10e3 - alt) / 7e3, 0, 1) * (t > landingT - 25 ? 1 : 0),
          finDeflect: clamp((70e3 - alt) / 40e3, 0, 1),
        });
        setBeacon(beacons.booster, b.r, true, b.altitude);
        setSpoke(b.r, b.altitude);
        fillTrail(returnTrail, rec.samples, t);
        syncEarth(t);

        holdGlobe(siteEci, 2.90e7, dt);
        aimTrack(b.r, boosterModel.height * 2.2, 1.9 + t * 0.01, dt, 0.10, boosterModel.height * 0.35);
        out.track = 'BOOSTER CAM';

        out.clock = `T+${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
        out.lines = [
          ['ALT', `${(b.altitude / 1000).toFixed(1)} km`],
          ['VEL', `${Math.round(b.relativeSpeed ?? b.speed)} m/s`],
          ['MODE', rec.profile.name],
          ['RANGE', `${rec.downrangeKm?.toFixed(0) ?? '—'} km`],
        ];
        out.scaleNote = `wide view: altitude ×${ALT_GAIN} near the ground, true at orbit`;
        const ev = rec.events.find((e) => t >= e.t - 0.5 && t <= e.t + 16);
        if (ev) out.event = ev.name.replace(/-/g, ' ').toUpperCase();
        if (lp > 0.94) {
          out.event = rec.softLanding
            ? `BOOSTER LANDED · ${rec.touchdownSpeed.toFixed(1)} m/s`
            : `BOOSTER LOST · ${rec.touchdownSpeed.toFixed(0)} m/s IMPACT`;
        }
      } else {
        boosterModel.group.visible = false;
        setBeacon(beacons.booster, null, false);
        holdGlobe(siteEci, 3.10e7, dt);
        aimTrack(asc.samples[asc.samples.length - 1].r, rocket.height * 2.4, 1.9, dt, 0.05, rocket.height * 0.5);
        out.track = 'UPPER STAGE';
        out.clock = 'T+—';
        out.event = 'STAGE EXPENDED';
        out.lines = [['MODE', 'Expendable'], ['', 'no recovery flown']];
      }

    // ------------------------------------------ ASSEMBLY / OPS / OUTCOME --
    } else {
      const deployYears = mission.deployment.deploymentYears;
      const endYears = mission.projection.endYears;
      let years;
      if (ph.key === 'assembly') years = smooth(lp) * deployYears;
      else if (ph.key === 'operations') years = lerp(deployYears, endYears, smooth(lp));
      else years = endYears;

      // Compressed display clock -- see ORBITS_PER_PHASE. Continuous across
      // the three orbital phases so the station does not jump at a boundary.
      const period = mission.design.orbit.period;
      const before = { assembly: 0, operations: ORBITS_PER_PHASE.assembly,
        outcome: ORBITS_PER_PHASE.assembly + ORBITS_PER_PHASE.operations }[ph.key];
      const revs = before + lp * ORBITS_PER_PHASE[ph.key];
      const displaySeconds = revs * period;

      const pr = projAt(years);
      const failing = ph.key === 'outcome'
        && mission.projection.endReason !== 'planned end of mission';
      const reentering = failing && /decay|propellant/i.test(mission.projection.endReason);

      rocket.group.visible = false;
      boosterModel.group.visible = false;
      ascentTrail.visible = false;
      returnTrail.visible = false;
      if (padSmoke) padSmoke.visible = false;
      if (padModel) padModel.visible = false;
      setBeacon(beacons.vehicle, null, false);
      setBeacon(beacons.booster, null, false);
      setBeacon(beacons.site, null, false);
      setSpoke(null, 0);
      if (orbitRing) orbitRing.visible = true;

      const altKm = reentering ? lerp(pr.altitudeKm, 95, smooth(lp)) : pr.altitudeKm;
      const eci = orbitPosition(altKm, revs);
      syncEarth(displaySeconds);

      station.group.visible = true;
      station.group.position.copy(vecToScene(eci));
      orient(station.group, eci);
      updateStation(station, {
        assembly: pr.capability,
        thermal: pr.thermalFactor,
        array: pr.arrayFactor,
        dose: pr.doseFactor,
      });
      setBeacon(beacons.station, eci, true);

      if (reentering && lp > 0.45) {
        debris.visible = true;
        const f = (lp - 0.45) / 0.55;
        const arr = debris.geometry.attributes.position.array;
        const base = vecToScene(eci);
        // Spread the corridor along track, using the orbit's own basis.
        const along = new THREE.Vector3(plane.e2.x, plane.e2.z, -plane.e2.y).normalize();
        const nrm = new THREE.Vector3(plane.hHat.x, plane.hHat.z, -plane.hHat.y).normalize();
        const rad = base.clone().normalize();
        for (let i = 0; i < arr.length / 3; i++) {
          const v = debris.userData.vel[i];
          const q = base.clone()
            .add(along.clone().multiplyScalar(v.x * f))
            .add(rad.clone().multiplyScalar(v.y * f))
            .add(nrm.clone().multiplyScalar(v.z * f));
          arr[i * 3] = q.x; arr[i * 3 + 1] = q.y; arr[i * 3 + 2] = q.z;
        }
        debris.geometry.attributes.position.needsUpdate = true;
        debris.material.opacity = Math.min(1, f * 3) * (1 - Math.pow(f, 2.2) * 0.8);
        debris.material.color.setRGB(1, 0.72 - 0.3 * f, 0.42 - 0.36 * f);
        station.group.visible = f < 0.5;
      } else if (debris) debris.visible = false;

      // Hold the globe here too. Diving at the station put the main camera one
      // kilometre from a structure hundreds of metres across -- inside its own
      // geometry, past the near plane, and with the orbit thrown away
      // entirely. The tracking inset does that job now, and it does it without
      // costing the wide shot anything.
      holdGlobe(eci, 3.10e7, dt);
      if (station.group.visible) {
        // Off the orbit normal AND well above the plane. The radiators face
        // the orbit normal and the arrays face along the local vertical --
        // they are built ninety degrees apart on purpose -- so a camera lying
        // in either of those directions sees one of them edge-on and the
        // station reads as a bare stick. About forty degrees up splits the
        // difference and both catch the light.
        const normalScene = new THREE.Vector3(plane.hHat.x, plane.hHat.z, -plane.hHat.y);
        // Oscillate about broadside instead of orbiting all the way around.
        // The truss lies along track, so a camera that sweeps a full circle
        // spends part of every phase looking straight down it, with the whole
        // station stacked into a single point.
        const sway = 0.42 * Math.sin(displaySeconds * 0.00022);
        aimTrack(eci, station.span * 0.70, sway, dt, 0.80, 0, normalScene);
        out.track = ph.key === 'assembly' ? 'ASSEMBLY CAM' : 'STATION CAM';
      }

      out.clock = `Y+${years.toFixed(1)}`;
      out.lines = [
        ['ONLINE', `${Math.round(pr.capability * 100)}%`],
        ['NET', `${Math.round(pr.effective * 100)}%`],
        ['THERMAL', `${Math.round(pr.thermalFactor * 100)}%`],
        ['ALT', `${altKm.toFixed(0)} km`],
      ];
      out.telemetry = pr;
      // State the compression rather than hiding it: the orbit really is being
      // shown at a few thousand times real time.
      const yearsPerPhase = ph.key === 'assembly' ? deployYears
        : ph.key === 'operations' ? endYears - deployYears : 0.01;
      const ratio = (yearsPerPhase * 365.25 * 86400)
        / Math.max(ORBITS_PER_PHASE[ph.key] * period, 1);
      if (ratio > 2) out.scaleNote = `orbit shown at 1:${Math.round(ratio).toLocaleString()} time-lapse`;

      if (ph.key === 'assembly') {
        const n = Math.max(1, Math.ceil(pr.capability * mission.deployment.flightsNeeded));
        out.event = `MODULE ${n} OF ${mission.deployment.flightsNeeded}`;
      } else if (ph.key === 'outcome') {
        out.event = mission.projection.endReason.toUpperCase();
      }
    }

    needsSnap = false;
    return out;
  }

  /**
   * Point the returning booster the way it actually flies.
   *
   * A first stage does not fall belly-first. It flips after separation, burns
   * retrograde to kill downrange velocity, coasts engines-forward through
   * entry, and lands nose-up on its legs. So its axis is along the flight
   * direction during the flip and burns, and along the local vertical once it
   * is descending under the landing burn.
   */
  function orientBooster(b, t, rec) {
    const pos = vecToScene(b.r);
    const up = pos.clone().normalize();
    const vel = vecToScene(b.v);
    const speed = vel.length();

    const landingT = rec.events.find((e) => /landing/.test(e.name))?.t ?? Infinity;
    // Below about 10 km on the landing burn it is vertical over the pad.
    const vertical = b.altitude < 12e3 || t >= landingT;

    let axis;
    if (vertical || speed < 1e-9) {
      axis = up;
    } else {
      // Engines point INTO the airflow, so the nose points away from the
      // velocity vector: the model's +Y is anti-velocity.
      axis = vel.normalize().negate();
      // Blend to vertical as it slows into the landing.
      const f = clamp((25e3 - b.altitude) / 13e3, 0, 1);
      axis.lerp(up, f).normalize();
    }
    boosterModel.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
  }

  return { load, update, clear, dispose, root, get mission() { return mission; } };
}
