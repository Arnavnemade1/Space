/**
 * Numerical integrators for the equations of motion.
 *
 * Two are provided because the two simulation phases have different needs:
 *
 *  - Ascent is stiff-ish and event-heavy (staging, fairing jettison, throttle
 *    changes, ground impact). It runs on adaptive Dormand-Prince 5(4) with
 *    bisection root-finding on events, so a staging event lands on the exact
 *    time rather than being smeared across a step.
 *
 *  - Long-duration orbit propagation runs on the same integrator with a looser
 *    tolerance. Fixed-step RK4 is kept for reproducible comparisons and for
 *    unit-testing the adaptive scheme against a known-order method.
 *
 * A note on why not symplectic: symplectic integrators (leapfrog, Yoshida)
 * conserve energy beautifully for conservative systems, but this simulation is
 * explicitly non-conservative -- drag removes energy, thrust adds it, and mass
 * changes. Their advantage does not apply, and DOPRI5's error control does.
 */

/**
 * Classical fourth-order Runge-Kutta, fixed step.
 *
 * @param {(t:number, y:number[]) => number[]} f derivative function
 * @param {number} t current time
 * @param {number[]} y current state
 * @param {number} h step size
 * @returns {number[]} state at t + h
 */
export function rk4Step(f, t, y, h) {
  const n = y.length;
  const k1 = f(t, y);

  const y2 = new Array(n);
  for (let i = 0; i < n; i++) y2[i] = y[i] + (h / 2) * k1[i];
  const k2 = f(t + h / 2, y2);

  const y3 = new Array(n);
  for (let i = 0; i < n; i++) y3[i] = y[i] + (h / 2) * k2[i];
  const k3 = f(t + h / 2, y3);

  const y4 = new Array(n);
  for (let i = 0; i < n; i++) y4[i] = y[i] + h * k3[i];
  const k4 = f(t + h, y4);

  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = y[i] + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dormand-Prince 5(4) -- Butcher tableau
// ---------------------------------------------------------------------------

const DP_C = [0, 1 / 5, 3 / 10, 4 / 5, 8 / 9, 1, 1];

const DP_A = [
  [],
  [1 / 5],
  [3 / 40, 9 / 40],
  [44 / 45, -56 / 15, 32 / 9],
  [19372 / 6561, -25360 / 2187, 64448 / 6561, -212 / 729],
  [9017 / 3168, -355 / 33, 46732 / 5247, 49 / 176, -5103 / 18656],
  [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84],
];

/** Fifth-order solution weights (also row 7 of A -- the FSAL property). */
const DP_B5 = [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84, 0];

/** Fourth-order embedded solution weights, used only for the error estimate. */
const DP_B4 = [
  5179 / 57600,
  0,
  7571 / 16695,
  393 / 640,
  -92097 / 339200,
  187 / 2100,
  1 / 40,
];

/**
 * One Dormand-Prince 5(4) step.
 *
 * @returns {{y:number[], yLow:number[], k:number[][], error:number}}
 *          `y` is the 5th-order solution that is actually propagated,
 *          `error` is the infinity-norm of the 5th/4th difference.
 */
export function dopri5Step(f, t, y, h, k1) {
  const n = y.length;
  const k = new Array(7);
  k[0] = k1 ?? f(t, y);

  for (let s = 1; s < 7; s++) {
    const ys = new Array(n);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let j = 0; j < s; j++) acc += DP_A[s][j] * k[j][i];
      ys[i] = y[i] + h * acc;
    }
    k[s] = f(t + DP_C[s] * h, ys);
  }

  const y5 = new Array(n);
  const y4 = new Array(n);
  for (let i = 0; i < n; i++) {
    let a5 = 0;
    let a4 = 0;
    for (let s = 0; s < 7; s++) {
      a5 += DP_B5[s] * k[s][i];
      a4 += DP_B4[s] * k[s][i];
    }
    y5[i] = y[i] + h * a5;
    y4[i] = y[i] + h * a4;
  }

  return { y: y5, yLow: y4, k };
}

/**
 * Adaptive-step propagation with optional event detection.
 *
 * @param {object} cfg
 * @param {(t:number,y:number[])=>number[]} cfg.f  derivative function
 * @param {number} cfg.t0        start time
 * @param {number[]} cfg.y0      initial state
 * @param {number} cfg.tEnd      end time (may be Infinity if an event stops it)
 * @param {number} [cfg.h0]      initial step guess
 * @param {number} [cfg.rtol]    relative tolerance per component
 * @param {number} [cfg.atol]    absolute tolerance per component
 * @param {number} [cfg.hMin]    smallest permitted step
 * @param {number} [cfg.hMax]    largest permitted step
 * @param {number} [cfg.maxSteps] safety cap on iterations
 * @param {(t:number,y:number[])=>void} [cfg.onStep] called on every accepted step
 * @param {Array<{name:string, g:(t:number,y:number[])=>number,
 *                terminal?:boolean, direction?:number}>} [cfg.events]
 *        Root functions. A sign change in `g` between two accepted steps is
 *        bracketed and refined by bisection to `eventTol` seconds.
 * @param {number} [cfg.eventTol] event time resolution [s]
 *
 * @returns {{t:number, y:number[], steps:number, rejected:number,
 *            events:Array<{name:string,t:number,y:number[]}>, status:string}}
 */
export function propagate(cfg) {
  const {
    f,
    t0,
    y0,
    tEnd,
    h0 = 1,
    rtol = 1e-9,
    atol = 1e-6,
    hMin = 1e-6,
    hMax = 300,
    maxSteps = 2_000_000,
    onStep,
    events = [],
    eventTol = 1e-4,
  } = cfg;

  let t = t0;
  let y = y0.slice();
  let h = Math.min(h0, hMax);
  let steps = 0;
  let rejected = 0;
  const firedEvents = [];

  let k1 = f(t, y);
  let gPrev = events.map((e) => e.g(t, y));

  onStep?.(t, y);

  while (t < tEnd && steps < maxSteps) {
    if (t + h > tEnd) h = tEnd - t;

    const { y: yNext, yLow, k } = dopri5Step(f, t, y, h, k1);

    // Scaled error norm (Hairer-Norsett-Wanner formulation).
    let err = 0;
    for (let i = 0; i < y.length; i++) {
      const sc = atol + rtol * Math.max(Math.abs(y[i]), Math.abs(yNext[i]));
      const e = (yNext[i] - yLow[i]) / sc;
      err += e * e;
    }
    err = Math.sqrt(err / y.length);

    if (err <= 1 || h <= hMin * 1.0000001) {
      const tNext = t + h;

      // --- event detection on the accepted step -----------------------------
      let terminated = null;
      if (events.length) {
        const gNext = events.map((e) => e.g(tNext, yNext));
        for (let ei = 0; ei < events.length; ei++) {
          const ev = events[ei];
          const a = gPrev[ei];
          const b = gNext[ei];
          if (a === 0 || a * b >= 0) continue;
          const dir = b > a ? 1 : -1;
          if (ev.direction && ev.direction !== dir) continue;

          // Bisect on the dense-ish bracket. We re-integrate from (t, y) with a
          // trial step rather than interpolating, so the root satisfies the
          // same dynamics as the trajectory itself.
          let lo = 0;
          let hi = h;
          let yRoot = yNext;
          let tRoot = tNext;
          for (let it = 0; it < 60 && hi - lo > eventTol; it++) {
            const mid = 0.5 * (lo + hi);
            const trial = dopri5Step(f, t, y, mid, k1).y;
            const gMid = ev.g(t + mid, trial);
            if (a * gMid <= 0) {
              hi = mid;
              yRoot = trial;
              tRoot = t + mid;
            } else {
              lo = mid;
            }
          }
          firedEvents.push({ name: ev.name, t: tRoot, y: yRoot.slice() });
          if (ev.terminal) {
            terminated = { t: tRoot, y: yRoot };
            break;
          }
        }
        gPrev = gNext;
      }

      if (terminated) {
        onStep?.(terminated.t, terminated.y);
        return {
          t: terminated.t,
          y: terminated.y,
          steps,
          rejected,
          events: firedEvents,
          status: 'event',
        };
      }

      t = tNext;
      y = yNext;
      k1 = k[6]; // FSAL: last stage equals f(t_next, y_next)
      onStep?.(t, y);
    } else {
      rejected++;
    }

    // PI-free step size control with standard safety and clamping factors.
    const factor = err === 0 ? 5 : 0.9 * Math.pow(1 / err, 1 / 5);
    h *= Math.min(5, Math.max(0.2, factor));
    h = Math.max(hMin, Math.min(hMax, h));
    steps++;
  }

  return {
    t,
    y,
    steps,
    rejected,
    events: firedEvents,
    status: steps >= maxSteps ? 'max-steps' : 'complete',
  };
}
