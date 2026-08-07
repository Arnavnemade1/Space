/**
 * Procedural orbital datacenter geometry.
 *
 * Every dimension comes from the design the engine sized. The radiator panels
 * really do add up to `design.thermal.area`; the array wings really do add up
 * to `design.power.array.area`. Change the orbit and the eclipse fraction
 * changes, which changes the array area, and the vehicle on screen grows.
 *
 * The layout is the one this problem forces: a long truss with the arrays at
 * the ends and the radiators perpendicular to them in the middle. Radiators
 * must stay edge-on to the Sun while arrays stay face-on, and those two
 * requirements are 90 degrees apart -- which is exactly why the ISS looks the
 * way it does, and why anything of this kind ends up looking similar.
 *
 * The station is also lit for where it actually is in its orbit. Roughly a
 * third of every ninety minutes is spent inside Earth's shadow, and a
 * structure that stays evenly lit through that is the clearest possible tell
 * that nothing here is real. See `updateStation`'s `lit` input.
 *
 * Modelled in METRES; the caller scales the group into scene units.
 */

import * as THREE from 'three';

const RADIATOR_PANELS = 8;
const ARRAY_WINGS = 4;

/** Wing dimensions for a given total area and aspect ratio. */
function wingDims(totalArea, count, aspect) {
  const each = Math.max(totalArea, 1) / count;
  const width = Math.sqrt(each / aspect);
  return { width, length: width * aspect };
}

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

let CELL_TEX = null;
/**
 * Solar cell grid.
 *
 * A wing is not a painted sheet, it is thousands of individual cells with
 * interconnects between them, and at any range where the wing is more than a
 * few pixels the grid is the first thing you see. Without it the arrays read
 * as coloured card.
 */
function cellTexture() {
  if (CELL_TEX) return CELL_TEX;
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#1b1207';
  g.fillRect(0, 0, 256, 128);
  // Cells, slightly irregular in brightness so it does not moire.
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 16; x++) {
      const v = 0.78 + Math.random() * 0.22;
      g.fillStyle = `rgb(${Math.round(150 * v)}, ${Math.round(104 * v)}, ${Math.round(38 * v)})`;
      g.fillRect(x * 16 + 1.2, y * 16 + 1.2, 13.6, 13.6);
    }
  }
  // Interconnect busbars.
  g.strokeStyle = 'rgba(24,17,8,0.95)';
  g.lineWidth = 1.6;
  for (let x = 0; x <= 16; x++) { g.beginPath(); g.moveTo(x * 16, 0); g.lineTo(x * 16, 128); g.stroke(); }
  for (let y = 0; y <= 8; y++) { g.beginPath(); g.moveTo(0, y * 16); g.lineTo(256, y * 16); g.stroke(); }
  CELL_TEX = new THREE.CanvasTexture(c);
  CELL_TEX.colorSpace = THREE.SRGBColorSpace;
  CELL_TEX.wrapS = CELL_TEX.wrapT = THREE.RepeatWrapping;
  return CELL_TEX;
}

let RAD_TEX = null;
/** Radiator face: subpanel seams and the coolant header running the length. */
function radiatorTexture() {
  if (RAD_TEX) return RAD_TEX;
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#eef2f7';
  g.fillRect(0, 0, 256, 64);
  // Subpanel seams across the span -- real radiators are a stack of these.
  g.strokeStyle = 'rgba(120,134,150,0.55)';
  g.lineWidth = 2;
  for (let i = 1; i < 8; i++) {
    g.beginPath(); g.moveTo(i * 32, 0); g.lineTo(i * 32, 64); g.stroke();
  }
  // Coolant header along the root edge.
  g.fillStyle = 'rgba(150,162,176,0.75)';
  g.fillRect(0, 0, 256, 5);
  g.fillStyle = 'rgba(196,206,218,0.5)';
  g.fillRect(0, 59, 256, 5);
  RAD_TEX = new THREE.CanvasTexture(c);
  RAD_TEX.colorSpace = THREE.SRGBColorSpace;
  return RAD_TEX;
}

let MLI_TEX = null;
/** Multi-layer insulation: quilted foil, the standard skin of a pressure module. */
function mliTexture() {
  if (MLI_TEX) return MLI_TEX;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#cfd6de';
  g.fillRect(0, 0, 128, 128);
  // Tie-down quilting.
  g.strokeStyle = 'rgba(120,132,148,0.42)';
  g.lineWidth = 1.4;
  for (let i = 0; i <= 8; i++) {
    g.beginPath(); g.moveTo(i * 16, 0); g.lineTo(i * 16, 128); g.stroke();
    g.beginPath(); g.moveTo(0, i * 16); g.lineTo(128, i * 16); g.stroke();
  }
  // A few darker service panels.
  g.fillStyle = 'rgba(88,98,112,0.5)';
  g.fillRect(16, 40, 30, 18);
  g.fillRect(78, 82, 24, 14);
  MLI_TEX = new THREE.CanvasTexture(c);
  MLI_TEX.colorSpace = THREE.SRGBColorSpace;
  MLI_TEX.wrapS = MLI_TEX.wrapT = THREE.RepeatWrapping;
  return MLI_TEX;
}

let GLOW_TEX = null;
function glowTexture() {
  if (GLOW_TEX) return GLOW_TEX;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.3, 'rgba(255,255,255,0.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  GLOW_TEX = new THREE.CanvasTexture(c);
  GLOW_TEX.colorSpace = THREE.SRGBColorSpace;
  return GLOW_TEX;
}

/**
 * Build a station for a design.
 *
 * @param {object} design result of designDatacenter()
 * @param {number} flights number of delivery flights (sets module count)
 */
export function buildStation(design, flights = 4) {
  const group = new THREE.Group();
  const parts = {
    radiators: [], arrays: [], modules: [], truss: null, battery: null,
    lights: [], navLights: [], tug: null, litMaterials: [],
  };

  const radArea = Number.isFinite(design.thermal.area) ? design.thermal.area : 5000;
  const arrArea = design.power.array.area;

  const rad = wingDims(radArea, RADIATOR_PANELS, 3.0);
  const arr = wingDims(arrArea, ARRAY_WINGS, 4.0);

  // The truss has to be long enough to hold the array wings apart and give the
  // radiators somewhere to hang, so its length follows from them.
  const trussLen = Math.max(arr.length * 1.05, rad.length * 2.4);
  const trussR = Math.max(2.2, trussLen * 0.012);

  // Compute-module dimensions up front: the radiators have to be told how far
  // to stand off so their inner edge clears the module grid slung under the
  // truss, and since the panels hang along +/-Y they run straight through that
  // grid otherwise.
  const modR = Math.max(3.2, trussR * 2.2);
  const modL = modR * 3.0;
  const modDrop = trussR + modR * 1.35;

  /** Register a material so eclipse lighting can drive it. */
  const lit = (m, base = null) => {
    m.userData.baseColor = (base ? new THREE.Color(base) : m.color.clone());
    parts.litMaterials.push(m);
    return m;
  };

  // ---- truss spine (along X) ---------------------------------------------
  //
  // An actual lattice, not a tube. A truss is the one structure in orbit whose
  // whole point is visible: it is open because mass is expensive and stiffness
  // is not, and drawing it solid throws away the single most recognisable
  // silhouette in spaceflight.
  const steel = lit(new THREE.MeshStandardMaterial({
    color: 0x9aa5b2, metalness: 0.78, roughness: 0.38,
  }));
  const truss = new THREE.Group();
  const longeronR = trussR * 0.16;
  const bayLen = trussR * 2.4;
  const bays = Math.max(6, Math.min(26, Math.round(trussLen / bayLen)));
  const corner = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

  for (const [cy, cz] of corner) {
    const l = new THREE.Mesh(
      new THREE.CylinderGeometry(longeronR, longeronR, trussLen, 6), steel);
    l.rotation.z = Math.PI / 2;
    l.position.set(0, cy * trussR, cz * trussR);
    truss.add(l);
  }
  const battenGeo = new THREE.CylinderGeometry(longeronR * 0.7, longeronR * 0.7, trussR * 2, 5);
  const diagLen = Math.hypot(trussLen / bays, trussR * 2);
  const diagGeo = new THREE.CylinderGeometry(longeronR * 0.55, longeronR * 0.55, diagLen, 5);
  for (let i = 0; i <= bays; i++) {
    const x = -trussLen / 2 + (i / bays) * trussLen;
    // Square battens closing each bay.
    for (const [ay, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const b = new THREE.Mesh(battenGeo, steel);
      if (ay) { b.rotation.x = Math.PI / 2; b.position.set(x, ay * trussR, 0); }
      else { b.position.set(x, 0, az * trussR); }
      truss.add(b);
    }
    // Diagonals, alternating sense bay to bay -- the bracing that makes a
    // lattice stiff in shear rather than just in bending.
    if (i < bays) {
      const dx = trussLen / bays;
      const sgn = i % 2 ? 1 : -1;
      for (const [ay, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const d = new THREE.Mesh(diagGeo, steel);
        d.position.set(x + dx / 2, ay * trussR, az * trussR);
        const ang = Math.atan2(trussR * 2, dx) * sgn;
        if (ay) d.rotation.set(Math.PI / 2, 0, Math.PI / 2 - ang);
        else d.rotation.set(0, 0, Math.PI / 2 - ang);
        truss.add(d);
      }
    }
  }
  group.add(truss);
  parts.truss = truss;

  // ---- radiator panels ----------------------------------------------------
  const radMat = lit(new THREE.MeshStandardMaterial({
    map: radiatorTexture(),
    color: 0xf0f4f8, metalness: 0.10, roughness: 0.60,
    emissive: 0x000000, side: THREE.DoubleSide,
  }), 0xf0f4f8);
  const radGeo = new THREE.PlaneGeometry(rad.length, rad.width);

  // A PlaneGeometry lies in its own XY plane with the normal on +Z. Composing
  // Euler angles to reorient it is guesswork that is easy to get subtly wrong,
  // so the target basis is stated outright: the panel's long axis points away
  // from the truss (+Y), its width runs along the truss (+X), and its face
  // normal ends up on +Z.
  //
  // That normal is the point of the whole arrangement. Both the arrays and the
  // radiators rotate about the truss axis, so both normals live in the Y-Z
  // plane -- and they have to be NINETY DEGREES APART, because the arrays want
  // to face the Sun and the radiators want to be edge-on to it. Building them
  // with the same normal (which an earlier version did) is not a cosmetic
  // slip: it means the radiators are being pointed straight at the Sun, which
  // is the one attitude in which they cannot reject heat.
  const radBasis = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(0, 1, 0),   // local X (length)  -> world Y
    new THREE.Vector3(1, 0, 0),   // local Y (width)   -> world X
    new THREE.Vector3(0, 0, 1),   // local Z (normal)  -> world Z
  );

  const perSide = RADIATOR_PANELS / 2;
  for (let side = 0; side < 2; side++) {
    for (let i = 0; i < perSide; i++) {
      const wrap = new THREE.Group();
      const p = new THREE.Mesh(radGeo, radMat.clone());
      p.material.userData.baseColor = new THREE.Color(0xf0f4f8);
      parts.litMaterials.push(p.material);
      p.quaternion.setFromRotationMatrix(radBasis);
      const spread = (i - (perSide - 1) / 2) * rad.width * 1.35;
      const dir = side ? 1 : -1;
      p.position.set(spread, dir * (rad.length / 2 + modDrop + modR * 1.1), 0);
      wrap.add(p);
      // Deployment boom the panel slides out along.
      const boom = new THREE.Mesh(
        new THREE.CylinderGeometry(longeronR * 0.8, longeronR * 0.8, modDrop + modR * 1.1, 5), steel);
      boom.position.set(spread, dir * (modDrop + modR * 1.1) / 2, 0);
      wrap.add(boom);
      group.add(wrap);
      parts.radiators.push({ mesh: p, wrap, dir, spread, len: rad.length });
    }
  }

  // ---- solar array wings ---------------------------------------------------
  const cell = cellTexture();
  const cellMat = lit(new THREE.MeshStandardMaterial({
    map: cell,
    color: 0xffffff, metalness: 0.30, roughness: 0.52,
    emissive: 0x120a02, emissiveIntensity: 0.5, side: THREE.DoubleSide,
  }), 0xffffff);
  const arrGeo = new THREE.PlaneGeometry(arr.length, arr.width);
  for (let end = 0; end < 2; end++) {
    for (let k = 0; k < ARRAY_WINGS / 2; k++) {
      const m = cellMat.clone();
      m.map = cell.clone();
      m.map.needsUpdate = true;
      m.map.repeat.set(Math.max(2, Math.round(arr.length / 12)), Math.max(1, Math.round(arr.width / 12)));
      m.userData.baseColor = new THREE.Color(0xffffff);
      parts.litMaterials.push(m);
      const w = new THREE.Mesh(arrGeo, m);
      const x = (end ? 1 : -1) * (trussLen / 2);
      const off = (k - (ARRAY_WINGS / 2 - 1) / 2) * arr.width * 1.25;
      // Face-on to the Sun: normal along Y, long axis along X.
      w.rotation.x = -Math.PI / 2;
      w.position.set(x + (end ? 1 : -1) * arr.length / 2, 0, off);
      group.add(w);

      // Blanket box at the root: the canister the wing unrolls out of.
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(arr.width * 0.18, arr.width * 0.22, arr.width * 1.02), steel);
      box.position.set(x, 0, off);
      group.add(box);

      parts.arrays.push({ mesh: w, x, end, len: arr.length, box });
    }
  }

  // ---- compute modules, laid out as a grid --------------------------------
  //
  // Each flight delivers one module and it berths onto the grid. Laying them
  // out in rows rather than a single line is what a real assembly does: a
  // hundred-metre string of modules on one axis has no structural depth and
  // every module is a cantilever off its neighbour, whereas a grid ties back
  // into the truss on two axes.
  const mli = mliTexture();
  const modMat = lit(new THREE.MeshStandardMaterial({
    map: mli, color: 0xffffff, metalness: 0.34, roughness: 0.56,
  }), 0xffffff);
  const ringMat = lit(new THREE.MeshStandardMaterial({
    color: 0x5c6875, metalness: 0.7, roughness: 0.5,
  }));

  const cols = Math.max(1, Math.ceil(Math.sqrt(flights)));
  const rows = Math.ceil(flights / cols);
  const pitchX = modL * 1.18;
  const pitchZ = modR * 2.6;

  const bodyGeo = new THREE.CylinderGeometry(modR, modR, modL, 18, 1);
  const capGeo = new THREE.SphereGeometry(modR, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  const dockGeo = new THREE.CylinderGeometry(modR * 0.34, modR * 0.34, modR * 0.16, 12);
  const radStripGeo = new THREE.BoxGeometry(modL * 0.8, modR * 0.03, modR * 0.5);

  for (let i = 0; i < flights; i++) {
    const cx = i % cols;
    const cz = Math.floor(i / cols);
    const m = new THREE.Group();

    const mm = modMat.clone();
    mm.map = mli.clone();
    mm.map.needsUpdate = true;
    mm.map.repeat.set(3, 1);
    mm.userData.baseColor = new THREE.Color(0xffffff);
    parts.litMaterials.push(mm);

    const body = new THREE.Mesh(bodyGeo, mm);
    body.rotation.z = Math.PI / 2;
    m.add(body);
    for (const s of [-1, 1]) {
      const cap = new THREE.Mesh(capGeo, mm);
      cap.rotation.z = s * Math.PI / 2;
      cap.position.x = s * modL / 2;
      m.add(cap);
      const dock = new THREE.Mesh(dockGeo, ringMat);
      dock.rotation.z = Math.PI / 2;
      dock.position.x = s * (modL / 2 + modR * 0.08);
      m.add(dock);
    }
    // Body-mounted heat-rejection strips: the low-grade radiators every
    // pressurised module carries in addition to the main array.
    for (const s of [-1, 1]) {
      const strip = new THREE.Mesh(radStripGeo, radMat.clone());
      strip.material.userData.baseColor = new THREE.Color(0xf0f4f8);
      parts.litMaterials.push(strip.material);
      strip.position.set(0, s * modR * 0.99, 0);
      m.add(strip);
    }

    m.position.set(
      (cx - (cols - 1) / 2) * pitchX,
      -modDrop,
      (cz - (rows - 1) / 2) * pitchZ,
    );
    // Where it flies in from during assembly, and where it ends up.
    m.userData.home = m.position.clone();
    m.userData.approach = m.position.clone().add(
      new THREE.Vector3(0, -trussLen * 0.35, trussLen * 0.22));
    group.add(m);
    parts.modules.push(m);

    // Connecting spine between modules in a row.
    if (cx > 0) {
      const link = new THREE.Mesh(
        new THREE.CylinderGeometry(modR * 0.16, modR * 0.16, pitchX - modL, 6),
        ringMat);
      link.rotation.z = Math.PI / 2;
      link.position.set(m.position.x - pitchX / 2, m.position.y, m.position.z);
      group.add(link);
      parts.links = parts.links || [];
      parts.links.push({ mesh: link, index: i });
    }
  }
  parts.gridShape = { cols, rows };

  // ---- delivery tug --------------------------------------------------------
  // What actually flies a module up from the injection orbit and berths it.
  // Without one, modules simply materialise and drift into place, and the
  // "29 flights over 29 months" in the results panel has nothing on screen
  // corresponding to it.
  {
    const tug = new THREE.Group();
    const tr = modR * 0.55;
    const bus = new THREE.Mesh(
      new THREE.CylinderGeometry(tr, tr, tr * 2.4, 12), steel);
    bus.rotation.z = Math.PI / 2;
    tug.add(bus);
    const nozzle = new THREE.Mesh(
      new THREE.ConeGeometry(tr * 0.5, tr * 0.9, 10, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x39414c, metalness: 0.85, roughness: 0.3 }));
    nozzle.rotation.z = -Math.PI / 2;
    nozzle.position.x = tr * 1.6;
    tug.add(nozzle);
    for (const s of [-1, 1]) {
      const panel = new THREE.Mesh(
        new THREE.PlaneGeometry(tr * 2.2, tr * 0.9), cellMat.clone());
      panel.material.userData.baseColor = new THREE.Color(0xffffff);
      parts.litMaterials.push(panel.material);
      panel.rotation.x = -Math.PI / 2;
      panel.position.set(0, 0, s * tr * 1.8);
      tug.add(panel);
    }
    // Station-keeping thruster flare, lit while it is manoeuvring.
    const flare = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), color: 0x9fd8ff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    flare.scale.setScalar(tr * 2.6);
    flare.position.x = tr * 2.4;
    tug.add(flare);
    tug.visible = false;
    tug.userData.flare = flare;
    group.add(tug);
    parts.tug = tug;
  }

  // ---- running lights ------------------------------------------------------
  // On in eclipse, off in daylight. Every crewed or berthing-capable structure
  // carries them, and in shadow they are the only thing you can see.
  const addLight = (pos, color, size, blink = 0) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), color, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    s.position.copy(pos);
    s.scale.setScalar(size);
    s.userData.blink = blink;
    group.add(s);
    parts.lights.push(s);
    return s;
  };
  // Sized as a glow, not as a lamp. A navigation light is a point source, and
  // every optical system spreads a point source over far more area than its
  // physical aperture -- which is exactly why they are useful markers. Drawn at
  // true lamp size it would be two pixels and invisible.
  const lightSize = Math.max(modR * 2.0, 6);
  addLight(new THREE.Vector3(-trussLen / 2, trussR * 1.4, 0), 0xff4d4d, lightSize, 1.0);
  addLight(new THREE.Vector3(trussLen / 2, trussR * 1.4, 0), 0x4dff7a, lightSize, 1.0);
  addLight(new THREE.Vector3(0, trussR * 1.6, 0), 0xffffff, lightSize * 0.8, 0.0);
  for (let i = 0; i < 4; i++) {
    const x = (-0.35 + 0.233 * i) * trussLen;
    addLight(new THREE.Vector3(x, -modDrop - modR * 1.05, 0), 0xfff0c8, lightSize * 0.55, 0.0);
  }

  // ---- battery pack, only where there are eclipses -------------------------
  if (design.mass.battery > 0) {
    const bh = Math.cbrt(design.mass.battery / 400);
    const b = new THREE.Mesh(
      new THREE.BoxGeometry(bh * 2.4, bh, bh),
      lit(new THREE.MeshStandardMaterial({ color: 0x4a5260, metalness: 0.6, roughness: 0.5 })));
    b.position.set(0, trussR * 3.2, 0);
    group.add(b);
    parts.battery = b;
  }

  return {
    group, parts,
    dims: { trussLen, rad, arr, radArea, arrArea, modR, modL },
    span: trussLen + arr.length * 2,
  };
}

/**
 * Drive the station's appearance from the projection state.
 *
 * @param {object} station result of buildStation
 * @param {object} s {
 *   assembly   0..1 fraction of modules commissioned
 *   thermal    0..1 remaining radiator margin
 *   array      0..1 remaining array output
 *   dose       0..1 remaining radiation health
 *   lit        0..1 fraction of the solar disk visible (1 full sun, 0 umbra)
 *   time       seconds, for blinking
 * }
 */
const smoothstep = (t) => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};

export function updateStation(station, s) {
  const { parts } = station;
  const asm = Math.max(0, Math.min(1, s.assembly ?? 1));
  const time = s.time ?? 0;

  // --- eclipse -------------------------------------------------------------
  // In umbra the only illumination is earthshine, which is real, weak and
  // distinctly blue. The floor is not zero because a structure in Earth's
  // shadow over the daylit hemisphere is still faintly visible.
  const sun = Math.max(0, Math.min(1, s.lit ?? 1));
  // Not black. A structure in Earth's shadow is still lit by the planet -- the
  // full daylit disk fills a third of its sky and returns roughly a hundredth
  // of the direct solar flux -- and it carries its own floodlights besides.
  // Night-pass photographs of the ISS show the trusses perfectly legible.
  const shade = 0.20 + 0.80 * sun;
  const earthshine = (1 - sun) * 0.20;
  for (const m of parts.litMaterials) {
    const base = m.userData.baseColor;
    if (!base) continue;
    m.color.setRGB(
      base.r * shade + earthshine * 0.35,
      base.g * shade + earthshine * 0.55,
      base.b * shade + earthshine * 1.0,
    );
  }

  // Modules appear as their flights are commissioned, and the one currently
  // arriving flies in along its approach path rather than popping into place.
  const exact = asm * parts.modules.length;
  const live = Math.floor(exact);
  const arriving = exact - live;
  parts.modules.forEach((m, i) => {
    m.visible = i < live || (i === live && arriving > 0.02);
    if (!m.visible) return;
    if (i === live) {
      // Berthing: ease from the approach point onto the grid.
      const f = smoothstep(arriving);
      m.position.lerpVectors(m.userData.approach, m.userData.home, f);
    } else {
      m.position.copy(m.userData.home);
    }
  });
  for (const l of parts.links ?? []) l.mesh.visible = l.index < live;

  // Dose damage shows as the compute modules going dark and cold. Applied on
  // top of the eclipse term rather than instead of it.
  const dose = s.dose ?? 1;
  if (dose < 0.999) {
    parts.modules.forEach((m) => {
      if (!m.visible) return;
      m.traverse((o) => {
        if (o.isMesh && o.material?.userData?.baseColor) {
          o.material.color.multiplyScalar(0.55 + 0.45 * dose);
        }
      });
    });
  }

  // --- delivery tug --------------------------------------------------------
  // Rides in with whichever module is currently berthing and pulls away once
  // it is home.
  if (parts.tug) {
    const inTransit = asm < 0.999 && arriving > 0.02 && live < parts.modules.length;
    parts.tug.visible = inTransit;
    if (inTransit) {
      const m = parts.modules[live];
      const f = smoothstep(arriving);
      const dir = m.userData.home.clone().sub(m.userData.approach).normalize();
      // Ahead of the module on approach, then peeling off after berthing.
      const lead = station.dims.modL * (0.75 + 2.6 * Math.max(0, f - 0.75));
      parts.tug.position.copy(m.position).add(dir.multiplyScalar(-lead));
      parts.tug.lookAt(m.position);
      parts.tug.rotateY(Math.PI / 2);
      parts.tug.userData.flare.material.opacity = 0.8 * (1 - Math.abs(f - 0.5) * 2) * (0.6 + 0.4 * Math.random());
    }
  }

  // Radiators deploy progressively and change colour with thermal margin:
  // white while they are coping, amber as margin erodes, glowing red once they
  // cannot reject the heat the computers are making. The emissive term is not
  // scaled by the eclipse -- a radiator running hot glows in shadow too, and
  // in fact that is the only time you would clearly see it.
  const th = Math.max(0, Math.min(1, s.thermal ?? 1));
  const radLive = Math.ceil(asm * parts.radiators.length);
  parts.radiators.forEach((p, i) => {
    const on = i < radLive;
    p.wrap.visible = on;
    if (!on) return;
    const m = p.mesh.material;
    if (th > 0.75) {
      m.emissive.setHex(0x000000);
      m.emissiveIntensity = 0;
    } else {
      const t = 1 - th / 0.75;
      m.color.multiply(new THREE.Color(1.0, 1.0 - 0.42 * t, 1.0 - 0.78 * t));
      m.emissive.setRGB(0.95 * t, 0.22 * t, 0.05 * t);
      m.emissiveIntensity = 1.9 * t;
    }
  });

  // Arrays unfurl from the truss ends, then dim as their cells degrade.
  const a = Math.max(0, Math.min(1, s.array ?? 1));
  parts.arrays.forEach((w, i) => {
    const per = 1 / parts.arrays.length;
    const f = Math.max(0, Math.min(1, (asm - i * per * 0.6) / (per * 1.6)));
    w.mesh.visible = f > 0.01;
    if (w.box) w.box.visible = asm > 0.02;
    w.mesh.scale.x = f;
    // keep the inboard edge attached to the truss while it extends
    w.mesh.position.x = w.x + (w.end ? 1 : -1) * (w.len * f) / 2;
    w.mesh.material.emissiveIntensity = (0.10 + 0.35 * a) * sun;
    w.mesh.material.color.multiplyScalar(0.55 + 0.45 * a);
  });

  // --- running lights ------------------------------------------------------
  const night = 1 - smoothstep(sun * 3);
  parts.lights.forEach((l, i) => {
    const on = asm > 0.05;
    l.visible = on && night > 0.02;
    if (!l.visible) return;
    const b = l.userData.blink > 0
      ? (Math.sin(time * 1.6 + i * 2.1) > 0.55 ? 1 : 0.06)
      : 1;
    l.material.opacity = 1.0 * night * b;
  });

  if (parts.battery) parts.battery.visible = asm > 0.25;
}

export function disposeStation(station) {
  const seen = new Set();
  station.group.traverse((o) => {
    if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) if (m && !seen.has(m)) { seen.add(m); m.dispose(); }
  });
}
