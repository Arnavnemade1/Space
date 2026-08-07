/**
 * Procedural launch vehicle geometry.
 *
 * Built from the same numbers the ascent simulation flies: tank lengths come
 * from propellant mass divided by its bulk density, engine counts from the
 * stage's engine count, booster geometry from the booster block. Nothing here
 * is a hand-drawn model of a particular rocket -- change a propellant mass in
 * the database and the vehicle on screen gets longer.
 *
 * That is why the vehicles look genuinely different from one another. Falcon 9
 * is a slender kerolox pencil; SLS is a fat hydrogen core because hydrolox is a
 * third the density; Ariane 6 is a small core swamped by its solids. Those are
 * consequences of the propellant, not styling choices.
 *
 * Everything is modelled in METRES and the group is scaled into scene units by
 * the caller, so all the dimensions below read as real dimensions.
 */

import * as THREE from 'three';
import { stageTankLength, boosterLength, PROPELLANT_DENSITY } from '../sim/vehicles.js';

const MAT = {
  tank: () => new THREE.MeshStandardMaterial({
    color: 0xe8edf2, metalness: 0.42, roughness: 0.34,
  }),
  tankDark: () => new THREE.MeshStandardMaterial({
    color: 0x9aa6b3, metalness: 0.55, roughness: 0.42,
  }),
  interstage: () => new THREE.MeshStandardMaterial({
    color: 0x2b3440, metalness: 0.5, roughness: 0.6,
  }),
  engine: () => new THREE.MeshStandardMaterial({
    color: 0x4a5563, metalness: 0.85, roughness: 0.32,
  }),
  solid: () => new THREE.MeshStandardMaterial({
    color: 0xd9d2c4, metalness: 0.2, roughness: 0.72,
  }),
  fairing: () => new THREE.MeshStandardMaterial({
    color: 0xf2f5f8, metalness: 0.25, roughness: 0.4,
  }),
  ship: () => new THREE.MeshStandardMaterial({
    color: 0xc9d2db, metalness: 0.72, roughness: 0.28,
  }),
};

/** Ogive fairing profile, revolved. A real payload fairing is not a cone. */
function ogiveProfile(radius, length, segments = 18) {
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    // Tangent ogive: radius falls as sqrt of remaining length, blunted at tip.
    const r = radius * Math.sqrt(Math.max(0, 1 - t * t)) * (1 - 0.06 * t);
    pts.push(new THREE.Vector2(Math.max(r, 0.04), t * length));
  }
  return pts;
}

/** A bell nozzle, revolved: throat, expansion, exit lip. */
function nozzleProfile(exitRadius, length) {
  const pts = [];
  const n = 12;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const r = exitRadius * (0.22 + 0.78 * Math.pow(t, 0.62));
    pts.push(new THREE.Vector2(r, -t * length));
  }
  return pts;
}

function engineCluster(count, stageRadius, scale = 1) {
  const g = new THREE.Group();
  const mat = MAT.engine();
  const exitR = Math.min(stageRadius * 0.34, stageRadius / Math.sqrt(Math.max(count, 1)) * 0.78) * scale;
  const len = exitR * 2.1;
  const geo = new THREE.LatheGeometry(nozzleProfile(exitR, len), 14);

  if (count <= 1) {
    const m = new THREE.Mesh(geo, mat);
    g.add(m);
    return g;
  }
  // One in the centre, the rest on a ring -- the octaweb / ring arrangement
  // every clustered first stage uses.
  const ring = count - 1;
  const centre = new THREE.Mesh(geo, mat);
  g.add(centre);
  const r = stageRadius * 0.62;
  for (let i = 0; i < ring; i++) {
    const a = (i / ring) * Math.PI * 2;
    const m = new THREE.Mesh(geo, mat);
    m.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    g.add(m);
  }
  return g;
}

/**
 * Exhaust plume: an additive cone that flickers. Length is driven by ambient
 * pressure at runtime -- a vacuum plume is enormous and diffuse, a sea-level
 * one is short and tight, which is a real and very visible difference.
 */
function makePlume(radius) {
  const geo = new THREE.ConeGeometry(radius, radius * 7, 16, 1, true);
  geo.translate(0, -radius * 3.5, 0);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffb066, transparent: true, opacity: 0.55,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);

  const coreGeo = new THREE.ConeGeometry(radius * 0.45, radius * 4.2, 12, 1, true);
  coreGeo.translate(0, -radius * 2.1, 0);
  const core = new THREE.Mesh(coreGeo, new THREE.MeshBasicMaterial({
    color: 0xfff0d0, transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  }));

  const g = new THREE.Group();
  g.add(mesh); g.add(core);
  g.userData.mat = mat;
  g.userData.coreMat = core.material;
  return g;
}

/**
 * Build a complete launch vehicle.
 *
 * The group's origin sits at the base of the vehicle with +Y along its long
 * axis, so positioning it is just "put the origin on the pad and point +Y up".
 *
 * @returns {{group:THREE.Group, height:number, parts:object}}
 */
export function buildRocket(vehicle) {
  const group = new THREE.Group();
  const parts = { stages: [], boosters: [], plumes: [], fairing: null, boosterPlumes: [] };

  const D = vehicle.diameter;
  const R = D / 2;
  let y = 0;

  // ---- stage 0 -----------------------------------------------------------
  const s0 = vehicle.stages[0];
  const l0 = stageTankLength(s0, D);
  const skirt = R * 0.55;

  const stage0 = new THREE.Group();
  const body0 = new THREE.Mesh(new THREE.CylinderGeometry(R, R, l0, 40, 1), MAT.tank());
  body0.position.y = skirt + l0 / 2;
  stage0.add(body0);

  // engine skirt, darker
  const sk = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 0.94, skirt, 40, 1), MAT.interstage());
  sk.position.y = skirt / 2;
  stage0.add(sk);

  const eng0 = engineCluster(s0.engines ?? 9, R);
  eng0.position.y = 0.02;
  stage0.add(eng0);

  const plume0 = makePlume(R * 0.82);
  plume0.position.y = -R * 0.2;
  plume0.visible = false;
  stage0.add(plume0);
  parts.plumes.push(plume0);

  group.add(stage0);
  parts.stages.push(stage0);
  y = skirt + l0;

  // ---- strap-on boosters -------------------------------------------------
  if (s0.boosters) {
    const b = s0.boosters;
    const bl = boosterLength(s0);
    const bR = (b.diameter ?? 2) / 2;
    const n = b.count || 2;
    const solid = (b.propellant ?? 'solid') === 'solid';

    for (let i = 0; i < n; i++) {
      // Two boosters sit opposite each other; more are spread evenly.
      const a = n === 2 ? (i === 0 ? 0 : Math.PI) : (i / n) * Math.PI * 2;
      const bg = new THREE.Group();

      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(bR, bR, bl, 28, 1),
        solid ? MAT.solid() : MAT.tankDark(),
      );
      body.position.y = bl / 2;
      bg.add(body);

      // nose cone
      const nose = new THREE.Mesh(
        new THREE.LatheGeometry(ogiveProfile(bR, bR * 2.4), 24),
        solid ? MAT.solid() : MAT.tankDark(),
      );
      nose.position.y = bl;
      bg.add(nose);

      // solids have a single fixed nozzle; liquid boosters get a cluster
      const be = solid
        ? engineCluster(1, bR, 1.15)
        : engineCluster(s0.engines ?? 9, bR, 0.9);
      bg.add(be);

      const bp = makePlume(bR * 0.9);
      bp.visible = false;
      bg.add(bp);
      parts.boosterPlumes.push(bp);

      bg.position.set(Math.cos(a) * (R + bR * 0.94), 0, Math.sin(a) * (R + bR * 0.94));
      group.add(bg);
      parts.boosters.push(bg);
    }
  }

  // ---- upper stages ------------------------------------------------------
  for (let i = 1; i < vehicle.stages.length; i++) {
    const st = vehicle.stages[i];
    const li = stageTankLength(st, D * 0.98);
    const g = new THREE.Group();

    // interstage below the tank
    const isLen = R * 0.9;
    const inter = new THREE.Mesh(
      new THREE.CylinderGeometry(R * 0.99, R * 0.99, isLen, 36, 1), MAT.interstage());
    inter.position.y = isLen / 2;
    g.add(inter);

    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(R * 0.98, R * 0.98, li, 36, 1), MAT.tank());
    body.position.y = isLen + li / 2;
    g.add(body);

    const eng = engineCluster(st.engines ?? 1, R * 0.7, 1.25);
    eng.position.y = isLen * 0.15;
    g.add(eng);

    const pl = makePlume(R * 0.6);
    pl.position.y = isLen * 0.1;
    pl.visible = false;
    g.add(pl);
    parts.plumes.push(pl);

    g.position.y = y;
    group.add(g);
    parts.stages.push(g);
    y += isLen + li;
  }

  // ---- payload fairing / ship --------------------------------------------
  const isStarship = vehicle.id === 'starship';
  if (isStarship) {
    // Starship carries its payload internally, so the "fairing" is the ship's
    // own nose. Give it the characteristic long nose and forward flaps.
    const nose = new THREE.Mesh(
      new THREE.LatheGeometry(ogiveProfile(R * 0.98, R * 3.1), 32), MAT.ship());
    nose.position.y = y;
    group.add(nose);

    const flapGeo = new THREE.BoxGeometry(R * 0.14, R * 1.5, R * 0.85);
    for (const sgn of [-1, 1]) {
      const f = new THREE.Mesh(flapGeo, MAT.ship());
      f.position.set(sgn * R * 0.98, y - R * 0.5, 0);
      f.rotation.z = sgn * 0.22;
      group.add(f);
    }
    y += R * 3.1;
  } else if ((vehicle.fairingMass ?? 0) > 0) {
    const fl = R * 3.4;
    const fairing = new THREE.Mesh(
      new THREE.LatheGeometry(ogiveProfile(R, fl), 32), MAT.fairing());
    fairing.position.y = y;
    group.add(fairing);
    parts.fairing = fairing;
    y += fl;
  } else {
    const nose = new THREE.Mesh(
      new THREE.LatheGeometry(ogiveProfile(R * 0.9, R * 2.6), 28), MAT.fairing());
    nose.position.y = y;
    group.add(nose);
    y += R * 2.6;
  }

  return { group, height: y, parts, vehicle };
}

/**
 * Drive the vehicle's appearance from the flight state.
 *
 * @param {object} rocket      result of buildRocket
 * @param {object} s           { stageIndex, burning, ambientPressure, boostersAttached, fairingAttached }
 */
export function updateRocket(rocket, s) {
  const { parts } = rocket;

  // Stages already dropped are hidden outright.
  parts.stages.forEach((g, i) => { g.visible = i >= s.stageIndex; });
  parts.boosters.forEach((b) => { b.visible = !!s.boostersAttached; });
  if (parts.fairing) parts.fairing.visible = !!s.fairingAttached;

  // Plume length keys off ambient pressure: a nozzle exhausting into vacuum
  // has nothing to constrain the flow, so the plume balloons out to several
  // times its sea-level length. This is the most visible single cue that the
  // vehicle has left the atmosphere.
  const pRel = Math.max(0, Math.min(1, (s.ambientPressure ?? 0) / 101325));
  const spread = 1 + (1 - pRel) * 2.6;
  const flicker = 0.86 + Math.random() * 0.14;

  parts.plumes.forEach((p, i) => {
    const live = s.burning && i === s.stageIndex;
    p.visible = live;
    if (!live) return;
    p.scale.set(1 + (spread - 1) * 0.45, spread, 1 + (spread - 1) * 0.45);
    p.userData.mat.opacity = 0.30 * flicker + 0.18 * pRel;
    p.userData.coreMat.opacity = 0.75 * flicker;
  });

  const boostersLive = s.burning && s.boostersAttached && s.stageIndex === 0;
  parts.boosterPlumes.forEach((p) => {
    p.visible = boostersLive;
    if (!boostersLive) return;
    p.scale.set(1 + (spread - 1) * 0.4, spread * 0.9, 1 + (spread - 1) * 0.4);
    p.userData.mat.opacity = 0.32 * flicker;
    p.userData.coreMat.opacity = 0.8 * flicker;
  });
}

/** Free every geometry and material the vehicle owns. */
export function disposeRocket(rocket) {
  rocket.group.traverse((o) => {
    o.geometry?.dispose?.();
    if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
    else o.material?.dispose?.();
  });
}
