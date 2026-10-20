// PATHchain — hand-rolled SVG charts (no libraries, fully offline)

const NS = 'http://www.w3.org/2000/svg';

// chart palette — matches the CSS design tokens
const C = {
  text: '#6c7078',
  grid: 'rgba(255,255,255,0.06)',
  accent: '#7ca5cc',
  green: '#4cbb8f',
  amber: '#d2a83c',
  neutral: '#9a9da5',
};

function svgEl(tag, attrs = {}) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

/**
 * Line/area chart. series: [{name, color, points: [{x, y}], area?: bool}]
 * All points rendered with plain SVG so it works anywhere, offline.
 */
export function lineChart(container, { series, height = 220, yFmt = v => v, xFmt = v => v, title = '' }) {
  container.innerHTML = '';
  const W = 760, H = height, padL = 56, padR = 14, padT = 14, padB = 26;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet' });

  const all = series.flatMap(s => s.points);
  if (!all.length) {
    const box0 = document.createElement('div');
    box0.className = 'chart-box';
    const t = svgEl('text', { x: W / 2, y: H / 2, fill: C.text, 'text-anchor': 'middle', 'font-size': 13 });
    t.textContent = 'No data yet — mine some blocks!';
    box0.appendChild(svg);
    svg.appendChild(t);
    container.appendChild(box0);
    return;
  }
  const xs = all.map(p => p.x), ys = all.map(p => p.y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  let yMin = Math.min(...ys), yMax = Math.max(...ys);
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const yPad = (yMax - yMin) * 0.12;
  yMin = Math.max(0, yMin - yPad); yMax += yPad;

  const X = x => padL + (x - xMin) / Math.max(1e-9, xMax - xMin) * (W - padL - padR);
  const Y = y => padT + (1 - (y - yMin) / Math.max(1e-9, yMax - yMin)) * (H - padT - padB);

  // grid + y labels (4 lines)
  for (let i = 0; i <= 4; i++) {
    const yv = yMin + (yMax - yMin) * i / 4;
    const y = Y(yv);
    svg.appendChild(svgEl('line', { x1: padL, x2: W - padR, y1: y, y2: y, stroke: C.grid }));
    const t = svgEl('text', { x: padL - 8, y: y + 4, fill: C.text, 'font-size': 10.5, 'text-anchor': 'end' });
    t.textContent = yFmt(yv);
    svg.appendChild(t);
  }
  // x labels (first / last / mid)
  [xMin, (xMin + xMax) / 2, xMax].forEach((xv, i) => {
    const t = svgEl('text', {
      x: X(xv), y: H - 8, fill: C.text, 'font-size': 10.5,
      'text-anchor': i === 0 ? 'start' : (i === 2 ? 'end' : 'middle')
    });
    t.textContent = xFmt(xv);
    svg.appendChild(t);
  });

  for (const s of series) {
    if (!s.points.length) continue;
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
    if (s.area) {
      const area = svgEl('path', { d: `${d} L${X(s.points.at(-1).x)},${Y(yMin)} L${X(s.points[0].x)},${Y(yMin)} Z`, fill: s.color, opacity: 0.12 });
      svg.appendChild(area);
    }
    svg.appendChild(svgEl('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2.2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  }

  const box = document.createElement('div');
  box.className = 'chart-box';
  box.appendChild(svg);
  if (title) {
    const lg = document.createElement('div');
    lg.className = 'chart-legend';
    lg.innerHTML = series.map(s => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join('');
    box.appendChild(lg);
  }
  container.appendChild(box);
}

/** Vertical bar chart: data [{x, y, label?, color?}] */
export function barChart(container, { data, height = 220, color = C.accent, yFmt = v => v, xFmt = v => v }) {
  container.innerHTML = '';
  const W = 760, H = height, padL = 56, padR = 14, padT = 14, padB = 26;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet' });
  if (!data.length) {
    const t = svgEl('text', { x: W / 2, y: H / 2, fill: C.text, 'text-anchor': 'middle', 'font-size': 13 });
    t.textContent = 'No data yet — mine some blocks!';
    svg.appendChild(t);
    container.appendChild(svg);
    return;
  }
  const yMax = Math.max(...data.map(d => d.y)) || 1;
  const bw = (W - padL - padR) / data.length;
  for (let i = 0; i <= 4; i++) {
    const yv = yMax * i / 4, y = padT + (1 - i / 4) * (H - padT - padB);
    svg.appendChild(svgEl('line', { x1: padL, x2: W - padR, y1: y, y2: y, stroke: C.grid }));
    const t = svgEl('text', { x: padL - 8, y: y + 4, fill: C.text, 'font-size': 10.5, 'text-anchor': 'end' });
    t.textContent = yFmt(yv);
    svg.appendChild(t);
  }
  data.forEach((d, i) => {
    const h = (d.y / yMax) * (H - padT - padB);
    const x = padL + i * bw + bw * 0.18;
    const rect = svgEl('rect', {
      x, y: padT + (H - padT - padB) - h, width: bw * 0.64, height: Math.max(1, h),
      rx: 3, fill: d.color || color, opacity: 0.92
    });
    rect.appendChild(svgEl('title')).lastChild;
    rect.querySelector('title') && (rect.querySelector('title').textContent = `${xFmt(d.x)}: ${d.y}`);
    svg.appendChild(rect);
    if (data.length <= 24 && (i % Math.ceil(data.length / 12) === 0 || i === data.length - 1)) {
      const t = svgEl('text', { x: x + bw * 0.32, y: H - 8, fill: C.text, 'font-size': 10.5, 'text-anchor': 'middle' });
      t.textContent = xFmt(d.x);
      svg.appendChild(t);
    }
  });
  container.appendChild(svg);
}
