// PATHchain — candlestick + volume canvas renderer (no libraries, offline).
// Draws everything from CSS design tokens so it follows the active theme.
// Only transform/opacity animations elsewhere — this canvas is DPR-aware and
// repaints are explicit (no persistent rAF cost when idle).

function setupCanvas(canvas, cssW, cssH) {
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function tok(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// rows: [[t, o, h, l, c, v], …]  (t = unix seconds bucket start)
export function candles(canvas, rows, {
  height = 300,
  yFmt = v => '$' + v.toFixed(4),
  xFmt = t => new Date(t * 1000).toLocaleTimeString('en-GB', { hour12: false }),
} = {}) {
  if (!canvas) return;
  const host = canvas.parentElement;
  const w = Math.max(160, (host ? host.clientWidth : canvas.clientWidth) || 320);
  const ctx = setupCanvas(canvas, w, height);
  ctx.clearRect(0, 0, w, height);
  if (!rows || rows.length < 1) {
    ctx.fillStyle = tok('--faint', '#6c7078');
    ctx.font = '12px ' + tok('--sans', 'sans-serif');
    ctx.textAlign = 'center';
    ctx.fillText('waiting for the first trades…', w / 2, height / 2);
    return;
  }
  const green = tok('--green', '#4cbb8f'), red = tok('--red', '#d96a6a');
  const grid = tok('--border', 'rgba(255,255,255,0.07)');
  const muted = tok('--muted', '#9a9da5');
  const padL = 6, padR = 58, padT = 10, volH = Math.round(height * 0.2), gap = 8;
  const priceH = height - padT - volH - gap - 20;
  const plotW = w - padL - padR;

  let hi = -Infinity, lo = Infinity, vMax = 0;
  for (const r of rows) {
    hi = Math.max(hi, r[2]); lo = Math.min(lo, r[3]);
    vMax = Math.max(vMax, r[5] || 0);
  }
  const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.002 || 0.01;
  hi += pad; lo -= pad;
  const Y = v => padT + (1 - (v - lo) / (hi - lo)) * priceH;
  const cw = plotW / rows.length;
  const bodyW = Math.max(1.5, Math.min(11, cw * 0.62));
  const X = i => padL + i * cw + cw / 2;
  const vy0 = padT + priceH + gap;
  const VY = v => vMax > 0 ? vy0 + volH - (v / vMax) * volH : vy0 + volH;

  // horizontal grid + right-axis price labels
  ctx.strokeStyle = grid; ctx.fillStyle = muted;
  ctx.font = '10px ' + tok('--mono', 'monospace');
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const v = lo + (hi - lo) * (g / 4);
    const y = Math.round(Y(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
    ctx.fillText(yFmt(v), padL + plotW + 8, y);
  }

  // volume bars
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r[5]) continue;
    const up = r[4] >= r[1];
    ctx.fillStyle = up ? green : red;
    ctx.globalAlpha = 0.35;
    const y = VY(r[5]);
    ctx.fillRect(X(i) - bodyW / 2, y, bodyW, vy0 + volH - y);
    ctx.globalAlpha = 1;
  }

  // candles
  for (let i = 0; i < rows.length; i++) {
    const [t, o, h, l, c] = rows[i];
    const up = c >= o;
    ctx.strokeStyle = up ? green : red;
    ctx.fillStyle = up ? green : red;
    const x = Math.round(X(i)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, Y(h)); ctx.lineTo(x, Y(l)); ctx.lineWidth = 1; ctx.stroke();
    const yO = Y(o), yC = Y(c);
    const top = Math.min(yO, yC), hgt = Math.max(1, Math.abs(yC - yO));
    ctx.fillRect(x - bodyW / 2, top, bodyW, hgt);
  }

  // last price marker
  const last = rows[rows.length - 1];
  const ly = Math.round(Y(last[4])) + 0.5;
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = last[4] >= last[1] ? green : red;
  ctx.beginPath(); ctx.moveTo(padL, ly); ctx.lineTo(padL + plotW, ly); ctx.stroke();
  ctx.restore();
  const lbl = yFmt(last[4]);
  ctx.font = 'bold 10.5px ' + tok('--mono', 'monospace');
  const lw = ctx.measureText(lbl).width + 10;
  ctx.fillStyle = last[4] >= last[1] ? green : red;
  const bx = padL + plotW + 3, by = ly - 8;
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath(); ctx.roundRect(bx, by, lw, 16, 4); ctx.fill();
  } else {
    ctx.fillRect(bx, by, lw, 16);
  }
  ctx.fillStyle = tok('--bg-deep', '#07080a');
  ctx.textAlign = 'left';
  ctx.fillText(lbl, bx + 5, ly);

  // time axis
  ctx.fillStyle = muted;
  ctx.font = '10px ' + tok('--mono', 'monospace');
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const ticks = Math.min(5, rows.length);
  for (let k = 0; k < ticks; k++) {
    const i = Math.min(rows.length - 1, Math.floor(k * (rows.length - 1) / Math.max(1, ticks - 1)));
    ctx.fillText(xFmt(rows[i][0]), Math.min(w - 40, Math.max(30, X(i))), padT + priceH + gap + volH + 4);
  }
}

// cumulative depth step-chart (bid/ask areas facing each other)
export function depthChart(canvas, depth, { height = 120 } = {}) {
  if (!canvas || !depth) return;
  const host = canvas.parentElement;
  const w = Math.max(160, (host ? host.clientWidth : canvas.clientWidth) || 300);
  const ctx = setupCanvas(canvas, w, height);
  ctx.clearRect(0, 0, w, height);
  const green = tok('--green', '#4cbb8f'), red = tok('--red', '#d96a6a');
  const bids = depth.bids || [], asks = depth.asks || [];
  if (!bids.length && !asks.length) return;
  let cum = 0;
  const bPts = bids.map(([p, s]) => { cum += s; return [p, cum]; });
  cum = 0;
  const aPts = asks.map(([p, s]) => { cum += s; return [p, cum]; });
  const maxCum = Math.max(bPts.length ? bPts[bPts.length - 1][1] : 0, aPts.length ? aPts[aPts.length - 1][1] : 0) || 1;
  const mid = bids.length ? bids[0][0] : (aPts.length ? aPts[0][0] : 0);
  let lo = mid, hi = mid;
  for (const [p] of bPts) lo = Math.min(lo, p);
  for (const [p] of aPts) hi = Math.max(hi, p);
  const spread = (hi - lo) || mid * 0.02 || 1;
  lo -= spread * 0.05; hi += spread * 0.05;
  const X = p => ((p - lo) / (hi - lo)) * w;
  const Y = v => (1 - v / maxCum) * (height - 8) + 4;

  const drawArea = (pts, color) => {
    if (pts.length < 1) return;
    ctx.beginPath();
    const first = pts[0];
    const xEdge = first[0] < mid ? 0 : w;
    ctx.moveTo(X(first[0]), Y(first[1]));
    for (const [p, v] of pts) ctx.lineTo(X(p), Y(v));
    ctx.lineTo(xEdge, height); ctx.lineTo(X(first[0]), height); ctx.closePath();
    ctx.fillStyle = color; ctx.globalAlpha = 0.16; ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(X(first[0]), Y(first[1]));
    for (const [p, v] of pts) ctx.lineTo(X(p), Y(v));
    ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.stroke();
  };
  drawArea(bPts, green);
  drawArea(aPts, red);
}
