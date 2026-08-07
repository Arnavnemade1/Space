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

/**
 * Build a station for a design.
 *
 * @param {object} design result of designDatacenter()
 * @param {number} flights number of delivery flights (sets module count)
 */
export function buildStation(design, flights = 4) {
  const group = new THREE.Group();
  const parts = { radiators: [], arrays: [], modules: [], truss: null, battery: null };

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
  // truss, and now that the panels hang along +/-Y they run straight through
  // that grid otherwise.
  const modR = Math.max(3.2, trussR * 2.2);
  const modL = modR * 3.0;
  const modDrop = trussR + modR * 1.35;

  // ---- truss spine (along X) ---------------------------------------------
  const trussMat = new THREE.MeshStandardMaterial({
    color: 0x8b98a6, metalness: 0.75, roughness: 0.45,
  });
  const truss = new THREE.Mesh(
    new THREE.CylinderGeometry(trussR, trussR, trussLen, 12, 1), trussMat);
  truss.rotation.z = Math.PI / 2;
  group.add(truss);
  parts.truss = truss;

  // Truss bracing rings, purely so the scale reads at close range.
  const ringMat = new THREE.MeshStandardMaterial({
    color: 0x5c6875, metalness: 0.7, roughness: 0.5,
  });
  const nRings = Math.max(6, Math.round(trussLen / 24));
  for (let i = 0; i <= nRings; i++) {
    const r = new THREE.Mesh(
      new THREE.TorusGeometry(trussR * 1.5, trussR * 0.14, 6, 14), ringMat);
    r.position.x = -trussLen / 2 + (i / nRings) * trussLen;
    r.rotation.y = Math.PI / 2;
    group.add(r);
  }

  // ---- radiator panels ----------------------------------------------------
  // Held edge-on to the Sun: their normal is along Z, in the orbit plane.
  const radMat = new THREE.MeshStandardMaterial({
    color: 0xf0f4f8, metalness: 0.12, roughness: 0.62,
    emissive: 0x000000, side: THREE.DoubleSide,
  });
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
      const p = new THREE.Mesh(radGeo, radMat.clone());
      p.quaternion.setFromRotationMatrix(radBasis);
      const spread = (i - (perSide - 1) / 2) * rad.width * 1.35;
      p.position.set(spread, (side ? 1 : -1) * (rad.length / 2 + modDrop + modR * 1.1), 0);
      group.add(p);
      parts.radiators.push(p);
    }
  }

  // ---- solar array wings ---------------------------------------------------
  // Amber rather than blue. Photovoltaic cells are close to black, but the
  // Kapton substrate and the adhesive behind them are not, and every array
  // ever photographed in orbit -- ISS, Hubble, Landsat -- reads as warm gold
  // against space for exactly that reason. Pure cell colour renders the wings
  // invisible, which is both uglier and less true to what a camera sees.
  const cellMat = new THREE.MeshStandardMaterial({
    color: 0xa87c42, metalness: 0.42, roughness: 0.46,
    emissive: 0x2a1c08, emissiveIntensity: 0.8, side: THREE.DoubleSide,
  });
  const arrGeo = new THREE.PlaneGeometry(arr.length, arr.width);
  for (let end = 0; end < 2; end++) {
    for (let k = 0; k < ARRAY_WINGS / 2; k++) {
      const w = new THREE.Mesh(arrGeo, cellMat.clone());
      const x = (end ? 1 : -1) * (trussLen / 2);
      const off = (k - (ARRAY_WINGS / 2 - 1) / 2) * arr.width * 1.25;
      // Face-on to the Sun: normal along Y, long axis along X.
      w.rotation.x = -Math.PI / 2;
      w.position.set(x + (end ? 1 : -1) * arr.length / 2, 0, off);
      group.add(w);
      parts.arrays.push({ mesh: w, x, end, len: arr.length });
    }
  }

  // ---- compute modules, laid out as a grid --------------------------------
  //
  // Each flight delivers one module and it berths onto the grid. Laying them
  // out in rows rather than a single line is what a real assembly does: a
  // hundred-metre string of modules on one axis has no structural depth and
  // every module is a cantilever off its neighbour, whereas a grid ties back
  // into the truss on two axes.
  const modMat = new THREE.MeshStandardMaterial({
    color: 0xc4ced8, metalness: 0.5, roughness: 0.4,
  });
  const cols = Math.max(1, Math.ceil(Math.sqrt(flights)));
  const rows = Math.ceil(flights / cols);
  const pitchX = modL * 1.18;
  const pitchZ = modR * 2.6;

  for (let i = 0; i < flights; i++) {
    const cx = i % cols;
    const cz = Math.floor(i / cols);
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(modR, modR, modL, 14, 1), modMat.clone());
    m.rotation.z = Math.PI / 2;
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

  // ---- battery pack, only where there are eclipses -------------------------
  if (design.mass.battery > 0) {
    const bh = Math.cbrt(design.mass.battery / 400);
    const b = new THREE.Mesh(
      new THREE.BoxGeometry(bh * 2.4, bh, bh),
      new THREE.MeshStandardMaterial({ color: 0x4a5260, metalness: 0.6, roughness: 0.5 }));
    b.position.set(0, trussR * 3.2, 0);
    group.add(b);
    parts.battery = b;
  }

  return {
    group, parts,
    dims: { trussLen, rad, arr, radArea, arrArea },
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
 *   sunDir     THREE.Vector3 in the station's local frame (optional)
 * }
 */
const smoothstep = (t) => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};

export function updateStation(station, s) {
  const { parts } = station;
  const asm = Math.max(0, Math.min(1, s.assembly ?? 1));

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
    // Dose damage shows as the compute modules going dark and cold.
    const d = s.dose ?? 1;
    m.material.color.setRGB(0.77 * d + 0.18, 0.81 * d + 0.14, 0.85 * d + 0.12);
  });
  for (const l of parts.links ?? []) l.mesh.visible = l.index < live;

  // Radiators deploy progressively and change colour with thermal margin:
  // white while they are coping, amber as margin erodes, glowing red once they
  // cannot reject the heat the computers are making.
  const th = Math.max(0, Math.min(1, s.thermal ?? 1));
  const radLive = Math.ceil(asm * parts.radiators.length);
  parts.radiators.forEach((p, i) => {
    p.visible = i < radLive;
    if (!p.visible) return;
    const m = p.material;
    if (th > 0.75) {
      m.color.setHex(0xf0f4f8);
      m.emissive.setHex(0x000000);
      m.emissiveIntensity = 0;
    } else {
      const t = 1 - th / 0.75;
      m.color.setRGB(0.94, 0.94 - 0.44 * t, 0.97 - 0.78 * t);
      m.emissive.setRGB(0.85 * t, 0.20 * t, 0.05 * t);
      m.emissiveIntensity = 1.6 * t;
    }
  });

  // Arrays unfurl from the truss ends, then dim as their cells degrade.
  const a = Math.max(0, Math.min(1, s.array ?? 1));
  parts.arrays.forEach((w, i) => {
    const per = 1 / parts.arrays.length;
    const f = Math.max(0, Math.min(1, (asm - i * per * 0.6) / (per * 1.6)));
    w.mesh.visible = f > 0.01;
    w.mesh.scale.x = f;
    // keep the inboard edge attached to the truss while it extends
    w.mesh.position.x = w.x + (w.end ? 1 : -1) * (w.len * f) / 2;
    // Cells darken and lose contrast as they take displacement damage, so the
    // wings dull toward brown rather than changing hue. Values are LINEAR --
    // Color.setRGB writes the working (linear) space, unlike setHex.
    const g = 0.52 + 0.48 * a;
    w.mesh.material.emissiveIntensity = 0.18 + 0.5 * a;
    w.mesh.material.color.setRGB(0.560 * g, 0.300 * g, 0.075 * g);
  });

  if (parts.battery) parts.battery.visible = asm > 0.25;
}

export function disposeStation(station) {
  station.group.traverse((o) => {
    o.geometry?.dispose?.();
    if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
    else o.material?.dispose?.();
  });
}
