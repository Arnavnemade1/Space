#!/usr/bin/env node
/**
 * Parameter-space explorer CLI.
 *
 *   node tools/explore.mjs                          # list available studies
 *   node tools/explore.mjs orbitBand                # run a built-in study
 *   node tools/explore.mjs orbitBand --csv out.csv  # export
 *   node tools/explore.mjs orbitBand --top 20 --rank totalMassT
 *   node tools/explore.mjs --custom design \
 *        --axis altitude=400e3,700e3,1200e3 \
 *        --axis itPower=1e6,1e7,1e8 \
 *        --base inclination=97.9,missionYears=10
 *
 * Everything prints as a table; --csv and --json write files for anything you
 * want to take elsewhere.
 */

import { writeFileSync } from 'node:fs';
import {
  STUDIES, exploreDesigns, exploreLaunches, rank, paretoFront, groupBy,
  sensitivity, toCsv, toJson, matrixSize, maxPayload,
} from '../src/sim/explore.js';
import { VEHICLES, LAUNCH_SITES } from '../src/sim/vehicles.js';

// ---------------------------------------------------------------------------
// argument parsing
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);
const collect = (name) => argv.reduce((acc, a, i) =>
  a === `--${name}` && argv[i + 1] ? [...acc, argv[i + 1]] : acc, []);

const studyName = argv.find((a) => !a.startsWith('--') &&
  !argv.some((f, i) => argv[i + 1] === a && f.startsWith('--')));

// ---------------------------------------------------------------------------
// table printing
// ---------------------------------------------------------------------------
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

function fmt(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? C.green('yes') : C.red('no');
  if (typeof v !== 'number') return String(v);
  if (!Number.isFinite(v)) return v > 0 ? '∞' : '-∞';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'G';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(1) + 'k';
  if (a >= 100) return v.toFixed(0);
  if (a >= 1) return v.toFixed(2);
  if (a >= 0.001) return v.toFixed(4);
  return v.toExponential(2);
}

const visLen = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '').length;

function table(rows, columns) {
  if (!rows.length) { console.log(C.dim('  (no rows)')); return; }
  const cols = columns ?? Object.keys(rows[0]).filter((k) => !k.startsWith('_'));
  const cells = rows.map((r) => cols.map((c) => fmt(r[c])));
  const widths = cols.map((c, i) =>
    Math.max(visLen(c), ...cells.map((row) => visLen(row[i]))));

  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - visLen(s)));
  console.log('  ' + cols.map((c, i) => C.dim(pad(c, widths[i]))).join('  '));
  console.log('  ' + widths.map((w) => C.dim('─'.repeat(w))).join('  '));
  for (const row of cells) {
    console.log('  ' + row.map((v, i) => pad(v, widths[i])).join('  '));
  }
}

// ---------------------------------------------------------------------------
// study listing
// ---------------------------------------------------------------------------
if (!studyName && !has('custom')) {
  console.log('\n' + C.bold('ORBITAL DATACENTER TESTBED — parameter explorer') + '\n');
  console.log('Built-in studies:\n');
  for (const [key, s] of Object.entries(STUDIES)) {
    const size = matrixSize(s.spec().axes);
    console.log(`  ${C.cyan(key.padEnd(18))} ${s.name}`);
    console.log(`  ${' '.repeat(18)} ${C.dim(`${s.kind} sweep · ${size} combinations`)}`);
  }
  console.log(`
${C.bold('Usage')}
  node tools/explore.mjs <study> [--top N] [--rank KEY] [--csv FILE] [--json FILE]
  node tools/explore.mjs <study> --viable-only --pareto
  node tools/explore.mjs --custom design --axis altitude=400e3,800e3 --base itPower=1e7
  node tools/explore.mjs --maxpayload --vehicle falcon9 --site ksc --alt 500e3

${C.bold('Vehicles')}  ${Object.keys(VEHICLES).join(', ')}
${C.bold('Sites')}     ${Object.keys(LAUNCH_SITES).join(', ')}
`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// max payload mode
// ---------------------------------------------------------------------------
if (has('maxpayload')) {
  const vehicles = flag('vehicle') ? flag('vehicle').split(',') : Object.keys(VEHICLES);
  const sites = flag('site') ? flag('site').split(',') : ['ksc'];
  const alt = Number(flag('alt', '500e3'));
  const inc = Number(flag('inc', 'NaN'));

  console.log(`\n${C.bold('MAXIMUM PAYLOAD')}  target ${alt / 1000} km circular\n`);
  const rows = [];
  for (const v of vehicles) {
    for (const s of sites) {
      const site = LAUNCH_SITES[s];
      const targetInclination = Number.isFinite(inc) ? inc : Math.abs(site.latitude);
      const r = maxPayload({
        vehicle: v, site: s, targetAltitude: alt, targetInclination,
      });
      rows.push({
        vehicle: v,
        site: s,
        incDeg: targetInclination,
        simulatedKg: Math.round(r.payload),
        publishedKg: VEHICLES[v].payloadLeoExpendable,
        ratio: r.payload / VEHICLES[v].payloadLeoExpendable,
        confidence: VEHICLES[v].confidence,
      });
      process.stderr.write('.');
    }
  }
  process.stderr.write('\n\n');
  table(rank(rows, 'simulatedKg', 'max'));
  console.log(`\n${C.dim('Published figures are to the operator\'s own reference orbit, which is')}`);
  console.log(`${C.dim('generally lower than the one swept here — expect ratios below 1.')}\n`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// build the sweep
// ---------------------------------------------------------------------------
let kind;
let spec;
let objectives;
let title;

if (has('custom')) {
  kind = flag('custom', 'design');
  const axes = {};
  for (const a of collect('axis')) {
    const [k, list] = a.split('=');
    axes[k] = list.split(',').map((x) => (Number.isNaN(Number(x)) ? x : Number(x)));
  }
  const base = {};
  for (const b of (flag('base') ?? '').split(',').filter(Boolean)) {
    const [k, val] = b.split('=');
    base[k] = Number.isNaN(Number(val)) ? val : Number(val);
  }
  spec = { axes, base };
  objectives = null;
  title = 'custom sweep';
} else {
  const study = STUDIES[studyName];
  if (!study) {
    console.error(`Unknown study "${studyName}". Run without arguments to list them.`);
    process.exit(1);
  }
  kind = study.kind;
  spec = study.spec();
  objectives = study.objectives;
  title = study.name;
}

const size = matrixSize(spec.axes);
console.log(`\n${C.bold(title)}`);
console.log(C.dim(`${kind} sweep · ${size} combinations · axes: ${Object.keys(spec.axes).join(', ')}\n`));

const t0 = Date.now();
const rows = kind === 'launch' ? exploreLaunches(spec) : exploreDesigns(spec);
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

const okKey = kind === 'launch' ? 'success' : 'viable';
const okCount = rows.filter((r) => r[okKey]).length;
console.log(C.dim(`evaluated in ${elapsed}s — ${okCount}/${rows.length} ${kind === 'launch' ? 'reached orbit' : 'close'}\n`));

let view = has('viable-only') ? rows.filter((r) => r[okKey]) : rows;

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------
const rankKey = flag('rank');
if (rankKey) view = rank(view, rankKey, flag('dir', 'min'));

const top = Number(flag('top', '0'));

const axisCols = Object.keys(spec.axes);
const metricCols = kind === 'launch'
  ? ['success', 'status', 'achievedAltitudeKm', 'inclinationDeg', 'maxQkPa', 'maxG',
     'dvIdeal', 'dvGravityLoss', 'dvSteeringLoss', 'liftoffTW']
  : ['viable', 'blockedBy', 'totalMassT', 'radiatorArea', 'arrayArea', 'decayYears',
     'kradPerYear', 'launches', 'costUsd', 'costRatio'];

if (has('pareto') && objectives) {
  const front = paretoFront(view.filter((r) => r[okKey]), objectives);
  console.log(C.bold(`PARETO FRONT  (${objectives.map(([k, d]) => `${d} ${k}`).join(', ')})\n`));
  table(rank(front, objectives[0][0], objectives[0][1]), [...axisCols, ...metricCols]);
  console.log(C.dim(`\n  ${front.length} non-dominated of ${view.filter((r) => r[okKey]).length} viable`));
} else {
  table(top > 0 ? view.slice(0, top) : view, [...axisCols, ...metricCols]);
}

// ---------------------------------------------------------------------------
// analysis
// ---------------------------------------------------------------------------
if (has('analyse') || has('analyze')) {
  const metric = flag('metric', kind === 'launch' ? 'dvIdeal' : 'totalMassT');

  console.log(`\n${C.bold('SENSITIVITY')}  ${C.dim(`fold-change in ${metric} when each axis varies alone`)}\n`);
  table(sensitivity(rows, spec.axes, metric));

  for (const axis of Object.keys(spec.axes)) {
    console.log(`\n${C.bold('BY ' + axis.toUpperCase())}\n`);
    table(groupBy(rows, axis, metric));
  }
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------
if (flag('csv')) {
  writeFileSync(flag('csv'), toCsv(rows));
  console.log(C.green(`\n✓ wrote ${rows.length} rows to ${flag('csv')}`));
}
if (flag('json')) {
  writeFileSync(flag('json'), toJson(rows));
  console.log(C.green(`✓ wrote ${rows.length} rows to ${flag('json')}`));
}
console.log('');
