/**
 * Scene overlays: trajectories, orbits, ground tracks, markers, and a
 * to-scale model of the datacenter itself.
 *
 * The datacenter model is drawn at TRUE SCALE against the Earth. This is
 * deliberate and it is the most useful thing in the viewport: at 100 MW the
 * radiators and solar arrays are a structure several hundred metres across,
 * and seeing the compute module as a speck at the centre of it conveys the
 * design problem faster than any table can.
 */

import * as THREE from 'three';
import { toScene, vecToScene } from './scene.js';
import { R_EARTH_EQ, DEG } from '../sim/constants.js';
import { elementsToRv } from '../sim/orbit.js';
import { geodeticToEcef, ecefToEci } from '../sim/frames.js';

const COLORS = {
  ascent: 0x4dd0e1,
  coast: 0x5a6b82,
  orbit: 0x5ee08a,
  orbitFail: 0xff6b6b,
  groundTrack: 0xffc75a,
  site: 0xff6b6b,
  radiator: 0xe8eef6,
  array: 0x2a4a7a,
  module: 0x9fb3c8,
};

export function createOverlays(scene) {
  const group = new THREE.Group();
  scene.add(group);

  const layers = {
    ascent: null,
    coast: null,
    orbit: null,
    groundTrack: null,
    site: null,
    vehicle: null,
    datacenter: null,
    apsides: null,
    family: null,
  };

  function dispose(obj) {
    if (!obj) return;
    group.remove(obj);
    obj.traverse?.((o) => {
      o.geometry?.dispose?.();
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
      else o.material?.dispose?.();
    });
    obj.geometry?.dispose?.();
    obj.material?.dispose?.();
  }

  function replace(key, obj) {
    dispose(layers[key]);
    layers[key] = obj;
    if (obj) group.add(obj);
  }

  // -------------------------------------------------------------- trajectory
  /**
   * Ascent trajectory, coloured by flight phase.
   * Powered flight is bright; unpowered coast is muted, so staging and the
   * coast to apoapsis read directly off the shape of the trajectory.
   */
  function setAscent(samples) {
    if (!samples?.length) { replace('ascent', null); return; }

    const positions = [];
    const colors = [];
    const burning = new THREE.Color(COLORS.ascent);
    const coasting = new THREE.Color(COLORS.coast);

    for (const s of samples) {
      const p = vecToScene(s.r);
      positions.push(p.x, p.y, p.z);
      const c = s.burning ? burning : coasting;
      colors.push(c.r, c.g, c.b);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

    replace('ascent', new THREE.Line(geo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.95,
    })));
  }

  // ------------------------------------------------------------------- orbit
  /**
   * Draw the full orbit from its classical elements.
   * Sampled in true anomaly rather than in time, so the ellipse is smooth near
   * periapsis where a time-uniform sampling would go sparse.
   */
  function setOrbit(elements, ok = true) {
    if (!elements || !Number.isFinite(elements.a) || elements.e >= 1) {
      replace('orbit', null);
      replace('apsides', null);
      return;
    }

    const pts = [];
    const n = 512;
    for (let i = 0; i <= n; i++) {
      const nu = (i / n) * Math.PI * 2;
      const { r } = elementsToRv({ ...elements, nu, p: elements.p });
      pts.push(vecToScene(r));
    }

    replace('orbit', new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({
        color: ok ? COLORS.orbit : COLORS.orbitFail,
        transparent: true, opacity: 0.75,
      }),
    ));

    // Apsis markers.
    const marks = new THREE.Group();
    for (const [nu, color] of [[0, 0x5ee08a], [Math.PI, 0x4dd0e1]]) {
      const { r } = elementsToRv({ ...elements, nu, p: elements.p });
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(toScene(70e3), 10, 10),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 }),
      );
      m.position.copy(vecToScene(r));
      marks.add(m);
    }
    replace('apsides', marks);
  }

  // ------------------------------------------------------------ ground track
  /**
   * Ground track, drawn just above the surface.
   *
   * Plotted in the Earth-fixed frame and then attached to the rotating globe,
   * so the westward drift between successive orbits appears naturally rather
   * than having to be faked. That drift is Earth turning underneath the orbit:
   * about 22.5 degrees of longitude per 90-minute lap.
   */
  function setGroundTrack(points, earthMesh) {
    if (!points?.length) { replace('groundTrack', null); return; }

    const segments = [];
    let current = [];
    let prevLon = null;

    for (const { latitude, longitude } of points) {
      // Split the line where it wraps the antimeridian, otherwise a stray
      // segment shoots across the whole globe.
      if (prevLon !== null && Math.abs(longitude - prevLon) > 180) {
        if (current.length > 1) segments.push(current);
        current = [];
      }
      prevLon = longitude;

      const lat = latitude * DEG;
      const lon = longitude * DEG;
      const r = toScene(R_EARTH_EQ) * 1.006;
      // Earth-fixed cartesian, then into the scene's Y-up frame.
      current.push(new THREE.Vector3(
        r * Math.cos(lat) * Math.cos(lon),
        r * Math.sin(lat),
        -r * Math.cos(lat) * Math.sin(lon),
      ));
    }
    if (current.length > 1) segments.push(current);

    const g = new THREE.Group();
    for (const seg of segments) {
      g.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(seg),
        new THREE.LineBasicMaterial({ color: COLORS.groundTrack, transparent: true, opacity: 0.7 }),
      ));
    }

    // Parent to the globe so it rotates with the planet.
    dispose(layers.groundTrack);
    layers.groundTrack = g;
    earthMesh.add(g);
    // Undo the ellipsoid scaling the parent applies, so the track is not
    // squashed along the polar axis twice.
    g.scale.set(1 / earthMesh.scale.x, 1 / earthMesh.scale.y, 1 / earthMesh.scale.z);
  }

  // ------------------------------------------------------------------ site
  function setLaunchSite(site, earthMesh) {
    dispose(layers.site);
    const ecef = geodeticToEcef(site.latitude, site.longitude, 0);
    const p = new THREE.Vector3(ecef[0], ecef[2], -ecef[1]).multiplyScalar(toScene(1));

    const g = new THREE.Group();
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(toScene(55e3), 12, 12),
      new THREE.MeshBasicMaterial({ color: COLORS.site }),
    );
    dot.position.copy(p);
    g.add(dot);

    const up = p.clone().normalize();
    g.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([p, p.clone().add(up.multiplyScalar(toScene(700e3)))]),
      new THREE.LineBasicMaterial({ color: COLORS.site, transparent: true, opacity: 0.45 }),
    ));

    layers.site = g;
    earthMesh.add(g);
    g.scale.set(1 / earthMesh.scale.x, 1 / earthMesh.scale.y, 1 / earthMesh.scale.z);
  }

  // --------------------------------------------------------------- vehicle
  function setVehicle(rEci) {
    if (!rEci) { replace('vehicle', null); return; }
    if (!layers.vehicle) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(toScene(45e3), 12, 12),
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
      );
      layers.vehicle = m;
      group.add(m);
    }
    layers.vehicle.position.copy(vecToScene(rEci));
  }

  // ------------------------------------------------------------ datacenter
  /**
   * Build a true-scale model of the spacecraft from its sized subsystems.
   *
   * Geometry: a compute module at the centre, two radiator wings held edge-on
   * to the Sun, two solar array wings normal to it. The areas are exactly the
   * areas the thermal and power models computed, split into two wings each at
   * a 4:1 aspect ratio.
   */
  function setDatacenter(design, rEci) {
    dispose(layers.datacenter);
    if (!design || !rEci) { layers.datacenter = null; return; }

    const g = new THREE.Group();

    const wingDims = (totalArea) => {
      const per = Math.max(totalArea, 1) / 2;
      const length = Math.sqrt(per * 4);
      return { length, width: per / length };
    };

    // --- radiators (bright, high emissivity white) ---
    if (Number.isFinite(design.thermal.area) && design.thermal.area > 0) {
      const { length, width } = wingDims(design.thermal.area);
      const geo = new THREE.PlaneGeometry(toScene(length), toScene(width));
      const mat = new THREE.MeshBasicMaterial({
        color: COLORS.radiator, side: THREE.DoubleSide,
        transparent: true, opacity: 0.9,
      });
      for (const sign of [1, -1]) {
        const wing = new THREE.Mesh(geo, mat);
        wing.position.z = (sign * toScene(width)) / 2 + sign * toScene(width) * 0.6;
        g.add(wing);
      }
    }

    // --- solar arrays (dark blue cells) ---
    if (design.power.array.area > 0) {
      const { length, width } = wingDims(design.power.array.area);
      const geo = new THREE.PlaneGeometry(toScene(length), toScene(width));
      const mat = new THREE.MeshBasicMaterial({
        color: COLORS.array, side: THREE.DoubleSide,
        transparent: true, opacity: 0.95,
      });
      for (const sign of [1, -1]) {
        const wing = new THREE.Mesh(geo, mat);
        wing.rotation.x = Math.PI / 2;
        wing.position.y = sign * toScene(width) * 1.1;
        g.add(wing);
      }
    }

    // --- compute module ---
    const side = Math.cbrt(Math.max(design.mass.it, 1) / 400);
    const core = new THREE.Mesh(
      new THREE.BoxGeometry(toScene(side), toScene(side), toScene(side)),
      new THREE.MeshBasicMaterial({ color: COLORS.module }),
    );
    g.add(core);

    g.position.copy(vecToScene(rEci));
    // Orient the long axis along the velocity direction, roughly, by aiming
    // the group's local +X down-track (perpendicular to the radius vector).
    const radial = g.position.clone().normalize();
    const alongTrack = new THREE.Vector3(0, 1, 0).cross(radial).normalize();
    g.lookAt(g.position.clone().add(alongTrack));

    layers.datacenter = g;
    group.add(g);
    return g;
  }

  /**
   * Draw a family of candidate orbits at once, coloured by whether the design
   * closes there. This is the point of a parameter sweep made visual: the
   * viable band and the dead zone through the proton belt are immediately
   * legible as geometry rather than as rows in a table.
   */
  function setOrbitFamily(entries) {
    dispose(layers.family);
    layers.family = null;
    if (!entries?.length) return;

    const g = new THREE.Group();
    for (const e of entries) {
      const a = R_EARTH_EQ + e.altitude;
      const inc = (e.inclination ?? 0) * DEG;
      const pts = [];
      for (let k = 0; k <= 128; k++) {
        const nu = (k / 128) * Math.PI * 2;
        const { r } = elementsToRv({ a, e: 0, i: inc, raan: e.raan ?? 0.6, argp: 0, nu, p: a });
        pts.push(vecToScene(r));
      }
      g.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({
          color: e.viable ? COLORS.orbit : COLORS.orbitFail,
          transparent: true,
          opacity: e.viable ? 0.75 : 0.16,
        }),
      ));
    }
    layers.family = g;
    group.add(g);
  }

  function clearAll() {
    for (const k of Object.keys(layers)) {
      dispose(layers[k]);
      layers[k] = null;
    }
  }

  return {
    group, layers,
    setAscent, setOrbit, setGroundTrack, setLaunchSite, setVehicle, setDatacenter,
    setOrbitFamily, clearAll,
  };
}
