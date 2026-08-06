/**
 * Canvas 2D telemetry plots.
 *
 * Deliberately plain: one series, linear axes, a scrub cursor. The point of a
 * telemetry strip chart is to be read quickly, not to be decorative.
 */

const CSS = {
  grid: 'rgba(255,255,255,0.055)',
  axis: '#445266',
  text: '#6b7c94',
  line: '#4dd0e1',
  cursor: '#ffc75a',
  fill: 'rgba(77,208,225,0.10)',
};

const SERIES = {
  altitude: { label: 'ALTITUDE', unit: 'km', scale: 1e-3, color: '#4dd0e1' },
  speed: { label: 'INERTIAL SPEED', unit: 'm/s', scale: 1, color: '#5ee08a' },
  dynamicPressure: { label: 'DYNAMIC PRESSURE', unit: 'kPa', scale: 1e-3, color: '#ffc75a' },
  axialAccel: { label: 'AXIAL ACCELERATION', unit: 'g', scale: 1 / 9.80665, color: '#ff8f6b' },
  angleOfAttack: { label: 'ANGLE OF ATTACK', unit: 'deg', scale: 1, color: '#c98fff' },
};

export function createChart(canvas) {
  const ctx = canvas.getContext('2d');
  let samples = [];
  let key = 'altitude';
  let cursorT = 0;
  let events = [];

  function resize() {
    const dpr = Math.min(devicePixelRatio, 2);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, rect.width * dpr);
    canvas.height = Math.max(1, rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function setData(s, ev = []) {
    samples = s ?? [];
    events = ev ?? [];
    draw();
  }

  function setSeries(k) { key = k; draw(); }
  function setCursor(t) { cursorT = t; draw(); }

  function draw() {
    const rect = canvas.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;
    ctx.clearRect(0, 0, W, H);
    if (!samples.length) {
      ctx.fillStyle = CSS.text;
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('NO TELEMETRY — RUN A MISSION', W / 2, H / 2);
      return;
    }

    const padL = 54;
    const padR = 14;
    const padT = 16;
    const padB = 22;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const tMin = samples[0].t;
    const tMax = samples[samples.length - 1].t || 1;

    // --- assemble the series ------------------------------------------------
    let series;
    let label;
    let unit;
    let color;

    if (key === 'losses') {
      // Cumulative delta-v losses, drawn as stacked bands. Reading them as
      // areas rather than lines makes the relative cost of gravity, drag and
      // steering immediately comparable.
      return drawLosses();
    }

    const cfg = SERIES[key] ?? SERIES.altitude;
    label = cfg.label; unit = cfg.unit; color = cfg.color;
    series = samples.map((s) => (s[key] ?? 0) * cfg.scale);

    const vMax = Math.max(...series.filter(Number.isFinite), 1e-9);
    const vMin = Math.min(0, ...series.filter(Number.isFinite));
    const span = vMax - vMin || 1;
    const nice = niceCeil(vMax);

    const X = (t) => padL + ((t - tMin) / (tMax - tMin)) * plotW;
    const Y = (v) => padT + plotH - ((v - vMin) / (nice - vMin || 1)) * plotH;

    drawFrame(X, Y, tMin, tMax, vMin, nice, padL, padT, plotW, plotH, label, unit);

    // Filled area under the curve.
    ctx.beginPath();
    ctx.moveTo(X(tMin), Y(vMin));
    samples.forEach((s, i) => {
      if (Number.isFinite(series[i])) ctx.lineTo(X(s.t), Y(series[i]));
    });
    ctx.lineTo(X(tMax), Y(vMin));
    ctx.closePath();
    ctx.fillStyle = color + '1e';
    ctx.fill();

    ctx.beginPath();
    let started = false;
    samples.forEach((s, i) => {
      if (!Number.isFinite(series[i])) return;
      if (!started) { ctx.moveTo(X(s.t), Y(series[i])); started = true; }
      else ctx.lineTo(X(s.t), Y(series[i]));
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    drawEvents(X, padT, plotH);
    drawCursor(X, padT, plotH, series, Y, color, unit);

    // ------------------------------------------------------------------
    function drawLosses() {
      const bands = [
        ['GRAVITY', 'dvGravityLoss', '#ff8f6b'],
        ['DRAG', 'dvDragLoss', '#ffc75a'],
        ['STEERING', 'dvSteeringLoss', '#c98fff'],
      ];
      const totals = samples.map((s) =>
        (s.dvGravityLoss ?? 0) + (s.dvDragLoss ?? 0) + (s.dvSteeringLoss ?? 0));
      const maxTotal = niceCeil(Math.max(...totals, 1));

      const Xl = (t) => padL + ((t - tMin) / (tMax - tMin)) * plotW;
      const Yl = (v) => padT + plotH - (v / maxTotal) * plotH;

      drawFrame(Xl, Yl, tMin, tMax, 0, maxTotal, padL, padT, plotW, plotH,
        'CUMULATIVE ΔV LOSS', 'm/s');

      let base = samples.map(() => 0);
      for (const [, field, col] of bands) {
        ctx.beginPath();
        samples.forEach((s, i) => {
          const y = Yl(base[i]);
          if (i === 0) ctx.moveTo(Xl(s.t), y); else ctx.lineTo(Xl(s.t), y);
        });
        for (let i = samples.length - 1; i >= 0; i--) {
          ctx.lineTo(Xl(samples[i].t), Yl(base[i] + (samples[i][field] ?? 0)));
        }
        ctx.closePath();
        ctx.fillStyle = col + '66';
        ctx.fill();
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        ctx.stroke();
        base = base.map((b, i) => b + (samples[i][field] ?? 0));
      }

      // Legend
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'left';
      let lx = padL + 6;
      for (const [name, field, col] of bands) {
        const final = samples[samples.length - 1][field] ?? 0;
        ctx.fillStyle = col;
        ctx.fillRect(lx, padT + 4, 7, 7);
        ctx.fillStyle = CSS.text;
        ctx.fillText(`${name} ${Math.round(final)}`, lx + 11, padT + 11);
        lx += ctx.measureText(`${name} ${Math.round(final)}`).width + 30;
      }

      drawEvents(Xl, padT, plotH);
      drawCursor(Xl, padT, plotH, totals, Yl, '#ffffff', 'm/s');
    }
  }

  function drawFrame(X, Y, tMin, tMax, vMin, vMax, padL, padT, plotW, plotH, label, unit) {
    ctx.font = '9px ui-monospace, monospace';

    // Horizontal gridlines + y labels.
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const v = vMin + ((vMax - vMin) * i) / 4;
      const y = Y(v);
      ctx.strokeStyle = CSS.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillStyle = CSS.text;
      ctx.fillText(formatTick(v), padL - 6, y + 3);
    }

    // Vertical gridlines + time labels.
    ctx.textAlign = 'center';
    const steps = 6;
    for (let i = 0; i <= steps; i++) {
      const t = tMin + ((tMax - tMin) * i) / steps;
      const x = X(t);
      ctx.strokeStyle = CSS.grid;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.fillStyle = CSS.text;
      ctx.fillText(t >= 3600 ? `${(t / 60).toFixed(0)}m` : `${t.toFixed(0)}s`, x, padT + plotH + 13);
    }

    ctx.textAlign = 'left';
    ctx.fillStyle = CSS.text;
    ctx.fillText(`${label}  [${unit}]`, padL, padT - 5);
  }

  function drawEvents(X, padT, plotH) {
    ctx.font = '8px ui-monospace, monospace';
    for (const ev of events) {
      const x = X(ev.t);
      ctx.strokeStyle = 'rgba(255,255,255,0.16)';
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.save();
      ctx.translate(x + 3, padT + plotH - 4);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = 'rgba(200,212,228,0.5)';
      ctx.textAlign = 'left';
      ctx.fillText(ev.name.toUpperCase(), 0, 0);
      ctx.restore();
    }
  }

  function drawCursor(X, padT, plotH, series, Y, color, unit) {
    if (!Number.isFinite(cursorT)) return;
    const x = X(cursorT);
    ctx.strokeStyle = CSS.cursor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();

    // Nearest sample value at the cursor.
    let idx = 0;
    let best = Infinity;
    for (let i = 0; i < samples.length; i++) {
      const d = Math.abs(samples[i].t - cursorT);
      if (d < best) { best = d; idx = i; }
    }
    const v = series[idx];
    if (Number.isFinite(v)) {
      ctx.fillStyle = CSS.cursor;
      ctx.beginPath();
      ctx.arc(x, Y(v), 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = x > canvas.getBoundingClientRect().width / 2 ? 'right' : 'left';
      ctx.fillText(`${formatTick(v)} ${unit}`, x + (ctx.textAlign === 'right' ? -6 : 6), Y(v) - 7);
    }
  }

  addEventListener('resize', resize);
  resize();

  return { setData, setSeries, setCursor, resize, draw };
}

function niceCeil(v) {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

function formatTick(v) {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(0) + 'k';
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  if (a === 0) return '0';
  return v.toFixed(3);
}
