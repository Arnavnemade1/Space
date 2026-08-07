/**
 * Three.js scene: Earth, atmosphere, stars, Sun, camera, post-processing.
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
 *
 * TWO CAMERAS. The main camera holds the planet; a second camera rides with the
 * vehicle and is rendered into an inset in the corner, the way a launch
 * broadcast carries a wide tracking shot and a close camera at the same time.
 * That split is what lets the main view stay at TRUE SCALE -- there is no need
 * to draw a 70 m rocket 7000x oversized to make it visible, because the inset
 * is already showing it from 200 m away.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import * as topojson from 'topojson-client';
import landTopo from 'world-atlas/land-110m.json';

import { R_EARTH_EQ, R_EARTH_POLAR } from '../sim/constants.js';

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
// Earth surface textures, drawn from real coastline data
// ---------------------------------------------------------------------------

/** Rasterise the land polygons once; both textures are derived from this. */
function rasteriseLand(ctx, width, height, fill, stroke, lineWidth) {
  const land = topojson.feature(landTopo, landTopo.objects.land);
  const project = (lon, lat) => [
    ((lon + 180) / 360) * width,
    ((90 - lat) / 180) * height,
  ];

  ctx.fillStyle = fill;
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = 'round';
  }

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
      if (stroke) ctx.stroke();
    }
  };

  for (const feature of land.features) {
    const g = feature.geometry;
    if (!g) continue;
    if (g.type === 'Polygon') tracePolygon(g.coordinates);
    else if (g.type === 'MultiPolygon') for (const poly of g.coordinates) tracePolygon(poly);
  }
}

/**
 * Rasterise Natural Earth land polygons into an equirectangular day texture.
 * `world-atlas` ships the 1:110m Natural Earth land layer as TopoJSON; it is
 * about 100 kB and is bundled, so this works offline.
 */
function buildDayTexture(width = 4096) {
  const height = width / 2;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  // Ocean: colder and darker toward the poles, which reads as latitude without
  // needing an ice map.
  const ocean = ctx.createLinearGradient(0, 0, 0, height);
  ocean.addColorStop(0, '#0a1a2c');
  ocean.addColorStop(0.18, '#0d2942');
  ocean.addColorStop(0.5, '#123a5c');
  ocean.addColorStop(0.82, '#0d2942');
  ocean.addColorStop(1, '#0a1a2c');
  ctx.fillStyle = ocean;
  ctx.fillRect(0, 0, width, height);

  // Land is deliberately much lighter and warmer than the ocean. At globe scale
  // a subtle difference vanishes into the night side entirely, and warm land
  // against a cool sea is what makes a coastline read at a glance.
  rasteriseLand(ctx, width, height, '#4a5f42', '#b7d9a4', 2.0);

  // Polar ice. Drawn after the land so it covers both Antarctica and the
  // Arctic ocean, with a soft edge rather than a hard latitude cut.
  const ice = ctx.createLinearGradient(0, 0, 0, height);
  ice.addColorStop(0.00, 'rgba(226,240,250,0.92)');
  ice.addColorStop(0.07, 'rgba(226,240,250,0.35)');
  ice.addColorStop(0.11, 'rgba(226,240,250,0)');
  ice.addColorStop(0.89, 'rgba(226,240,250,0)');
  ice.addColorStop(0.94, 'rgba(232,244,252,0.55)');
  ice.addColorStop(1.00, 'rgba(240,250,255,0.96)');
  ctx.fillStyle = ice;
  ctx.fillRect(0, 0, width, height);

  // Graticule, every 15 degrees. Purely for readability -- it makes inclination
  // and ground-track drift legible at a glance.
  ctx.strokeStyle = 'rgba(120, 170, 210, 0.13)';
  ctx.lineWidth = 1;
  const project = (lon, lat) => [((lon + 180) / 360) * width, ((90 - lat) / 180) * height];
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

/**
 * City lights for the night side.
 *
 * There is no population raster in the bundle, so this is not a real lights
 * map and does not pretend to be: it scatters clustered settlements onto the
 * land mask, thinned toward the poles where nobody lives. What it buys is the
 * single strongest cue that the dark limb is a planet and not a shadow -- the
 * night side of Earth from orbit is not black, it is threaded with light.
 */
function buildNightTexture(width = 2048) {
  const height = width / 2;

  // Land mask first, at the same resolution, so lights can be rejected into
  // the sea.
  const mask = document.createElement('canvas');
  mask.width = width; mask.height = height;
  const mctx = mask.getContext('2d', { willReadFrequently: true });
  mctx.fillStyle = '#000';
  mctx.fillRect(0, 0, width, height);
  rasteriseLand(mctx, width, height, '#fff', null, 0);
  const maskData = mctx.getImageData(0, 0, width, height).data;
  const onLand = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    return maskData[((y | 0) * width + (x | 0)) * 4] > 127;
  };

  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = 'lighter';

  // Deterministic PRNG so the map is identical between reloads -- a lights
  // pattern that reshuffles every refresh reads as noise, not geography.
  let seed = 0x2f6e2b1;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const latAt = (y) => 90 - (y / height) * 180;
  // Nobody lives on the ice caps, and the southern hemisphere has far less
  // land and far fewer people on it.
  const habitability = (lat) => {
    if (lat > 72 || lat < -58) return 0;
    const north = lat > 0 ? 1 : 0.45;
    const temperate = Math.exp(-Math.pow((Math.abs(lat) - 38) / 30, 2));
    return north * (0.25 + 0.75 * temperate);
  };

  let placed = 0;
  for (let attempt = 0; attempt < 60000 && placed < 820; attempt++) {
    const x = rnd() * width;
    const y = rnd() * height;
    if (!onLand(x, y)) continue;
    if (rnd() > habitability(latAt(y))) continue;
    placed++;

    // A settlement is a bright core plus a scatter of outlying lights; that
    // structure is what makes it read as a city rather than a dot.
    const size = 1.0 + Math.pow(rnd(), 3.2) * 7;
    const warmth = 0.72 + rnd() * 0.28;
    const g = ctx.createRadialGradient(x, y, 0, x, y, size);
    g.addColorStop(0, `rgba(255, ${Math.round(214 * warmth + 40)}, ${Math.round(160 * warmth)}, 0.62)`);
    g.addColorStop(0.35, `rgba(255, ${Math.round(190 * warmth + 30)}, ${Math.round(120 * warmth)}, 0.16)`);
    g.addColorStop(1, 'rgba(255,170,90,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, size, 0, Math.PI * 2); ctx.fill();

    const satellites = Math.floor(rnd() * 7);
    for (let k = 0; k < satellites; k++) {
      const a = rnd() * Math.PI * 2;
      const d = size * (1.2 + rnd() * 3.5);
      const sx = x + Math.cos(a) * d;
      const sy = y + Math.sin(a) * d;
      if (!onLand(sx, sy)) continue;
      ctx.fillStyle = `rgba(255, ${Math.round(206 * warmth + 40)}, ${Math.round(150 * warmth)}, ${0.10 + rnd() * 0.18})`;
      ctx.beginPath(); ctx.arc(sx, sy, 0.6 + rnd() * 1.5, 0, Math.PI * 2); ctx.fill();
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
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
 *
 * Output is deliberately allowed above 1.0 on the sunlit side. The pipeline is
 * HDR from here to the tone mapper, so specular sea glint and the bright limb
 * have somewhere to go instead of clipping to flat white.
 */
const EARTH_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform sampler2D uNight;
  uniform vec3 uSunDir;
  uniform vec3 uCameraPos;
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;

  void main() {
    vec3 base = texture2D(uMap, vUv).rgb;
    vec3 n = normalize(vNormalW);
    vec3 viewDir = normalize(uCameraPos - vPosW);

    float sun = dot(n, normalize(uSunDir));
    float day = smoothstep(-0.12, 0.24, sun);

    // Lambert plus a weak wrap term; the wrap stands in for the atmosphere
    // carrying light a little past the geometric terminator.
    float lambert = max(sun, 0.0) + 0.16 * smoothstep(-0.30, 0.10, sun);
    vec3 lit = base * (0.14 + 1.15 * lambert);

    // Specular sea glint. Oceans are dark and smooth, land is bright and
    // rough, so luminance is a serviceable inverse roughness proxy here.
    float lum = dot(base, vec3(0.30, 0.59, 0.11));
    float ocean = smoothstep(0.34, 0.12, lum);
    vec3 h = normalize(normalize(uSunDir) + viewDir);
    // Tight and subtle. A wide exponent here makes a spot tens of degrees
    // across, which past the bloom threshold turns into a searchlight sitting
    // on the ocean; real sun glitter is a small, soft patch.
    float glint = pow(max(dot(n, h), 0.0), 260.0) * ocean * step(0.0, sun);
    lit += vec3(1.0, 0.93, 0.78) * glint * 0.28;

    vec3 lights = texture2D(uNight, vUv).rgb;
    // Lights are a cue, not the subject. Turned up they read as a planet on
    // fire; this is about the level at which they look like a night side.
    vec3 dark = base * 0.075 + vec3(0.005, 0.010, 0.021) + lights * 0.42;

    vec3 color = mix(dark, lit, day);

    // Warm scatter in the twilight band.
    float twilight = smoothstep(0.28, 0.0, abs(sun)) * 0.55;
    color += vec3(0.42, 0.20, 0.09) * twilight;

    // Atmospheric limb brightening toward the viewer's grazing angle.
    float rim = pow(1.0 - max(dot(n, viewDir), 0.0), 3.2);
    color += vec3(0.16, 0.34, 0.60) * rim * (0.18 + 0.82 * day);

    gl_FragColor = vec4(color, 1.0);
  }
`;

const ATMO_VERT = EARTH_VERT;

/**
 * Additive rim glow on a slightly inflated back-faced shell.
 *
 * The forward-scattering term is the reason a crescent Earth has a blindingly
 * bright thin limb: air scatters strongly forward, so the glow peaks where the
 * line of sight passes closest to the Sun, not where the surface is brightest.
 */
const ATMO_FRAG = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uCameraPos;
  uniform float uShellR;
  varying vec3 vNormalW;
  varying vec3 vPosW;

  void main() {
    vec3 n = normalize(vNormalW);
    vec3 viewDir = normalize(uCameraPos - vPosW);
    vec3 sunDir = normalize(uSunDir);

    float rim = pow(1.0 - abs(dot(n, viewDir)), 3.2);
    float sun = smoothstep(-0.42, 0.30, dot(n, sunDir));

    // Mie-like forward scatter: strongest when looking almost into the Sun.
    float mu = dot(viewDir, -sunDir);
    float forward = pow(max(mu, 0.0), 8.0);

    vec3 dayColor = vec3(0.30, 0.54, 0.92);
    vec3 duskColor = vec3(1.00, 0.46, 0.20);
    vec3 color = mix(vec3(0.03, 0.07, 0.18), dayColor, sun);
    color = mix(color, duskColor, forward * sun * 0.7);

    // This is a limb glow seen from OUTSIDE. The tracking camera flies inside
    // the shell -- a few kilometres above the pad is well within the 179 km
    // radius -- and from in there every fragment is a back face pointing away
    // from the eye, so the "rim" term covers the entire frame and washes the
    // shot to white. Fade the shell out as the camera enters it; the close
    // view then gets its sky from the Earth surface term instead.
    float camR = length(uCameraPos);
    float outside = smoothstep(uShellR * 0.995, uShellR * 1.06, camR);

    float alpha = rim * (0.14 + 0.86 * sun) * (1.0 + 1.1 * forward) * outside;
    gl_FragColor = vec4(color, clamp(alpha, 0.0, 0.9));
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
  // inset camera sit 200 m from the rocket while the same scene still contains
  // a planet 12,700 km across and stars beyond that.
  const camera = new THREE.PerspectiveCamera(
    42,
    container.clientWidth / container.clientHeight,
    1e-6,
    3000,
  );
  camera.position.set(0, 8, 22);

  // The tracking camera. Narrow field of view, the way a real long-lens
  // tracking shot is framed -- it compresses the scene and keeps the vehicle
  // steady in frame instead of swimming around.
  const trackCamera = new THREE.PerspectiveCamera(28, 16 / 10, 1e-6, 3000);

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
    logarithmicDepthBuffer: true,
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setClearColor(0x03050a, 1);
  // Filmic response. Without it every bright thing in the scene -- plume core,
  // Sun, sea glint -- clips to the same flat white and the image reads as a
  // diagram rather than a photograph.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.85;
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
    uMap: { value: buildDayTexture() },
    uNight: { value: buildNightTexture() },
    uSunDir: { value: sunDir },
    uCameraPos: { value: new THREE.Vector3() },
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

  const ATMO_SHELL = 1.028;
  const atmoUniforms = {
    uSunDir: { value: sunDir },
    uCameraPos: { value: new THREE.Vector3() },
    uShellR: { value: EARTH_RX * ATMO_SHELL },
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
  atmosphere.scale.set(EARTH_RX * ATMO_SHELL, EARTH_RZ * ATMO_SHELL, EARTH_RX * ATMO_SHELL);
  scene.add(atmosphere);

  // --- stars --------------------------------------------------------------
  scene.add(buildStarfield(renderer.getPixelRatio()));

  // --- sun ----------------------------------------------------------------
  // A billboarded disc with a corona, bright enough to be picked up by the
  // bloom pass. The previous debug line from the origin to the Sun is gone;
  // it was a diagnostic and it read as a rendering error.
  const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: coronaTexture(),
    color: 0xfff2d2,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }));
  sunSprite.scale.setScalar(95);
  scene.add(sunSprite);

  // A dim ambient plus a directional light, for any standard-material objects
  // added later (the Earth and atmosphere use their own shaders).
  scene.add(new THREE.AmbientLight(0x33445a, 1.3));
  const sunLight = new THREE.DirectionalLight(0xfff4e0, 3.4);
  scene.add(sunLight);

  // Earthshine: a second, much weaker light from the planet. Any vehicle in
  // low orbit is lit from below by sunlight bouncing off Earth, and it is a
  // strong enough effect that leaving it out makes hardware look like it is
  // floating in a studio rather than over a planet.
  const earthshine = new THREE.DirectionalLight(0x6f97c4, 0.5);
  scene.add(earthshine);

  // Camera-mounted fill. A launch that happens to occur during local night at
  // the pad is perfectly realistic and completely unreadable -- the vehicle
  // renders as a black silhouette against a black planet. This keeps hardware
  // legible without pretending the Sun is somewhere it is not: it is dim, and
  // the directional sunlight still does all the shaping.
  const fill = new THREE.DirectionalLight(0x9fbdda, 0.35);
  fill.position.set(0.4, 0.9, 0.7);
  camera.add(fill);
  scene.add(camera);

  // The tracking camera needs its own. Lights parented to the main camera do
  // nothing for a second camera on the other side of the planet, and without
  // one the vehicle in the inset is a silhouette whenever the Sun happens to
  // be low at the pad -- which, for a dawn sun-synchronous launch, is always.
  const trackFill = new THREE.DirectionalLight(0xbcd4ec, 1.15);
  trackFill.position.set(0.45, 0.75, 0.95);
  trackCamera.add(trackFill);
  scene.add(trackCamera);

  // --- post-processing ----------------------------------------------------
  const composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  // The threshold is the important number here, and it wants to be well above
  // 1.0. A sunlit Earth sits around 0.8-1.0 in linear light, so a threshold
  // near 1.0 blooms the whole planet and the image turns into white haze --
  // which is exactly what a first pass at these settings did. At 1.5 only
  // genuinely over-bright things glow: the plume core, the Sun, sea glint.
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(container.clientWidth, container.clientHeight),
    0.34,  // strength
    0.30,  // radius
    1.50,  // threshold
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  composer.setSize(container.clientWidth, container.clientHeight);

  /** Update the Sun direction (unit vector in ECI). */
  function setSunDirection(eci) {
    const v = vecToScene(eci).normalize();
    sunDir.copy(v);
    sunSprite.position.copy(v).multiplyScalar(1200);
    sunLight.position.copy(v).multiplyScalar(100);
    earthshine.position.copy(v).multiplyScalar(-30);
  }
  setSunDirection([1, 0.2, 0.4]);

  /**
   * Rotate the globe to a given Greenwich sidereal angle [rad].
   *
   * The sign is not a guess, and getting it backwards mirrors the planet
   * east-west: a launch from Vandenberg at -120.6 deg longitude comes out over
   * central Asia. Working it through --
   *
   *   The texture paints longitude L at u = (L+180)/360, and SphereGeometry
   *   puts u on the sphere such that the local position of longitude L is
   *   (cos L, ., -sin L).
   *
   *   A point at longitude L must appear, at sidereal angle theta, at ECI
   *   (cos(theta+L), sin(theta+L), 0), which the scene's (x, z, -y) axis
   *   mapping sends to (cos(theta+L), ., -sin(theta+L)).
   *
   *   Rotating the local position by rotation.y = alpha gives
   *   (cos(L+alpha), ., -sin(L+alpha)).
   *
   * So alpha = +theta. The axis swap does not introduce a sign flip here,
   * because it is applied to the texture convention and the ECI position
   * alike.
   */
  function setEarthRotation(theta) {
    earth.rotation.y = theta;
  }

  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
    bloom.setSize(w, h);
  }
  addEventListener('resize', resize);

  /** Point the shared shaders at whichever camera is about to draw. */
  function bindCamera(cam) {
    earthUniforms.uCameraPos.value.copy(cam.position);
    atmoUniforms.uCameraPos.value.copy(cam.position);
  }

  function render() {
    controls.update();
    bindCamera(camera);
    renderPass.camera = camera;
    composer.render();
  }

  /**
   * Draw the tracking camera into a rectangle of the same canvas.
   *
   * Rect is in CSS pixels with the origin at the TOP-left, which is what the
   * DOM gives us; WebGL's viewport origin is bottom-left, so y is flipped
   * here rather than at every call site.
   *
   * This runs after `render()` and deliberately does not go through the
   * composer: a second bloom chain would double the post-processing cost for
   * a 400 px inset, and the plume already carries its own additive glow.
   */
  function renderInset(x, y, w, h) {
    if (w < 8 || h < 8) return;
    // CSS PIXELS, not device pixels. setViewport/setScissor multiply by the
    // renderer's pixel ratio themselves, so pre-multiplying here scales
    // everything twice -- on a retina display that put the inset at double
    // size and, worse, left the restored full-screen viewport twice the size
    // of the canvas, so the composer's output quad was drawn four times too
    // large and the wide shot showed one quadrant of itself.
    const size = renderer.getSize(new THREE.Vector2());
    const px = x;
    const py = size.y - y - h;

    trackCamera.aspect = w / h;
    trackCamera.updateProjectionMatrix();
    bindCamera(trackCamera);

    renderer.autoClear = false;
    renderer.setScissorTest(true);
    renderer.setViewport(px, py, w, h);
    renderer.setScissor(px, py, w, h);
    renderer.setClearColor(0x020307, 1);
    renderer.clear(true, true, false);
    renderer.render(scene, trackCamera);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, size.x, size.y);
    renderer.setClearColor(0x03050a, 1);
    renderer.autoClear = true;
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
    scene, camera, trackCamera, renderer, controls, earth, atmosphere, composer,
    setSunDirection, setEarthRotation, render, renderInset, resize, frameRadius,
    focusOn, focusEarth,
    EARTH_RX, EARTH_RZ,
  };
}

/** Soft radial disc with a wide falloff, used for the Sun. */
function coronaTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0.00, 'rgba(255,255,252,1)');
  grad.addColorStop(0.10, 'rgba(255,246,214,1)');
  grad.addColorStop(0.17, 'rgba(255,226,160,0.55)');
  grad.addColorStop(0.40, 'rgba(255,190,110,0.12)');
  grad.addColorStop(1.00, 'rgba(255,170,90,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildStarfield(pixelRatio = 1) {
  // Magnitude-weighted random field. Not a real catalogue -- the constellations
  // would be wrong, and pretending otherwise in a simulator that is careful
  // about everything else would be worse than making it obviously decorative.
  const count = 5200;
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
    const brightness = Math.pow(Math.random(), 2.6);
    // Spectral class, roughly: most stars are cool and orange, a few are hot
    // and blue. Sampling the colour rather than fixing it is what stops a
    // starfield looking like grey dust.
    const temp = Math.random();
    const warm = temp < 0.72 ? 1.0 : 0.80;
    const cool = temp < 0.72 ? 0.80 : 1.0;
    colors[i * 3] = brightness * warm;
    colors[i * 3 + 1] = brightness * 0.92;
    colors[i * 3 + 2] = brightness * cool;
    sizes[i] = (0.8 + brightness * 3.0) * pixelRatio;
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
        float a = smoothstep(0.5, 0.06, d);
        gl_FragColor = vec4(vColor, a);
      }
    `,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return points;
}
