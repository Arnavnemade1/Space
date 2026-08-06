/** Small DOM helpers. No framework; the UI is a few hundred nodes. */

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/** Collapsible section. */
export function group(title, children, { collapsed = false, collapsible = false } = {}) {
  const body = el('div', { class: 'group-body' }, children);
  const head = el('div', {
    class: `group-title${collapsible ? ' collapsible' : ''}`,
  }, [el('span', { text: title })]);

  const wrap = el('div', { class: `group${collapsed ? ' collapsed' : ''}` }, [head, body]);
  if (collapsible) head.addEventListener('click', () => wrap.classList.toggle('collapsed'));
  return wrap;
}

/** Labelled <select>. */
export function select(label, options, value, onChange) {
  const sel = el('select', {
    onchange: (e) => onChange(e.target.value),
  }, options.map(([v, t]) => el('option', { value: v, selected: v === value ? '' : null }, [t])));

  return el('div', { class: 'field' }, [
    el('div', { class: 'field-label' }, [el('span', { text: label })]),
    sel,
  ]);
}

/**
 * Labelled slider with a live numeric readout.
 * `format` renders the display value; `parse`/`toSlider` allow logarithmic
 * scales, which most of these quantities need (power spans 1 kW to 1 GW).
 */
export function slider(label, {
  min, max, step = 1, value, format = (v) => v.toFixed(0), unit = '',
  log = false, onInput,
}) {
  const toSlider = log
    ? (v) => (Math.log10(v) - Math.log10(min)) / (Math.log10(max) - Math.log10(min)) * 1000
    : (v) => ((v - min) / (max - min)) * 1000;
  const fromSlider = log
    ? (s) => Math.pow(10, Math.log10(min) + (s / 1000) * (Math.log10(max) - Math.log10(min)))
    : (s) => min + (s / 1000) * (max - min);

  const readout = el('span', { class: 'field-value', text: format(value) + unit });
  const input = el('input', {
    type: 'range', min: 0, max: 1000, step: 1, value: toSlider(value),
    oninput: (e) => {
      let v = fromSlider(Number(e.target.value));
      if (!log && step) v = Math.round(v / step) * step;
      readout.textContent = format(v) + unit;
      onInput(v);
    },
  });

  return el('div', { class: 'field' }, [
    el('div', { class: 'field-label' }, [el('span', { text: label }), readout]),
    input,
  ]);
}

/** Checkbox row. */
export function checkbox(label, value, onChange) {
  return el('div', { class: 'field' }, [
    el('label', { class: 'check' }, [
      el('input', {
        type: 'checkbox', checked: value ? '' : null,
        onchange: (e) => onChange(e.target.checked),
      }),
      el('span', { text: label }),
    ]),
  ]);
}

/** Key/value readout row. `tone` is '', 'good', 'warn' or 'bad'. */
export function stat(key, value, tone = '') {
  return el('div', { class: 'stat-row' }, [
    el('span', { class: 'k', text: key }),
    el('span', { class: `v ${tone}`, text: value }),
  ]);
}

/** Stacked proportion bar with legend. */
export function stackedBar(entries, palette) {
  const total = entries.reduce((a, [, v]) => a + (Number.isFinite(v) ? v : 0), 0);
  if (total <= 0) return el('div');

  const bar = el('div', { class: 'bar' }, entries.map(([, v], i) => el('div', {
    class: 'bar-seg',
    style: `width:${((Number.isFinite(v) ? v : 0) / total) * 100}%;background:${palette[i % palette.length]}`,
  })));

  const legend = el('div', { class: 'legend' }, entries.map(([k, v], i) => el('div', { class: 'legend-item' }, [
    el('span', { class: 'legend-dot', style: `background:${palette[i % palette.length]}` }),
    el('span', { text: `${k} ${((Number.isFinite(v) ? v : 0) / total * 100).toFixed(0)}%` }),
  ])));

  return el('div', {}, [bar, legend]);
}

export function issueList(issues) {
  if (!issues?.length) {
    return el('div', { class: 'verdict ok', text: 'NO BLOCKING ISSUES' });
  }
  return el('div', {}, issues.map((i) => el('div', { class: `issue ${i.severity}` }, [
    el('span', { class: 'subsystem', text: `${i.severity.toUpperCase()} · ${i.subsystem.toUpperCase()}` }),
    el('span', { text: i.message }),
  ])));
}

export function note(text) {
  return el('div', { class: 'note', text });
}

export function empty(text) {
  return el('div', { class: 'empty', text });
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function fmtSI(n, digits = 1, unit = '') {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e12) return (n / 1e12).toFixed(digits) + ' T' + unit;
  if (abs >= 1e9) return (n / 1e9).toFixed(digits) + ' G' + unit;
  if (abs >= 1e6) return (n / 1e6).toFixed(digits) + ' M' + unit;
  if (abs >= 1e3) return (n / 1e3).toFixed(digits) + ' k' + unit;
  if (abs >= 1) return n.toFixed(digits) + ' ' + unit;
  if (abs === 0) return '0 ' + unit;
  if (abs >= 1e-3) return (n * 1e3).toFixed(digits) + ' m' + unit;
  if (abs >= 1e-6) return (n * 1e6).toFixed(digits) + ' µ' + unit;
  return n.toExponential(digits) + ' ' + unit;
}

export function fmtMass(kg) {
  if (!Number.isFinite(kg)) return '—';
  if (kg >= 1e6) return (kg / 1e6).toFixed(2) + ' kt';
  if (kg >= 1000) return (kg / 1000).toFixed(1) + ' t';
  return kg.toFixed(0) + ' kg';
}

export function fmtMoney(usd) {
  if (!Number.isFinite(usd)) return '—';
  if (Math.abs(usd) >= 1e9) return '$' + (usd / 1e9).toFixed(2) + 'B';
  if (Math.abs(usd) >= 1e6) return '$' + (usd / 1e6).toFixed(1) + 'M';
  if (Math.abs(usd) >= 1e3) return '$' + (usd / 1e3).toFixed(0) + 'k';
  return '$' + usd.toFixed(0);
}

export function fmtArea(m2) {
  if (!Number.isFinite(m2)) return '—';
  if (m2 >= 1e6) return (m2 / 1e6).toFixed(2) + ' km²';
  return Math.round(m2).toLocaleString() + ' m²';
}

export function fmtTime(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 90) return seconds.toFixed(1) + ' s';
  if (seconds < 7200) return (seconds / 60).toFixed(1) + ' min';
  if (seconds < 86400 * 2) return (seconds / 3600).toFixed(2) + ' h';
  return (seconds / 86400).toFixed(1) + ' d';
}

export function fmtYears(y) {
  if (!Number.isFinite(y)) return '—';
  if (y === Infinity) return '∞';
  if (y > 400) return '>400 yr';
  if (y < 1) return (y * 12).toFixed(1) + ' mo';
  return y.toFixed(1) + ' yr';
}

/** A human-scale comparison for very large areas. */
export function areaComparison(m2) {
  if (!Number.isFinite(m2) || m2 <= 0) return '';
  const pitches = m2 / 7140;               // association football pitch
  const centralPark = m2 / 3.41e6;         // Central Park, New York
  const manhattan = m2 / 5.87e7;           // Manhattan island
  if (manhattan >= 0.25) return `${manhattan.toFixed(2)}× Manhattan`;
  if (centralPark >= 0.25) return `${centralPark.toFixed(2)}× Central Park`;
  if (pitches >= 1) return `${pitches.toFixed(1)} football pitches`;
  return `${Math.round(m2)} m²`;
}

/** Side length of a square of this area, which is the number people picture. */
export function squareSide(m2) {
  if (!Number.isFinite(m2) || m2 <= 0) return '—';
  const s = Math.sqrt(m2);
  return s >= 1000 ? `${(s / 1000).toFixed(2)} km square` : `${Math.round(s)} m square`;
}
