/**
 * Three.js scene: Earth, atmosphere, stars, Sun, camera.
 *
 * SCENE UNITS: 1 unit = 1000 km. Everything crossing the boundary from the
 * physics layer (which is strictly SI metres) goes through `toScene()`. Mixing
 * the two is the rendering equivalent of a units bug, so there is exactly one
 * conversion point.
 *
 * The globe is a WGS84 ellipsoid, not a sphere -- flattening is only 0.34% and
 * barely visible, but the trajectory data is computed against the ellipsoid, so
 * drawing a sphere would put low-altitude tracks visibly off the surface near
 * the poles.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as topojson from 'topojson-client';
import landTopo from 'world-atlas/land-110m.json';

import { R_EARTH_EQ, R_EARTH_POLAR, DEG } from '../sim/constants.js';

/** Metres -> scene units. */
export const SCENE_SCALE = 1 / 1_000_000;
export const toScene = (metres) => metres * SCENE_SCALE;
export const vecToScene = (v) => new THREE.Vector3(v[0], v[2], -v[1]).multiplyScalar(SCENE_SCALE);

// NOTE on the axis swap above: the physics uses a Z-up ECI frame (z toward the
// north celestial pole). Three.js is Y-up. The mapping (x, y, z)_ECI ->
// (x, z, -y)_scene is a proper rotation, so it preserves handedness -- an
// orbit that is prograde in the physics is prograde on screen.

const EARTH_RX = toScene(R_EARTH_EQ);
const EARTH_RZ = toScene(R_EARTH_POLAR);

// ---------------------------------------------------------------------------
// Earth surface texture, drawn from real coastline data
// ---------------------------------------------------------------------------

/**
 * Rasterise Natural Earth land polygons into an equirectangular texture.
 * `world-atlas` ships the 1:110m Natural Earth land layer as TopoJSON; it is
 * about 100 kB and is bundled, so this works offline.
 */
function buildEarthTexture(width = 4096) {
  const height = width / 2;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  // Ocean
  const ocean = ctx.createLinearGradient(0, 0, 0, height);
  ocean.addColorStop(0, '#071120');
  ocean.addColorStop(0.5, '#0b2136');
  ocean.addColorStop(1, '#071120');
  ctx.fillStyle = ocean;
  ctx.fillRect(0, 0, width, height);

  const land = topojson.feature(landTopo, landTopo.objects.land);

  const project = (lon, lat) => [
    ((lon + 180) / 360) * width,
    ((90 - lat) / 180) * height,
  ];

  const tracePolygon = (rings) => {
    for (const ring of rings) {
      ctx.beginPath();
      for (let i = 0; i < ring.length; i++) {
        const [x, y] = project(ring[i][0], ring[i][1]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  };

  // Land is deliberately much lighter than ocean. At globe scale a subtle
  // difference vanishes into the night side entirely.
  ctx.fillStyle = '#3d5a48';
  ctx.strokeStyle = '#8fc9a8';
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';

  for (const feature of land.features) {
    const g = feature.geometry;
    if (!g) continue;
    if (g.type === 'Polygon') tracePolygon(g.coordinates);
    else if (g.type === 'MultiPolygon') for (const poly of g.coordinates) tracePolygon(poly);
  }

  // Graticule, every 15 degrees. Purely for readability -- it makes inclination
  // and ground-track drift legible at a glance.
  ctx.strokeStyle = 'rgba(120, 170, 210, 0.13)';
  ctx.lineWidth = 1;
  for (let lon = -180; lon <= 180; lon += 15) {
    const [x] = project(lon, 0);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
  }
  for (let lat = -75; lat <= 75; lat += 15) {
    const [, y] = project(0, lat);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
  }
  // Equator emphasised.
  ctx.strokeStyle = 'rgba(160, 210, 240, 0.28)';
  ctx.lineWidth = 1.6;
  const [, eqY] = project(0, 0);
  ctx.beginPath(); ctx.moveTo(0, eqY); ctx.lineTo(width, eqY); ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const EARTH_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  void main() {
    vUv = uv;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vPosW = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * Day/night terminator.
 *
 * The terminator is softened over a few degrees rather than drawn as a hard
 * edge. That soft band is physically real -- it is twilight, the region where
 * the Sun is below the horizon but the upper atmosphere is still lit -- and on
 * Earth it spans roughly 18 degrees of longitude from sunset to astronomical
 * night.
 */
const EARTH_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uSunDir;
  uniform vec3 uCameraPos;
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;

  void main() {
    vec3 base = texture2D(uMap, vUv).rgb;
    vec3 n = normalize(vNormalW);

    float sun = dot(n, normalize(uSunDir));
    float day = smoothstep(-0.18, 0.22, sun);

    vec3 lit = base * (0.35 + 1.15 * max(sun, 0.0));
    vec3 dark = base * 0.22 + vec3(0.008, 0.014, 0.028);
    vec3 color = mix(dark, lit, day);

    // Warm scatter in the twilight band.
    float twilight = smoothstep(0.30, 0.0, abs(sun)) * 0.5;
    color += vec3(0.34, 0.16, 0.07) * twilight;

    // Atmospheric limb brightening toward the viewer's grazing angle.
    vec3 viewDir = normalize(uCameraPos - vPosW);
    float rim = pow(1.0 - max(dot(n, viewDir), 0.0), 2.6);
    color += vec3(0.18, 0.38, 0.62) * rim * (0.30 + 0.70 * day);

    gl_FragColor = vec4(color, 1.0);
  }
`;

const ATMO_VERT = EARTH_VERT;

/** Additive rim glow on a slightly inflated back-faced shell. */
const ATMO_FRAG = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uCameraPos;
  varying vec3 vNormalW;
  varying vec3 vPosW;

  void main() {
    vec3 n = normalize(vNormalW);
    vec3 viewDir = normalize(uCameraPos - vPosW);
    float rim = pow(1.0 - abs(dot(n, viewDir)), 3.4);
    float sun = smoothstep(-0.45, 0.35, dot(n, normalize(uSunDir)));
    vec3 color = mix(vec3(0.05, 0.12, 0.26), vec3(0.32, 0.58, 0.92), sun);
    gl_FragColor = vec4(color, rim * (0.20 + 0.80 * sun));
  }
`;

// ---------------------------------------------------------------------------
// Scene construction
// ---------------------------------------------------------------------------

export function createScene(container) {
  const scene = new THREE.Scene();

  // Near plane at 1e-6 units = 1 metre, far plane at 3000 units = 3 million km.
  // That is a dynamic range of 3e9, far beyond what a normal depth buffer can
  // resolve -- hence the logarithmic depth buffer below. It is what lets the
  // camera fly from a whole-Earth view down to the metre-scale structure of the
  // spacecraft without the geometry tearing itself apart.
  const camera = new THREE.PerspectiveCamera(
    42,
    container.clientWidth / container.clientHeight,
    1e-6,
    3000,
  );
  camera.position.set(0, 8, 22);

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
    logarithmicDepthBuffer: true,
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setClearColor(0x05070c, 1);
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.rotateSpeed = 0.42;
  controls.minDistance = EARTH_RX * 1.02;
  controls.maxDistance = 900;
  controls.screenSpacePanning = false;
  controls.zoomSpeed = 0.9;

  // --- Earth --------------------------------------------------------------
  const sunDir = new THREE.Vector3(1, 0.2, 0.4).normalize();

  const earthUniforms = {
    uMap: { value: buildEarthTexture() },
    uSunDir: { value: sunDir },
    uCameraPos: { value: camera.position },
  };

  const earthGeo = new THREE.SphereGeometry(1, 160, 96);
  const earth = new THREE.Mesh(
    earthGeo,
    new THREE.ShaderMaterial({
      uniforms: earthUniforms,
      vertexShader: EARTH_VERT,
      fragmentShader: EARTH_FRAG,
    }),
  );
  // Scale the unit sphere into the WGS84 ellipsoid. Scene Y is the polar axis.
  earth.scale.set(EARTH_RX, EARTH_RZ, EARTH_RX);
  scene.add(earth);

  const atmoUniforms = {
    uSunDir: { value: sunDir },
    uCameraPos: { value: camera.position },
  };
  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(1, 96, 64),
    new THREE.ShaderMaterial({
      uniforms: atmoUniforms,
      vertexShader: ATMO_VERT,
      fragmentShader: ATMO_FRAG,
      side: THREE.BackSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  atmosphere.scale.set(EARTH_RX * 1.025, EARTH_RZ * 1.025, EARTH_RX * 1.025);
  scene.add(atmosphere);

  // --- stars --------------------------------------------------------------
  scene.add(buildStarfield());

  // --- sun marker ---------------------------------------------------------
  const sunSprite = new THREE.Mesh(
    new THREE.SphereGeometry(1.6, 20, 20),
    new THREE.MeshBasicMaterial({ color: 0xfff0c0 }),
  );
  scene.add(sunSprite);

  const sunLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineBasicMaterial({ color: 0x6a5a30, transparent: true, opacity: 0.5 }),
  );
  scene.add(sunLine);

  // A dim ambient plus a directional light, for any standard-material objects
  // added later (the Earth and atmosphere use their own shaders).
  scene.add(new THREE.AmbientLight(0x334455, 1.1));
  const sunLight = new THREE.DirectionalLight(0xfff4e0, 2.6);
  scene.add(sunLight);

  // Camera-mounted fill. A launch that happens to occur during local night at
  // the pad is perfectly realistic and completely unreadable -- the vehicle
  // renders as a black silhouette against a black planet. This keeps hardware
  // legible without pretending the Sun is somewhere it is not: it is dim, and
  // the directional sunlight still does all the shaping.
  const fill = new THREE.DirectionalLight(0xaecbe8, 0.85);
  fill.position.set(0.4, 0.9, 0.7);
  camera.add(fill);
  scene.add(camera);

  /** Update the Sun direction (unit vector in ECI). */
  function setSunDirection(eci) {
    const v = vecToScene(eci).normalize();
    sunDir.copy(v);
    sunSprite.position.copy(v).multiplyScalar(260);
    sunLight.position.copy(v).multiplyScalar(100);
    sunLine.geometry.setFromPoints([new THREE.Vector3(), v.clone().multiplyScalar(240)]);
  }
  setSunDirection([1, 0.2, 0.4]);

  /** Rotate the globe to a given Greenwich sidereal angle [rad]. */
  function setEarthRotation(theta) {
    // Scene Y is the polar axis; ECI +X maps to scene +X, so a rotation of
    // +theta about ECI Z becomes -theta about scene Y under the axis mapping.
    earth.rotation.y = -theta;
  }

  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
  addEventListener('resize', resize);

  function render() {
    controls.update();
    earthUniforms.uCameraPos.value.copy(camera.position);
    atmoUniforms.uCameraPos.value.copy(camera.position);
    renderer.render(scene, camera);
  }

  /**
   * Point the camera at a scene-space target and allow close approach.
   * Used to fly down to the spacecraft, where the interesting scale is metres
   * rather than thousands of kilometres.
   */
  function focusOn(targetVec, approachMetres) {
    controls.target.copy(targetVec);
    controls.minDistance = toScene(Math.max(approachMetres * 0.05, 5));
    const dir = camera.position.clone().sub(targetVec).normalize();
    camera.position.copy(targetVec).add(dir.multiplyScalar(toScene(approachMetres)));
    controls.update();
  }

  /** Return the camera to the whole-Earth view. */
  function focusEarth() {
    controls.target.set(0, 0, 0);
    controls.minDistance = EARTH_RX * 1.02;
    const dir = camera.position.clone().normalize();
    camera.position.copy(dir.multiplyScalar(Math.max(camera.position.length(), EARTH_RX * 3.2)));
    controls.update();
  }

  /** Frame the camera on a radius (in metres) with a comfortable margin. */
  function frameRadius(metres, margin = 2.6) {
    const target = Math.max(toScene(metres) * margin, EARTH_RX * 2.2);
    const dir = camera.position.clone().normalize();
    camera.position.copy(dir.multiplyScalar(target));
    controls.update();
  }

  return {
    scene, camera, renderer, controls, earth, atmosphere,
    setSunDirection, setEarthRotation, render, resize, frameRadius,
    focusOn, focusEarth,
    EARTH_RX, EARTH_RZ,
  };
}

function buildStarfield() {
  // Magnitude-weighted random field. Not a real catalogue -- the constellations
  // would be wrong, and pretending otherwise in a simulator that is careful
  // about everything else would be worse than making it obviously decorative.
  const count = 4200;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    // Uniform on the sphere: acos of a uniform cosine, not a uniform angle.
    const u = Math.random() * 2 - 1;
    const phi = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const r = 1500 + Math.random() * 900;

    positions[i * 3] = r * s * Math.cos(phi);
    positions[i * 3 + 1] = r * u;
    positions[i * 3 + 2] = r * s * Math.sin(phi);

    // Bias toward faint stars, as a real magnitude distribution does.
    const brightness = Math.pow(Math.random(), 2.4);
    const warm = 0.82 + Math.random() * 0.18;
    colors[i * 3] = brightness * warm;
    colors[i * 3 + 1] = brightness * (0.88 + Math.random() * 0.12);
    colors[i * 3 + 2] = brightness;
    sizes[i] = 0.7 + brightness * 3.2;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: {},
    vertexShader: /* glsl */ `
      attribute float size;
      varying vec3 vColor;
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;
        gl_FragColor = vec4(vColor, smoothstep(0.5, 0.1, d));
      }
    `,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
  });

  return new THREE.Points(geo, mat);
}
