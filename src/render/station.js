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
  // from the truss (+Z), its width runs along the truss (+X), and its face
  // normal ends up on +Y -- edge-on to the Sun, which is the whole point of a
  // radiator's attitude.
  const radBasis = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(0, 0, 1),   // local X (length)  -> world Z
    new THREE.Vector3(1, 0, 0),   // local Y (width)   -> world X
    new THREE.Vector3(0, 1, 0),   // local Z (normal)  -> world Y
  );

  const perSide = RADIATOR_PANELS / 2;
  for (let side = 0; side < 2; side++) {
    for (let i = 0; i < perSide; i++) {
      const p = new THREE.Mesh(radGeo, radMat.clone());
      p.quaternion.setFromRotationMatrix(radBasis);
      const spread = (i - (perSide - 1) / 2) * rad.width * 1.35;
      p.position.set(spread, 0, (side ? 1 : -1) * (rad.length / 2 + trussR * 2.5));
      group.add(p);
      parts.radiators.push(p);
    }
  }

  // ---- solar array wings ---------------------------------------------------
  const cellMat = new THREE.MeshStandardMaterial({
    color: 0x16305c, metalness: 0.35, roughness: 0.38,
    emissive: 0x081428, emissiveIntensity: 0.5, side: THREE.DoubleSide,
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

  // ---- compute modules ----------------------------------------------------
  const modMat = new THREE.MeshStandardMaterial({
    color: 0xc4ced8, metalness: 0.5, roughness: 0.4,
  });
  const modR = Math.max(3.2, trussR * 2.4);
  const modL = modR * 3.2;
  for (let i = 0; i < flights; i++) {
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(modR, modR, modL, 16, 1), modMat.clone());
    m.rotation.z = Math.PI / 2;
    const spread = (i - (flights - 1) / 2) * modL * 1.15;
    m.position.set(spread, -trussR * 2.6, 0);
    group.add(m);
    parts.modules.push(m);
  }

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
export function updateStation(station, s) {
  const { parts } = station;
  const asm = Math.max(0, Math.min(1, s.assembly ?? 1));

  // Modules appear as their flights are commissioned.
  const live = Math.round(asm * parts.modules.length);
  parts.modules.forEach((m, i) => {
    m.visible = i < live;
    // Dose damage shows as the compute modules going dark and cold.
    const d = s.dose ?? 1;
    m.material.color.setRGB(0.77 * d + 0.18, 0.81 * d + 0.14, 0.85 * d + 0.12);
  });

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
    w.mesh.material.emissiveIntensity = 0.18 + 0.5 * a;
    w.mesh.material.color.setRGB(0.055 + 0.05 * a, 0.14 + 0.05 * a, 0.30 + 0.06 * a);
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
