/**
 * Application entry point: state, orchestration, and the animation loop.
 *
 * The physics layer knows nothing about the DOM and the render layer knows
 * nothing about the physics beyond position vectors. This file is the only
 * place the two meet.
 */

import { createScene, vecToScene, toScene } from './render/scene.js';
import { createOverlays } from './render/overlays.js';
import { createChart } from './ui/chart.js';
import { createPlayback, PHASES } from './render/playback.js';
import { simulateMission } from './sim/mission.js';
import { buildConfig, buildResults } from './ui/panels.js';
import { MODELS_DOC } from './ui/docs.js';

import { VEHICLES, LAUNCH_SITES } from './sim/vehicles.js';
import { simulateAscent, DEFAULT_GUIDANCE, findMaxPayload } from './sim/ascent.js';
import { designDatacenter } from './sim/datacenter.js';
import { compare } from './sim/economics.js';
import {
  STUDIES, exploreDesigns, exploreLaunches, rank, paretoFront, groupBy, sensitivity, toCsv,
} from './sim/explore.js';
import { rvToElements, orbitalPeriod, elementsToRv, sunlitFraction } from './sim/orbit.js';
import { gmst, dateToJulian, sunPositionEci, eciToEcef, ecefToGeodetic } from './sim/frames.js';
import { R_EARTH_EQ, DEG, G0, MU_EARTH } from './sim/constants.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  tab: 'launch',

  // launch configuration
  vehicleId: 'falcon9',
  // Vandenberg, California. The default datacenter orbit is sun-synchronous at
  // 97.6 deg, and Kennedy cannot fly that: its range-safety corridor is
  // 35-120 deg of azimuth and a retrograde sun-sync launch needs roughly 190.
  // Vandenberg's southerly corridor is the US pad that actually flies these
  // orbits -- which is why every American polar mission goes from there.
  siteId: 'vandenberg',
  payloadMass: 15000,
  targetAltitude: 500e3,
  targetInclination: 28.6,
  reusableBooster: false,
  f107: 150,
  guidance: { ...DEFAULT_GUIDANCE },

  // datacenter configuration
  itPower: 10e6,
  computeProfile: 'denseAccelerator',
  missionYears: 10,
  dcAltitude: 550e3,
  dcInclination: 97.6,
  betaAngle: 75 * DEG,
  solarTech: 'rosaFlexible',
  batteryTech: 'liIonSpace',
  junctionTemp: 358.15,
  electronicsClass: 'upscreenedCots',
  shieldingMm: 5,
  band: 'kaBand',
  groundStations: 8,
  transmitPower: 200,
  costVehicle: 'starshipEarly',
  recoveryMode: 'droneship',

  // explore
  study: 'orbitBand',
  rankKey: 'totalMassT',
  rankDir: 'min',
  exploreViableOnly: false,
  explore: null,

  // results
  ascent: null,
  design: null,
  comparison: null,
  sweep: null,
  maxPayload: null,

  // scenario engine — failure models the design sizer does not carry
  latchupProtection: 'none',
  eccMode: 'secded',
  edgeFiltering: false,

  // mission playback
  mission: null,
  missionProgress: 0,
  missionPlaying: false,
  missionSpeed: 1,

  // playback
  epoch: new Date(),
  playing: false,
  cursorT: 0,
  followVehicle: false,
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const viewport = document.getElementById('viewport');
const view = createScene(viewport);
const overlays = createOverlays(view.scene);
const chart = createChart(document.getElementById('chart'));
const playback = createPlayback(view);

// Handles for inspecting the scene from the console during development.
window.__testbed = { view, playback, overlays, state };

const configRoot = document.getElementById('config-root');
const resultsRoot = document.getElementById('results-root');
const hud = document.getElementById('hud');
const clockEl = document.getElementById('clock');
const scrub = document.getElementById('scrub');
const insetEl = document.getElementById('inset');
const insetLabel = document.getElementById('inset-label');
const insetScale = document.getElementById('inset-scale');

let chartSeries = 'altitude';

// ---------------------------------------------------------------------------
// Rendering the UI
// ---------------------------------------------------------------------------

function renderConfig() {
  configRoot.replaceChildren(buildConfig(state, applyChange, state.tab));
}

function renderResults() {
  resultsRoot.replaceChildren(buildResults(state, state.tab));
}

/**
 * Apply a state change.
 * `rebuildConfig` is false for slider drags -- rebuilding the panel mid-drag
 * would tear the input out from under the pointer.
 */
function applyChange(patch, rebuildConfig = true) {
  Object.assign(state, patch);

  // Design parameters recompute live; the ascent is expensive enough to be
  // explicit, so it stays behind the RUN button.
  const designKeys = [
    'itPower', 'computeProfile', 'missionYears', 'dcAltitude', 'dcInclination',
    'betaAngle', 'solarTech', 'batteryTech', 'junctionTemp', 'electronicsClass',
    'shieldingMm', 'band', 'groundStations', 'transmitPower', 'costVehicle',
  ];
  if (Object.keys(patch).some((k) => designKeys.includes(k))) {
    recomputeDesign();
  }

  // Re-ranking is a sort, not a re-simulation -- do it immediately so the
  // metric selector feels instant on a matrix of hundreds of rows.
  if ((patch.rankKey || patch.rankDir) && state.explore) {
    state.explore.rows = rank(state.explore.rows, state.rankKey, state.rankDir);
    state.explore.sensitivity = sensitivity(state.explore.rows, state.explore.axes, state.rankKey);
    state.explore.groups = groupBy(state.explore.rows, state.explore.groupAxis, state.rankKey);
  }
  if (patch.study) state.explore = null;

  if (rebuildConfig) renderConfig();
  renderResults();
  refreshScene();
}

// ---------------------------------------------------------------------------
// Simulation drivers
// ---------------------------------------------------------------------------

function recomputeDesign() {
  state.design = designDatacenter({
    itPower: state.itPower,
    altitude: state.dcAltitude,
    inclination: state.dcInclination,
    missionYears: state.missionYears,
    computeProfile: state.computeProfile,
    solarTech: state.solarTech,
    batteryTech: state.batteryTech,
    betaAngle: state.betaAngle,
    shieldingMm: state.shieldingMm,
    electronicsClass: state.electronicsClass,
    junctionTemp: state.junctionTemp,
    band: state.band,
    groundStations: state.groundStations,
    transmitPower: state.transmitPower,
  });
  state.comparison = compare(state.design, { launchVehicle: state.costVehicle });
}

function runAscent() {
  const t0 = performance.now();
  state.ascent = simulateAscent({
    vehicle: VEHICLES[state.vehicleId],
    site: LAUNCH_SITES[state.siteId],
    payloadMass: state.payloadMass,
    targetAltitude: state.targetAltitude,
    targetInclination: state.targetInclination,
    reusableBooster: state.reusableBooster,
    guidance: state.guidance,
    f107: state.f107,
    epoch: state.epoch,
    sampleInterval: 1.0,
  });
  state.maxPayload = null;
  state.cursorT = 0;

  const ms = performance.now() - t0;
  console.info(`ascent integrated in ${ms.toFixed(0)} ms, ${state.ascent.samples.length} samples`);
}

function runExplore() {
  const st = STUDIES[state.study];
  const spec = st.spec();
  const isLaunch = st.kind === 'launch';

  const rows = isLaunch ? exploreLaunches(spec) : exploreDesigns(spec);
  const okKey = isLaunch ? 'success' : 'viable';
  const ranked = rank(rows, state.rankKey, state.rankDir);

  // Group by whichever axis has the most levels -- that is usually the one the
  // study is really about.
  const groupAxis = Object.entries(spec.axes)
    .sort((a, b) => b[1].length - a[1].length)[0][0];

  state.explore = {
    axes: spec.axes,
    kind: st.kind,
    rows: ranked,
    okCount: rows.filter((r) => r[okKey]).length,
    pareto: paretoFront(rows.filter((r) => r[okKey]), st.objectives ?? []),
    sensitivity: sensitivity(rows, spec.axes, state.rankKey),
    groups: groupBy(rows, groupAxis, state.rankKey),
    groupAxis,
  };
}

function runMission() {
  const site = LAUNCH_SITES[state.siteId];
  state.mission = simulateMission({
    name: 'Interactive mission',
    itPower: state.itPower,
    altitude: state.dcAltitude,
    inclination: state.dcInclination,
    missionYears: state.missionYears,
    vehicleId: state.vehicleId,
    siteId: state.siteId,
    costVehicle: state.costVehicle,
    recoveryMode: state.recoveryMode,
    design: {
      betaAngle: state.betaAngle,
      shieldingMm: state.shieldingMm,
      electronicsClass: state.electronicsClass,
      solarTech: state.solarTech,
      batteryTech: state.batteryTech,
      junctionTemp: state.junctionTemp,
      band: state.band,
      groundStations: state.groundStations,
      transmitPower: state.transmitPower,
    },
  });
  playback.load(state.mission);
  state.missionProgress = 0;
  state.missionPlaying = true;
  document.getElementById('btn-play').textContent = '❚❚';
}

function runSweep() {
  const altitudes = [300, 400, 500, 600, 700, 800, 1000, 1500, 2000, 3000, 5000,
    8000, 12000, 20200, 35786];
  state.sweep = altitudes.map((km) => {
    const d = designDatacenter({
      itPower: state.itPower,
      altitude: km * 1000,
      inclination: state.dcInclination,
      missionYears: state.missionYears,
      computeProfile: state.computeProfile,
      solarTech: state.solarTech,
      batteryTech: state.batteryTech,
      betaAngle: state.betaAngle,
      shieldingMm: state.shieldingMm,
      electronicsClass: state.electronicsClass,
      junctionTemp: state.junctionTemp,
    });
    return {
      altitude: km * 1000,
      krad: d.radiation.kradPerYear,
      decayYears: d.orbit.decayYears,
      mass: d.mass.total,
      viable: d.viable,
      design: d,
    };
  });
}

// ---------------------------------------------------------------------------
// Scene sync
// ---------------------------------------------------------------------------

function refreshScene() {
  const jd = dateToJulian(state.epoch);
  view.setSunDirection(sunPositionEci(jd));
  view.setEarthRotation(gmst(jd));

  overlays.setLaunchSite(LAUNCH_SITES[state.siteId], view.earth);

  if (state.tab !== 'explore') overlays.setOrbitFamily(null);

  // Mission playback owns the whole scene; the static overlays would only
  // clutter a shot that is already showing the real vehicle and station.
  if (state.tab === 'mission') {
    // Playback owns the globe's rotation and lighting: it has to match the
    // epoch the trajectory was integrated against, not the wall clock.
    overlays.setAscent(null);
    overlays.setGroundTrack(null, view.earth);
    overlays.setDatacenter(null, null);
    overlays.setOrbit(null);
    overlays.setVehicle(null);
    chart.setData(state.mission?.deployment?.reference?.samples ?? null,
                  state.mission?.deployment?.reference?.events ?? []);
    updateHud();
    return;
  }

  if (state.tab === 'launch' && state.ascent) {
    const a = state.ascent;
    overlays.setAscent(a.samples);
    overlays.setOrbit(a.elements, a.success);
    overlays.setGroundTrack(a.samples, view.earth);
    overlays.setDatacenter(null, null);
    chart.setData(a.samples, a.events);
  } else if ((state.tab === 'design' || state.tab === 'analysis') && state.design) {
    overlays.setAscent(null);
    overlays.setGroundTrack(null, view.earth);

    // Draw the datacenter on its design orbit.
    const el = designOrbitElements();
    overlays.setOrbit(el, state.design.viable);
    const { r } = elementsToRv(el);
    overlays.setDatacenter(state.design, r);
    overlays.setVehicle(null);
    chart.setData(null);
  } else if (state.tab === 'explore') {
    overlays.setAscent(null);
    overlays.setGroundTrack(null, view.earth);
    overlays.setDatacenter(null, null);
    overlays.setOrbit(null);
    overlays.setVehicle(null);

    // Only altitude/inclination sweeps have a geometric meaning to draw.
    const rows = state.explore?.rows ?? [];
    const okKey = state.explore?.kind === 'launch' ? 'success' : 'viable';
    const family = rows
      .filter((r) => Number.isFinite(r.altitude ?? r.targetAltitude))
      .slice(0, 120)
      .map((r) => ({
        altitude: r.altitude ?? r.targetAltitude,
        inclination: r.inclination ?? r.targetInclination ?? 0,
        viable: !!r[okKey],
      }));
    overlays.setOrbitFamily(family);
    chart.setData(null);
  } else if (state.tab === 'sweep' && state.sweep) {
    overlays.setAscent(null);
    overlays.setGroundTrack(null, view.earth);
    overlays.setDatacenter(null, null);
    // Show the viable band as a set of orbits.
    const viable = state.sweep.filter((r) => r.viable);
    overlays.setOrbit(viable.length ? sweepOrbitElements(viable[0].altitude) : null, true);
    chart.setData(null);
  }

  updateHud();
}

function designOrbitElements() {
  const a = R_EARTH_EQ + state.dcAltitude;
  return {
    a, e: 0, i: state.dcInclination * DEG, raan: 0.6, argp: 0, nu: 0.9,
    p: a,
  };
}

function sweepOrbitElements(altitude) {
  const a = R_EARTH_EQ + altitude;
  return { a, e: 0, i: state.dcInclination * DEG, raan: 0.6, argp: 0, nu: 0, p: a };
}

let missionHud = null;
const clampUnit = (v) => Math.max(0, Math.min(1, v));

function updateHud() {
  const lines = [];
  if (state.tab === 'mission') {
    if (!state.mission) {
      hud.innerHTML = '<span class="dim">Press RUN MISSION to fly the campaign.<br>' +
        "The vehicle, the station and the ending are all the engine's own output.</span>";
      return;
    }
    const t = missionHud;
    if (t) {
      lines.push(`<span class="hv">${t.phase.toUpperCase()}</span>&nbsp; ${t.clock}`);
      if (t.event) lines.push(`<span class="hv">${t.event}</span>`);
      lines.push('');
      for (const [k, v] of t.lines) {
        lines.push(`${k.padEnd(7).replace(/ /g, '&nbsp;')} <span class="hv">${v}</span>`);
      }
      if (t.scaleNote) {
        lines.push('');
        lines.push(`<span class="dim">${t.scaleNote}</span>`);
      }
    }
    hud.innerHTML = lines.join('<br>');
    return;
  }
  if (state.tab === 'launch') {
    const s = state.ascent ? sampleAt(state.cursorT) : null;
    if (!s) {
      hud.innerHTML =
        '<span class="dim">RUN MISSION to fly the ascent.<br>' +
        'Drag to orbit · scroll to zoom · Space to play</span>';
      return;
    }
    {
      lines.push(`ALT   <span class="hv">${(s.altitude / 1000).toFixed(2)}</span> km`);
      lines.push(`VEL   <span class="hv">${s.speed.toFixed(0)}</span> m/s inertial`);
      lines.push(`AIR   <span class="hv">${s.relativeSpeed.toFixed(0)}</span> m/s relative`);
      lines.push(`Q     <span class="hv">${(s.dynamicPressure / 1000).toFixed(2)}</span> kPa`);
      lines.push(`γ     <span class="hv">${s.flightPathAngle.toFixed(1)}</span>°`);
      lines.push(`MASS  <span class="hv">${(s.mass / 1000).toFixed(1)}</span> t`);
      lines.push(`LAT   <span class="hv">${s.latitude.toFixed(2)}</span>°  LON <span class="hv">${s.longitude.toFixed(2)}</span>°`);
    }
  } else if (state.tab === 'explore') {
    const e = state.explore;
    if (!e) {
      hud.innerHTML = '<span class="dim">Pick a question and press RUN MISSION.</span>';
      return;
    }
    const st = STUDIES[state.study];
    lines.push(`STUDY <span class="hv">${st.name}</span>`);
    lines.push(`CASES <span class="hv">${e.rows.length}</span> evaluated`);
    lines.push(`CLOSE <span class="hv">${e.okCount}</span> (${((e.okCount / e.rows.length) * 100).toFixed(0)}%)`);
    if (e.sensitivity?.length) {
      const top = e.sensitivity[0];
      lines.push(`DRIVER <span class="hv">${top.axis}</span> — ${top.medianFoldChange === Infinity ? '∞' : top.medianFoldChange.toFixed(1)}× spread`);
    }
    lines.push('');
    lines.push('<span class="dim">green orbits close · red do not</span>');
  } else if (state.design) {
    const d = state.design;
    lines.push(`LOAD  <span class="hv">${(d.power.totalPower / 1e6).toFixed(2)}</span> MW`);
    lines.push(`RAD   <span class="hv">${Math.round(d.thermal.area).toLocaleString()}</span> m²`);
    lines.push(`ARRAY <span class="hv">${Math.round(d.power.array.area).toLocaleString()}</span> m²`);
    lines.push(`MASS  <span class="hv">${(d.mass.total / 1000).toFixed(0)}</span> t`);
    lines.push(`SPAN  <span class="hv">${Math.sqrt(d.power.array.area).toFixed(0)}</span> m across`);
    lines.push('');
    lines.push('<span class="dim">scroll to zoom · the structure is drawn to scale</span>');
  }
  hud.innerHTML = lines.join('<br>');
}

function sampleAt(t) {
  const s = state.ascent?.samples;
  if (!s?.length) return null;
  let lo = 0;
  let hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid].t < t) lo = mid + 1; else hi = mid;
  }
  return s[lo];
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

function setCursor(t) {
  state.cursorT = t;
  chart.setCursor(t);

  const s = sampleAt(t);
  if (s) {
    overlays.setVehicle(s.r);
    clockEl.textContent = `T+${t.toFixed(1)} s`;
    if (state.followVehicle) view.focusOn(vecToScene(s.r), 400e3);
  }
  updateHud();
}

function setMissionCursor(p) {
  state.missionProgress = clampUnit(p);
  const t = playback.update(state.missionProgress, 0.016);
  if (t) { missionHud = t; clockEl.textContent = t.clock; }
  updateHud();
}

document.getElementById('btn-play').addEventListener('click', (e) => {
  if (state.tab === 'mission') {
    if (state.missionProgress >= 1) state.missionProgress = 0;
    state.missionPlaying = !state.missionPlaying;
    e.target.textContent = state.missionPlaying ? '❚❚' : '▶';
    return;
  }
  state.playing = !state.playing;
  e.target.textContent = state.playing ? '❚❚' : '▶';
});

scrub.addEventListener('input', (e) => {
  if (state.tab === 'mission') {
    state.missionPlaying = false;
    document.getElementById('btn-play').textContent = '▶';
    setMissionCursor(Number(e.target.value) / 1000);
    return;
  }
  const total = state.ascent?.summary.flightTime ?? 1;
  setCursor((Number(e.target.value) / 1000) * total);
  state.playing = false;
  document.getElementById('btn-play').textContent = '▶';
});

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.tab = btn.dataset.tab;
    renderConfig();
    renderResults();
    refreshScene();

    if (state.tab === 'mission') {
      // Playback drives the camera itself; hand it over from wherever the
      // user was and let it fly.
      if (!state.mission) runMission();
      else playback.load(state.mission);
      state.missionProgress = 0;
      state.missionPlaying = true;
      document.getElementById('btn-play').textContent = '❚❚';
      renderResults();
      return;
    }
    playback.clear();

    if (state.tab === 'design' || state.tab === 'analysis') {
      const { r } = elementsToRv(designOrbitElements());
      view.focusOn(vecToScene(r), 2500);
    } else {
      view.focusEarth();
      if (state.tab === 'explore') view.frameRadius(45000e3, 1.1);
    }
  });
});

document.querySelectorAll('.chip').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    chartSeries = btn.dataset.chart;
    chart.setSeries(chartSeries);
  });
});

const btnRun = document.getElementById('btn-run');
btnRun.addEventListener('click', () => {
  btnRun.disabled = true;
  btnRun.textContent = 'INTEGRATING…';
  // Yield to the event loop so the disabled/busy button paints before the
  // (synchronous) solve blocks it. Deliberately setTimeout and not
  // requestAnimationFrame: rAF is throttled whenever the page is not actually
  // painting -- a background tab, an offscreen window -- and the whole run
  // would silently never start.
  setTimeout(() => {
    try {
      if (state.tab === 'mission') runMission();
      else if (state.tab === 'explore') runExplore();
      else if (state.tab === 'sweep') runSweep();
      else {
        runAscent();
        recomputeDesign();
      }
      renderResults();
      refreshScene();
      if (state.ascent) setCursor(0);
    } finally {
      btnRun.disabled = false;
      btnRun.textContent = 'RUN MISSION';
    }
  }, 0);
});

const btnMax = document.getElementById('btn-maxpayload');
btnMax.addEventListener('click', () => {
  btnMax.disabled = true;
  btnMax.textContent = 'SEARCHING…';
  setTimeout(() => {
    try {
      state.maxPayload = findMaxPayload({
        vehicle: VEHICLES[state.vehicleId],
        site: LAUNCH_SITES[state.siteId],
        targetAltitude: state.targetAltitude,
        targetInclination: state.targetInclination,
        reusableBooster: state.reusableBooster,
        guidance: state.guidance,
        f107: state.f107,
        epoch: state.epoch,
        sampleInterval: 4,
      });
      if (state.maxPayload.result) {
        state.ascent = state.maxPayload.result;
        state.payloadMass = Math.round(state.maxPayload.payload);
      }
      renderConfig();
      renderResults();
      refreshScene();
      setCursor(0);
    } finally {
      btnMax.disabled = false;
      btnMax.textContent = 'FIND MAX PAYLOAD';
    }
  }, 0);
});

// Modal
const modal = document.getElementById('modal');
document.getElementById('btn-help').addEventListener('click', () => {
  document.getElementById('modal-body').innerHTML = MODELS_DOC;
  modal.classList.remove('hidden');
});
document.getElementById('modal-close').addEventListener('click', () => modal.classList.add('hidden'));
modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

addEventListener('keydown', (e) => {
  if (e.key === 'Escape') modal.classList.add('hidden');
  if (e.key === ' ' && !['INPUT', 'SELECT'].includes(e.target.tagName)) {
    e.preventDefault();
    document.getElementById('btn-play').click();
  }
  if (e.key === 'f') {
    state.followVehicle = !state.followVehicle;
    if (!state.followVehicle) view.focusEarth();
  }
});

// ---------------------------------------------------------------------------
// Animation loop
// ---------------------------------------------------------------------------

let last = performance.now();
const PLAYBACK_RATE = 8; // simulated seconds per wall-clock second

/**
 * Draw the tracking camera into the inset rectangle.
 *
 * The frame is a DOM element so it can carry a border and a label; the pixels
 * inside it come from a second scissored pass over the same scene, which is
 * why the box has to stay transparent and why #viewport spans the whole
 * window (canvas coordinates and page coordinates are then the same thing).
 */
function drawInset(frame) {
  const show = !!(frame && frame.track);
  insetEl.classList.toggle('hidden', !show);
  if (!show) return;
  insetLabel.textContent = frame.track;
  insetScale.textContent = frame.trackNote ?? 'TRUE SCALE';
  const r = insetEl.getBoundingClientRect();
  view.renderInset(r.left, r.top, r.width, r.height);
}

function loop(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  if (state.tab === 'mission') {
    let frame = null;
    if (state.mission) {
      if (state.missionPlaying) {
        // 52 seconds of wall clock for the whole campaign at 1x.
        state.missionProgress += (dt * state.missionSpeed) / 52;
        if (state.missionProgress >= 1) {
          state.missionProgress = 1;
          state.missionPlaying = false;
          document.getElementById('btn-play').textContent = '▶';
          renderResults();
        }
        scrub.value = String(state.missionProgress * 1000);
      }
      frame = playback.update(state.missionProgress, dt);
      if (frame) { missionHud = frame; clockEl.textContent = frame.clock; updateHud(); }
    }
    view.render();
    // The tracking camera is scissored into the main canvas AFTER the wide
    // shot, so it must come after view.render() -- the composer writes the
    // whole framebuffer and would erase it otherwise.
    drawInset(frame);
    requestAnimationFrame(loop);
    return;
  }

  insetEl.classList.add('hidden');

  if (state.playing && state.ascent) {
    const total = state.ascent.summary.flightTime;
    let t = state.cursorT + dt * PLAYBACK_RATE;
    if (t >= total) { t = total; state.playing = false; document.getElementById('btn-play').textContent = '▶'; }
    setCursor(t);
    scrub.value = String((t / total) * 1000);
  }

  document.getElementById('epoch-readout').textContent =
    state.epoch.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  view.render();
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

recomputeDesign();
renderConfig();
renderResults();
refreshScene();
chart.setSeries(chartSeries);
requestAnimationFrame(loop);

setTimeout(() => document.getElementById('boot').classList.add('done'), 220);
