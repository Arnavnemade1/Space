#!/usr/bin/env node
/**
 * Scenario harness — grade a design against every documented failure mode.
 *
 *   node tools/scenarios.mjs                              # the built-in cases
 *   node tools/scenarios.mjs --alt 550e3 --inc 51.6       # one config
 *   node tools/scenarios.mjs --power 100e6 --solve thermal
 *   node tools/scenarios.mjs --alt 2500e3 --auto          # compose fixes
 *   node tools/scenarios.mjs --json out.json
 *
 * The engine lives in src/sim/scenarios.js and is pure, so scaling this from a
 * handful of cases to a few thousand fanned out across agents needs a longer
 * list here and no change to the model.
 */

import { writeFileSync } from 'node:fs';
import {
  SCENARIOS, assess, solve, solveAll, autoResolve,
} from '../src/sim/scenarios.js';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

const BADGE = {
  viable: C.green('  VIABLE  '),
  marginal: C.yellow(' MARGINAL '),
  fail: C.red('   FAIL   '),
};

/** The cases the README calls out by name. */
export const CASES = {
  sso: {
    name: 'Dawn–dusk sun-synchronous baseline',
    note: 'The architecture the physics favours: continuously sunlit, above the drag regime, below the belt.',
    cfg: { itPower: 10e6, altitude: 700e3, inclination: 97.9, missionYears: 10, betaAngle: Math.PI / 2 },
  },
  eclipse: {
    name: 'Mid-inclination eclipse tax',
    note: 'The README\'s battery case: 550 km at 51.6 deg spends about a third of every orbit in shadow.',
    cfg: { itPower: 10e6, altitude: 550e3, inclination: 51.6, missionYears: 10 },
  },
  belt: {
    name: 'Inner proton belt',
    note: 'Between 1,000 and 10,000 km the dose rate makes commercial silicon a consumable.',
    cfg: { itPower: 10e6, altitude: 2500e3, inclination: 51.6, missionYears: 10 },
  },
  drag: {
    name: 'Low orbit drag',
    note: 'A big, light structure at 400 km is a sail. Station-keeping dominates the propellant budget.',
    cfg: { itPower: 10e6, altitude: 400e3, inclination: 51.6, missionYears: 10 },
  },
  scale: {
    name: 'Hundred-megawatt scaling',
    note: 'Radiator area is linear in IT power, so the thermal problem scales exactly as the compute does.',
    cfg: { itPower: 100e6, altitude: 700e3, inclination: 97.9, missionYears: 10, betaAngle: Math.PI / 2 },
  },
};

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const arg = (flag, fallback = null) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (flag) => argv.includes(flag);
const num = (s) => (s == null ? null : Number(String(s).replace(/_/g, '')));

function report(label, note, cfg) {
  const a = assess(cfg);
  console.log(`\n${C.bold(label)}`);
  if (note) console.log(C.dim(`  ${note}`));
  console.log(C.dim(`  ${(cfg.itPower / 1e6).toFixed(0)} MW · ${(cfg.altitude / 1000).toFixed(0)} km · `
    + `${cfg.inclination.toFixed(1)}° · ${cfg.missionYears} yr`));
  console.log();
  for (const v of a.verdicts) {
    console.log(`  ${BADGE[v.status]}  ${C.cyan(v.name.padEnd(22))} ${v.headline}`);
  }
  const overall = a.verdict === 'viable' ? C.green('VIABLE')
    : a.verdict === 'marginal' ? C.yellow('MARGINAL') : C.red('NOT VIABLE');
  console.log(`\n  ${C.bold('Overall:')} ${overall}   `
    + C.dim(`${a.counts.viable} viable · ${a.counts.marginal} marginal · ${a.counts.fail} failing`));
  return a;
}

function reportSolve(cfg, id) {
  const s = solve(cfg, id);
  console.log(`\n${C.bold(`Fixing: ${s.scenario.name}`)}  ${BADGE[s.before.status]}`);
  console.log(C.dim(`  now: ${s.before.headline}\n`));
  for (const o of s.options) {
    const mark = o.cleared ? C.green('✓') : o.resolved ? C.yellow('~') : C.dim('·');
    const tag = o.remedy.kind === 'descope' ? C.dim(' [descope]') : '';
    console.log(`  ${mark} ${C.cyan(o.remedy.name)}${tag}`);
    console.log(`      ${o.from} → ${o.to}   ${o.headline}`);
    console.log(C.dim(`      ${o.remedy.summary}`));
    if (Math.abs(o.deltaMassKg) > 500) {
      console.log(C.dim(`      mass ${o.deltaMassKg > 0 ? '+' : ''}${(o.deltaMassKg / 1000).toFixed(0)} t`));
    }
    for (const se of o.sideEffects) {
      console.log(`      ${C.red('breaks')} ${se.id}: ${se.from} → ${se.to}`);
    }
    console.log();
  }
  return s;
}

function reportAuto(cfg) {
  const r = autoResolve(cfg);
  console.log(`\n${C.bold('Auto-resolve')} ${C.dim('(greedy: best non-regressing fix each round)')}\n`);
  if (!r.applied.length) console.log(C.dim('  nothing applied'));
  for (const a of r.applied) {
    console.log(`  ${C.green('+')} ${C.cyan(a.name)} ${C.dim(`[${a.scenario} ${a.from} → ${a.to}]`)}`);
  }
  console.log();
  for (const v of r.assessment.verdicts) {
    console.log(`  ${BADGE[v.status]}  ${C.cyan(v.name.padEnd(22))} ${v.headline}`);
  }
  if (r.reason) console.log(`\n  ${C.red('Stuck:')} ${r.reason}`);
  else console.log(`\n  ${C.green('Converged to a viable design.')}`);
  return r;
}

// --------------------------------------------------------------------- main
const out = {};

if (has('--list')) {
  console.log(C.bold('\nScenarios\n'));
  for (const s of SCENARIOS) {
    console.log(`  ${C.cyan(s.id.padEnd(14))} ${s.name}`);
    console.log(C.dim(`  ${''.padEnd(14)} fails when: ${s.failure}`));
    console.log(C.dim(`  ${''.padEnd(14)} viable when: ${s.viableWhen}`));
    console.log(C.dim(`  ${''.padEnd(14)} remedies: ${s.remedies.map((r) => r.id).join(', ')}\n`));
  }
  process.exit(0);
}

const altitude = num(arg('--alt'));
const custom = altitude != null || arg('--power') != null || arg('--inc') != null;

if (custom) {
  const cfg = {
    itPower: num(arg('--power')) ?? 10e6,
    altitude: altitude ?? 700e3,
    inclination: num(arg('--inc')) ?? 97.9,
    missionYears: num(arg('--years')) ?? 10,
  };
  if (Math.abs(cfg.inclination - 97.9) < 1.5) cfg.betaAngle = Math.PI / 2;

  out.assessment = report('Custom configuration', null, cfg);
  const which = arg('--solve');
  if (which) out.solution = reportSolve(cfg, which);
  else if (has('--solve-all')) out.solutions = solveAll(cfg);
  if (has('--auto')) out.auto = reportAuto(cfg);
} else {
  const only = arg('--only');
  const cases = only ? { [only]: CASES[only] } : CASES;
  out.cases = {};
  for (const [key, c] of Object.entries(cases)) {
    if (!c) { console.error(`unknown case: ${only}`); process.exit(1); }
    out.cases[key] = report(c.name, c.note, c.cfg);
    if (has('--auto')) reportAuto(c.cfg);
  }
}

const jsonPath = arg('--json');
if (jsonPath) {
  writeFileSync(jsonPath, JSON.stringify(out, (k, v) => (k === 'design' ? undefined : v), 2));
  console.log(C.dim(`\nwrote ${jsonPath}`));
}
console.log();
