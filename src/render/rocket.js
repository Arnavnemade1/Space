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
 * Everything is modelled in METRES and rendered at TRUE SCALE, so the numbers
 * below read as real dimensions and the vehicle in the tracking inset is the
 * size it actually is.
 */

import * as THREE from 'three';
import { stageTankLength, boosterLength } from '../sim/vehicles.js';

const MAT = {
  tank: () => new THREE.MeshStandardMaterial({
    color: 0xe8edf2, metalness: 0.30, roughness: 0.42,
  }),
  tankDark: () => new THREE.MeshStandardMaterial({
    color: 0x8d99a6, metalness: 0.55, roughness: 0.44,
  }),
  interstage: () => new THREE.MeshStandardMaterial({
    color: 0x232b36, metalness: 0.45, roughness: 0.68,
  }),
  engine: () => new THREE.MeshStandardMaterial({
    color: 0x3f4956, metalness: 0.9, roughness: 0.30,
  }),
  soot: () => new THREE.MeshStandardMaterial({
    color: 0x15181d, metalness: 0.35, roughness: 0.85,
  }),
  solid: () => new THREE.MeshStandardMaterial({
    color: 0xd9d2c4, metalness: 0.15, roughness: 0.76,
  }),
  fairing: () => new THREE.MeshStandardMaterial({
    color: 0xf2f5f8, metalness: 0.18, roughness: 0.46,
  }),
  ship: () => new THREE.MeshStandardMaterial({
    color: 0xc9d2db, metalness: 0.78, roughness: 0.24,
  }),
};

/** Ogive fairing profile, revolved. A real payload fairing is not a cone. */
function ogiveProfile(radius, length, segments = 20) {
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
  const n = 14;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const r = exitRadius * (0.22 + 0.78 * Math.pow(t, 0.62));
    pts.push(new THREE.Vector2(r, -t * length));
  }
  return pts;
}

/**
 * Engine cluster with a sooted heat shield behind it.
 *
 * The dark plate matters more than it sounds: a bare ring of bells reads as
 * loose plumbing, whereas engines recessed into a black base plate is what the
 * underside of a first stage actually looks like.
 */
function engineCluster(count, stageRadius, scale = 1) {
  const g = new THREE.Group();
  const mat = MAT.engine();
  const exitR = Math.min(stageRadius * 0.34, stageRadius / Math.sqrt(Math.max(count, 1)) * 0.78) * scale;
  const len = exitR * 2.1;
  const geo = new THREE.LatheGeometry(nozzleProfile(exitR, len), 16);

  const basePlate = new THREE.Mesh(
    new THREE.CylinderGeometry(stageRadius * 0.99, stageRadius * 0.99, exitR * 0.22, 32),
    MAT.soot());
  basePlate.position.y = exitR * 0.11;
  g.add(basePlate);

  const nozzles = [];
  if (count <= 1) {
    nozzles.push(new THREE.Vector3(0, 0, 0));
  } else {
    // One in the centre, the rest on a ring -- the octaweb / ring arrangement
    // every clustered first stage uses.
    nozzles.push(new THREE.Vector3(0, 0, 0));
    const ring = count - 1;
    const r = stageRadius * 0.62;
    for (let i = 0; i < ring; i++) {
      const a = (i / ring) * Math.PI * 2;
      nozzles.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
    }
  }

  // The inside of a running bell glows; this is a separate inward-facing cone
  // that lights up with the plume rather than a material trick, so it can be
  // driven by throttle at runtime.
  const glowMat = new THREE.MeshBasicMaterial({
    color: 0xffb15a, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide,
  });
  for (const p of nozzles) {
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(p);
    g.add(m);
    const glow = new THREE.Mesh(geo, glowMat);
    glow.position.copy(p);
    glow.scale.setScalar(0.96);
    g.add(glow);
  }
  g.userData.glowMat = glowMat;
  g.userData.exitRadius = exitR;
  return g;
}

// ---------------------------------------------------------------------------
// Exhaust plume
// ---------------------------------------------------------------------------

/**
 * Plume shell shader.
 *
 * `uSpread` stretches the cone with falling ambient pressure. That is not
 * styling: a nozzle is designed to exhaust at one particular back pressure,
 * and above it the flow has nothing to constrain it, so the plume balloons
 * out to several times its sea-level length. Watching it bloom as the vehicle
 * leaves the atmosphere is the single clearest visual cue that it has.
 */
const PLUME_VERT = /* glsl */ `
  uniform float uLen;
  varying float vS;
  varying vec3 vN;
  varying vec3 vV;
  void main() {
    vS = clamp(-position.y / uLen, 0.0, 1.0);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const PLUME_FRAG = /* glsl */ `
  uniform vec3 uHot;
  uniform vec3 uCool;
  uniform float uOpacity;
  uniform float uPressure;   // 0 vacuum .. 1 sea level
  uniform float uTime;
  varying float vS;
  varying vec3 vN;
  varying vec3 vV;

  void main() {
    // Along the plume: white-hot at the throat, cooling to orange, fading out.
    vec3 col = mix(uHot, uCool, pow(vS, 0.55));

    // Shock diamonds. A nozzle running off its design pressure sets up a
    // standing train of oblique shocks, and the compressed gas between them
    // re-ignites -- the bright beads you see under a sea-level engine. They
    // fade out in vacuum, where there is no back pressure to shock against.
    float beads = 0.5 + 0.5 * cos(vS * 46.0 - uTime * 1.5);
    float diamond = pow(beads, 5.0) * smoothstep(0.02, 0.35, vS)
                  * (1.0 - smoothstep(0.35, 0.85, vS)) * uPressure;
    col += vec3(1.0, 0.86, 0.62) * diamond * 1.9;

    // Silhouette falloff: the shell is thickest to the eye where it is seen
    // edge-on, which is what gives a hollow cone a gaseous look.
    float edge = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 0.8);
    float a = uOpacity * (1.0 - pow(vS, 1.35)) * (0.35 + 0.65 * edge);

    gl_FragColor = vec4(col * (1.0 + diamond), a);
  }
`;

/**
 * Exhaust plume: two nested shells plus a throat flare.
 *
 * Modelled pointing down -Y from the engine plane, so it is correct for an
 * ascending vehicle; the same object serves the landing burn, where the
 * vehicle is still nose-up and the engines still fire downward.
 */
function makePlume(radius, length) {
  const g = new THREE.Group();

  const shell = (r, len, hot, cool, opacity) => {
    const geo = new THREE.ConeGeometry(r, len, 22, 1, true);
    geo.translate(0, -len / 2, 0);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uLen: { value: len },
        uHot: { value: new THREE.Color(hot) },
        uCool: { value: new THREE.Color(cool) },
        uOpacity: { value: opacity },
        uPressure: { value: 1 },
        uTime: { value: 0 },
      },
      vertexShader: PLUME_VERT,
      fragmentShader: PLUME_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    return new THREE.Mesh(geo, mat);
  };

  const outer = shell(radius * 1.15, radius * 8.5, 0xffc98a, 0xd2500f, 0.30);
  const core = shell(radius * 0.46, radius * 5.0, 0xffffff, 0xffc060, 0.85);
  g.add(outer);
  g.add(core);

  // The throat itself is over-bright so the bloom pass finds it and blows a
  // halo around the engine bay, which is what a real one does to a camera.
  const flare = new THREE.Sprite(new THREE.SpriteMaterial({
    map: softDot(), color: 0xffe0b0, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  flare.scale.setScalar(radius * 3.4);
  g.add(flare);

  g.userData.outer = outer.material;
  g.userData.core = core.material;
  g.userData.flare = flare;
  g.userData.radius = radius;
  return g;
}

let DOT_TEXTURE = null;
function softDot() {
  if (DOT_TEXTURE) return DOT_TEXTURE;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.22, 'rgba(255,240,210,0.55)');
  grad.addColorStop(1, 'rgba(255,190,120,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  DOT_TEXTURE = new THREE.CanvasTexture(c);
  DOT_TEXTURE.colorSpace = THREE.SRGBColorSpace;
  return DOT_TEXTURE;
}

/**
 * Build a complete launch vehicle.
 *
 * The group's origin sits at the base of the vehicle with +Y along its long
 * axis, so positioning it is just "put the origin on the pad and point +Y up".
 *
 * @returns {{group:THREE.Group, height:number, parts:object}}
 */
export function buildRocket(vehicle, opts = {}) {
  const { firstStageOnly = false } = opts;
  const group = new THREE.Group();
  const parts = {
    stages: [], boosters: [], plumes: [], fairing: null, boosterPlumes: [],
    gridFins: [], legs: [], retroPlume: null, engineGlows: [],
    fairingHalves: [], sepPuffs: [], vapourCone: null,
  };

  const D = vehicle.diameter;
  const R = D / 2;
  let y = 0;

  // ---- stage 0 -----------------------------------------------------------
  const s0 = vehicle.stages[0];
  const l0 = stageTankLength(s0, D);
  const skirt = R * 0.55;

  const stage0 = new THREE.Group();
  const body0 = new THREE.Mesh(new THREE.CylinderGeometry(R, R, l0, 48, 1), MAT.tank());
  body0.position.y = skirt + l0 / 2;
  stage0.add(body0);

  // The weld line between the LOX and fuel tanks. One ring, but it is the
  // detail that gives a plain cylinder a sense of length.
  const domeY = skirt + l0 * (s0.propellant === 'hydrolox' ? 0.62 : 0.58);
  const weld = new THREE.Mesh(
    new THREE.CylinderGeometry(R * 1.006, R * 1.006, R * 0.05, 48), MAT.tankDark());
  weld.position.y = domeY;
  stage0.add(weld);

  // engine skirt, darker
  const sk = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 0.94, skirt, 48, 1), MAT.interstage());
  sk.position.y = skirt / 2;
  stage0.add(sk);

  const eng0 = engineCluster(s0.engines ?? 9, R);
  eng0.position.y = 0.02;
  stage0.add(eng0);
  parts.engineGlows.push(eng0.userData.glowMat);

  const plume0 = makePlume(R * 0.80, l0);
  plume0.position.y = -R * 0.42;
  plume0.visible = false;
  stage0.add(plume0);
  parts.plumes.push(plume0);

  // --- raceway ------------------------------------------------------------
  // The cable and pressurant conduit running the length of the stage. A small
  // detail, but it is the thing that makes a plain white cylinder read as a
  // rocket rather than a pipe.
  const race = new THREE.Mesh(
    new THREE.BoxGeometry(R * 0.13, l0 * 0.92, R * 0.09), MAT.tankDark());
  race.position.set(R * 0.97, skirt + l0 / 2, 0);
  stage0.add(race);

  const reusable = !!(vehicle.payloadLeoReusable && vehicle.payloadLeoReusable > 0);

  // --- grid fins ----------------------------------------------------------
  // Only a recoverable stage carries them. They sit just below the interstage
  // and are what steers the booster on the way back down.
  if (reusable) {
    const finMat = MAT.engine();
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      // Outer group carries the azimuth; the blade hinges inside it, so the
      // hinge axis is the same for all four fins and stowing them is one
      // rotation about local Z rather than a different axis per fin.
      const mount = new THREE.Group();
      const fin = new THREE.Group();
      const blade = new THREE.Mesh(
        new THREE.BoxGeometry(R * 0.62, R * 0.05, R * 0.48), finMat);
      blade.position.x = R * 0.31;
      fin.add(blade);
      // Lattice, suggested with a few ribs rather than modelled cell by cell.
      for (let k = -1; k <= 1; k++) {
        const rib = new THREE.Mesh(
          new THREE.BoxGeometry(R * 0.62, R * 0.09, R * 0.03), finMat);
        rib.position.set(R * 0.31, 0, k * R * 0.16);
        fin.add(rib);
      }
      mount.add(fin);
      mount.position.set(Math.cos(a) * R, skirt + l0 * 0.94, Math.sin(a) * R);
      mount.rotation.y = -a;
      stage0.add(mount);
      parts.gridFins.push(fin);
    }
  }

  // --- landing legs -------------------------------------------------------
  // Stowed against the body until the landing burn, then folded out.
  if (reusable) {
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const mount = new THREE.Group();
      const leg = new THREE.Group();
      const legLen = skirt + l0 * 0.20;
      const strut = new THREE.Mesh(
        new THREE.CylinderGeometry(R * 0.055, R * 0.075, legLen, 8), MAT.tankDark());
      // Hinge at the top of the leg, so deploying swings the foot outward and
      // downward the way a real telescoping leg does.
      strut.position.y = -legLen / 2;
      leg.add(strut);
      const foot = new THREE.Mesh(
        new THREE.CylinderGeometry(R * 0.19, R * 0.19, R * 0.05, 12), MAT.engine());
      foot.position.y = -legLen;
      leg.add(foot);

      mount.add(leg);
      mount.position.set(Math.cos(a) * R * 0.94, legLen, Math.sin(a) * R * 0.94);
      mount.rotation.y = -a;
      stage0.add(mount);
      parts.legs.push(leg);
    }
  }

  // Retro plume for the landing burn: shorter and much narrower than the
  // ascent plume because only the centre engine (or three of nine) is lit.
  const retro = makePlume(R * 0.42, l0 * 0.35);
  retro.position.y = -R * 0.42;
  retro.visible = false;
  stage0.add(retro);
  parts.retroPlume = retro;

  group.add(stage0);
  parts.stages.push(stage0);
  y = skirt + l0;
  const sepY = y;

  // A recovered booster is just this stage; skip everything above it.
  if (firstStageOnly) {
    // Cap the open top where the interstage used to be.
    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(R * 0.99, R * 0.99, R * 0.55, 40), MAT.interstage());
    cap.position.y = y + R * 0.275;
    stage0.add(cap);
    return { group, height: y + R * 0.55, radius: R, parts, vehicle, firstStageOnly: true };
  }

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
        new THREE.CylinderGeometry(bR, bR, bl, 32, 1),
        solid ? MAT.solid() : MAT.tankDark(),
      );
      body.position.y = bl / 2;
      bg.add(body);

      // nose cone
      const nose = new THREE.Mesh(
        new THREE.LatheGeometry(ogiveProfile(bR, bR * 2.4), 26),
        solid ? MAT.solid() : MAT.tankDark(),
      );
      nose.position.y = bl;
      bg.add(nose);

      // solids have a single fixed nozzle; liquid boosters get a cluster
      const be = solid
        ? engineCluster(1, bR, 1.15)
        : engineCluster(s0.engines ?? 9, bR, 0.9);
      bg.add(be);
      parts.engineGlows.push(be.userData.glowMat);

      const bp = makePlume(bR * 0.88, bl);
      bp.position.y = -bR * 0.4;
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
      new THREE.CylinderGeometry(R * 0.99, R * 0.99, isLen, 40, 1), MAT.interstage());
    inter.position.y = isLen / 2;
    g.add(inter);

    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(R * 0.98, R * 0.98, li, 40, 1), MAT.tank());
    body.position.y = isLen + li / 2;
    g.add(body);

    const eng = engineCluster(st.engines ?? 1, R * 0.7, 1.25);
    eng.position.y = isLen * 0.15;
    g.add(eng);
    parts.engineGlows.push(eng.userData.glowMat);

    // A vacuum engine's plume is enormous; give it a long shell to grow into.
    const pl = makePlume(R * 0.55, li * 1.6);
    pl.position.y = isLen * 0.05;
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
      new THREE.LatheGeometry(ogiveProfile(R * 0.98, R * 3.1), 34), MAT.ship());
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
    // TWO HALVES, not one shell. A fairing is the most visible discrete event
    // of the whole ascent -- it splits along a vertical seam, hinges open and
    // tumbles away -- and drawing it as a single mesh that simply blinks out
    // throws that away. Each half is a half-revolution of the same ogive, so
    // together they are exactly the shell they replace.
    const fl = R * 3.4;
    const profile = ogiveProfile(R, fl);
    for (const sign of [1, -1]) {
      const hinge = new THREE.Group();
      const phiStart = sign > 0 ? 0 : Math.PI;
      const halfMesh = new THREE.Mesh(
        new THREE.LatheGeometry(profile, 20, phiStart, Math.PI), MAT.fairing());
      // A thin dark liner, so an open half reads as a shell rather than a
      // cardboard cut-out when you see its inside face.
      const liner = new THREE.Mesh(
        new THREE.LatheGeometry(profile, 20, phiStart, Math.PI),
        new THREE.MeshStandardMaterial({
          color: 0x2a2f36, roughness: 0.85, metalness: 0.1, side: THREE.BackSide,
        }));
      liner.scale.setScalar(0.985);
      hinge.add(halfMesh);
      hinge.add(liner);
      hinge.position.y = y;
      group.add(hinge);
      parts.fairingHalves.push({ group: hinge, sign, baseY: y, R });
    }
    y += fl;
  } else {
    const nose = new THREE.Mesh(
      new THREE.LatheGeometry(ogiveProfile(R * 0.9, R * 2.6), 30), MAT.fairing());
    nose.position.y = y;
    group.add(nose);
    y += R * 2.6;
  }

  // ---- transonic vapour cone ----------------------------------------------
  // Real, and one of the most recognisable things a rocket does. Going through
  // Mach 1 the flow accelerating over the shoulder of the vehicle drops below
  // the local dew point and a condensation collar flashes into existence, then
  // vanishes a few seconds later once the shock has moved aft. Driven by real
  // Mach number from the atmosphere model, not by a timer.
  const coneGeo = new THREE.ConeGeometry(R * 2.6, R * 3.2, 28, 1, true);
  coneGeo.translate(0, R * 1.6, 0);
  const cone = new THREE.Mesh(coneGeo, new THREE.MeshBasicMaterial({
    color: 0xdfeaf6, transparent: true, opacity: 0, depthWrite: false,
    side: THREE.DoubleSide, blending: THREE.NormalBlending,
  }));
  cone.visible = false;
  group.add(cone);
  parts.vapourCone = cone;

  // ---- separation cold-gas puffs -------------------------------------------
  // Pneumatic pushers and the upper stage's ullage thrusters, which is what
  // actually pushes the two halves apart at staging.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const puff = new THREE.Sprite(new THREE.SpriteMaterial({
      map: softDot(), color: 0xdce8f4, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    puff.position.set(Math.cos(a) * R * 1.05, sepY, Math.sin(a) * R * 1.05);
    puff.scale.setScalar(R * 1.2);
    group.add(puff);
    parts.sepPuffs.push(puff);
  }

  return { group, height: y, radius: R, parts, vehicle };
}

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Drive the vehicle's appearance from the flight state.
 *
 * @param {object} rocket  result of buildRocket
 * @param {object} s       {
 *   stageIndex, burning, ambientPressure, boostersAttached, fairingAttached,
 *   retro,          landing burn rather than ascent
 *   legDeploy,      0..1 how far the legs are out
 *   finDeflect,     0..1 how far the grid fins are flared
 *   throttle,       0..1, drives plume length and engine glow
 *   time            seconds, for the shock-diamond animation
 * }
 */
export function updateRocket(rocket, s) {
  const { parts } = rocket;
  const time = s.time ?? 0;
  const throttle = s.burning ? (s.throttle ?? 1) : 0;

  // Stages already dropped are hidden outright.
  parts.stages.forEach((g, i) => { g.visible = i >= s.stageIndex; });

  // --- recovery hardware --------------------------------------------------
  // Legs deploy for the landing burn and stay stowed the rest of the flight;
  // a booster that unfolded them on the way up would tear them off.
  const legT = Math.max(0, Math.min(1, s.legDeploy ?? 0));
  for (const leg of parts.legs) {
    // 0 = folded flat against the body, 1 = splayed out at 42 degrees.
    leg.rotation.z = lerp(0, -0.74, legT);
  }
  // Grid fins flare out once there is air to work with.
  const finT = Math.max(0, Math.min(1, s.finDeflect ?? 0));
  for (const fin of parts.gridFins) {
    fin.rotation.z = lerp(0, -0.55, finT);
  }

  // Plume length keys off ambient pressure: a nozzle exhausting into vacuum
  // has nothing to constrain the flow, so the plume balloons out to several
  // times its sea-level length. This is the most visible single cue that the
  // vehicle has left the atmosphere.
  const pRel = Math.max(0, Math.min(1, (s.ambientPressure ?? 0) / 101325));
  const spread = 1 + (1 - pRel) * 2.4;
  const flicker = 0.88 + Math.random() * 0.12;

  const drivePlume = (p, live, lengthScale, widthScale, gain) => {
    p.visible = live;
    if (!live) return;
    p.scale.set(widthScale, lengthScale, widthScale);
    for (const key of ['outer', 'core']) {
      const u = p.userData[key].uniforms;
      u.uOpacity.value = (key === 'core' ? 0.85 : 0.30) * gain * flicker;
      u.uPressure.value = pRel;
      u.uTime.value = time;
    }
    p.userData.flare.material.opacity = 0.55 * gain * flicker;
    p.userData.flare.scale.setScalar(p.userData.radius * (2.6 + 1.6 * throttle));
  };

  parts.plumes.forEach((p, i) => {
    const live = s.burning && i === s.stageIndex && !s.retro;
    drivePlume(p, live, spread * (0.55 + 0.45 * throttle),
      1 + (spread - 1) * 0.35, 0.6 + 0.4 * throttle);
  });

  if (parts.retroPlume) {
    drivePlume(parts.retroPlume, !!(s.retro && s.burning),
      spread * (0.4 + 0.6 * throttle) * 1.2, 1 + (spread - 1) * 0.25,
      0.55 + 0.45 * throttle);
  }

  const boostersLive = s.burning && s.boostersAttached && s.stageIndex === 0;
  parts.boosters.forEach((b) => { b.visible = !!s.boostersAttached; });
  parts.boosterPlumes.forEach((p) => {
    drivePlume(p, boostersLive, spread * 0.9, 1 + (spread - 1) * 0.3, 0.85);
  });

  // --- fairing jettison ---------------------------------------------------
  // The halves hinge outward about the base seam, then translate clear and
  // drop away. Real ones do exactly this: pyrotechnic seam, pneumatic push,
  // rotate about the aft hinge, release.
  const fs = Math.max(0, Math.min(1, s.fairingSep ?? 0));
  for (const h of parts.fairingHalves) {
    h.group.visible = fs < 0.99;
    if (!h.group.visible) continue;
    const open = Math.min(1, fs * 2.2);          // hinge fast, then let go
    h.group.rotation.x = -h.sign * open * 1.15;
    h.group.position.z = h.sign * fs * fs * h.R * 14;
    h.group.position.y = h.baseY - fs * fs * h.R * 9;
  }
  if (parts.fairing) parts.fairing.visible = !!s.fairingAttached;

  // --- transonic condensation collar --------------------------------------
  // Peaks right at Mach 1 and is gone by Mach 1.3.
  if (parts.vapourCone) {
    const M = s.mach ?? 0;
    const band = Math.max(0, 1 - Math.abs(M - 1.0) / 0.28);
    // It also needs air to condense out of; there is none above ~25 km.
    const air = Math.min(1, pRel * 6);
    const v = band * air;
    parts.vapourCone.visible = v > 0.02;
    if (parts.vapourCone.visible) {
      parts.vapourCone.material.opacity = 0.42 * v;
      // The collar slides aft as the shock moves back over the vehicle.
      parts.vapourCone.position.y = rocket.height * (0.30 + 0.34 * Math.min(M, 1.4));
      parts.vapourCone.scale.setScalar(0.85 + 0.3 * v);
    }
  }

  // --- staging pushers ----------------------------------------------------
  const sf = Math.max(0, Math.min(1, s.sepFlash ?? 0));
  for (const puff of parts.sepPuffs) {
    puff.material.opacity = 0.85 * sf * (0.7 + 0.3 * Math.random());
    puff.scale.setScalar(rocket.radius * (1.0 + 5.0 * (1 - sf)));
  }

  // Bell interiors glow with throttle, and keep glowing briefly after cutoff
  // because the hardware is still hot.
  for (const g of parts.engineGlows) {
    g.opacity = 0.85 * throttle * flicker;
  }
}

/** Free every geometry and material the vehicle owns. */
export function disposeRocket(rocket) {
  const seen = new Set();
  rocket.group.traverse((o) => {
    if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (m && !seen.has(m)) { seen.add(m); m.dispose(); }
    }
  });
}
