// PATHchain — canvas charts (no libraries, fully offline).
// DPR-aware so lines are crisp on phones; pointer/touch tooltip on the big chart.

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

const css = () => getComputedStyle(document.documentElement);
function tok(name, fallback) {
  const v = css().getPropertyValue(name).trim();
  return v || fallback;
}

// ------------------------------------------------------------ sparkline ----
export function spark(canvas, points, { color = '#7ca5cc', fill = true, height = 38 } = {}) {
  if (!canvas || !points || points.length < 2) return;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth || 120;
  const ctx = setupCanvas(canvas, w, height);
  const pad = 2;
  let lo = Infinity, hi = -Infinity;
  for (const p of points) { if (p < lo) lo = p; if (p > hi) hi = p; }
  if (hi === lo) { hi += Math.abs(hi) * 0.01 + 0.01; lo -= Math.abs(lo) * 0.01 + 0.01; }
  const X = i => pad + (i / (points.length - 1)) * (w - pad * 2);
  const Y = v => pad + (1 - (v - lo) / (hi - lo)) * (height - pad * 2);
  ctx.clearRect(0, 0, w, height);
  ctx.beginPath();
  points.forEach((p, i) => i ? ctx.lineTo(X(i), Y(p)) : ctx.moveTo(X(i), Y(p)));
  if (fill) {
    ctx.save();
    ctx.lineTo(X(points.length - 1), height); ctx.lineTo(X(0), height); ctx.closePath();
    ctx.globalAlpha = 0.14; ctx.fillStyle = color; ctx.fill();
    ctx.restore();
    ctx.beginPath();
    points.forEach((p, i) => i ? ctx.lineTo(X(i), Y(p)) : ctx.moveTo(X(i), Y(p)));
  }
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();
  // last dot
  ctx.beginPath();
  ctx.arc(X(points.length - 1), Y(points[points.length - 1]), 2, 0, Math.PI * 2);
  ctx.fillStyle = color; ctx.fill();
}

// ----------------------------------------------------------- price chart ----
// points: [{t (unix sec), v (usd)}], live: {t, v} appended as the last point.
export function priceChart(canvas, points, {
  height = 260, accent = '#7ca5cc', yFmt = v => '$' + v.toFixed(2),
  onHover = null, live = null, liveColor = '#4cbb8f',
} = {}) {
  if (!canvas) return;
  const host = canvas.parentElement;
  const w = Math.max(120, (host ? host.clientWidth : canvas.clientWidth) || 320);
  const ctx = setupCanvas(canvas, w, height);
  const padL = 8, padR = 8, padT = 12, padB = 22;
  const plotW = w - padL - padR, plotH = height - padT - padB;
  ctx.clearRect(0, 0, w, height);
  if (!points.length) {
    ctx.fillStyle = tok('--faint', '#6c7078');
    ctx.font = '13px ' + tok('--sans', 'sans-serif');
    ctx.textAlign = 'center';
    ctx.fillText('Price history starts at the simulated listing date', w / 2, height / 2);
    return;
  }
  const all = live ? points.concat([live]) : points;
  let lo = Infinity, hi = -Infinity;
  for (const p of all) { if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v; }
  const padV = (hi - lo) * 0.10 || Math.abs(hi) * 0.02 || 0.01;
  lo -= padV; hi += padV;
  const t0 = all[0].t, t1 = all[all.length - 1].t || t0 + 1;
  const X = t => padL + ((t - t0) / Math.max(1e-9, t1 - t0)) * plotW;
  const Y = v => padT + (1 - (v - lo) / (hi - lo)) * plotH;

  // horizontal grid + y labels (right-aligned inside plot for a native feel)
  ctx.font = '10.5px ' + tok('--sans', 'sans-serif');
  ctx.textAlign = 'left';
  for (let i = 0; i <= 3; i++) {
    const v = lo + (hi - lo) * i / 3;
    const y = Y(v);
    ctx.strokeStyle = tok('--border', 'rgba(255,255,255,0.07)');
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillStyle = tok('--faint', '#6c7078');
    ctx.fillText(yFmt(v), padL + 2, y - 4);
  }

  // x time labels
  ctx.textAlign = 'left';
  ctx.fillStyle = tok('--faint', '#6c7078');
  ctx.fillText(timeLabel(t0), padL, height - 6);
  ctx.textAlign = 'right';
  ctx.fillText(timeLabel(t1), w - padR, height - 6);

  // area + line
  const draw = (pts, color, areaAlpha) => {
    ctx.beginPath();
    pts.forEach((p, i) => i ? ctx.lineTo(X(p.t), Y(p.v)) : ctx.moveTo(X(p.t), Y(p.v)));
    if (areaAlpha) {
      ctx.save();
      ctx.lineTo(X(pts[pts.length - 1].t), height - padB);
      ctx.lineTo(X(pts[0].t), height - padB);
      ctx.closePath();
      ctx.globalAlpha = areaAlpha; ctx.fillStyle = color; ctx.fill();
      ctx.restore();
      ctx.beginPath();
      pts.forEach((p, i) => i ? ctx.lineTo(X(p.t), Y(p.v)) : ctx.moveTo(X(p.t), Y(p.v)));
    }
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.stroke();
  };
  draw(points, accent, 0.10);
  if (live && points.length) {
    // connect the tail to the live point, draw live dot
    const tail = points[points.length - 1];
    ctx.beginPath();
    ctx.moveTo(X(tail.t), Y(tail.v)); ctx.lineTo(X(live.t), Y(live.v));
    ctx.strokeStyle = liveColor; ctx.lineWidth = 2; ctx.stroke();
    ctx.beginPath();
    ctx.arc(X(live.t), Y(live.v), 3.2, 0, Math.PI * 2);
    ctx.fillStyle = liveColor; ctx.fill();
    ctx.beginPath();
    ctx.arc(X(live.t), Y(live.v), 6.5, 0, Math.PI * 2);
    ctx.strokeStyle = liveColor; ctx.globalAlpha = 0.35; ctx.stroke(); ctx.globalAlpha = 1;
  }

  // ---- pointer crosshair + tooltip ----
  const fmtTip = (p) => `${yFmt(p.v)}  ·  ${tipTime(p.t)}`;
  const showAt = (clientX) => {
    const rect = canvas.getBoundingClientRect();
    const mx = clampN(clientX - rect.left, padL, w - padR);
    const t = t0 + ((mx - padL) / plotW) * (t1 - t0);
    // nearest point
    let best = all[0], bd = Infinity;
    for (const p of all) { const d = Math.abs(X(p.t) - mx); if (d < bd) { bd = d; best = p; } }
    redrawWithCross(best);
    if (onHover) onHover(best, { x: X(best.t), y: Y(best.v) });
  };
  const redrawWithCross = (p) => {
    // redraw base then crosshair (cheap enough at pointer rate for our sizes)
    priceChart(canvas, points, { height, accent, yFmt, onHover: null, live, liveColor });
    ctx.strokeStyle = tok('--border-strong', 'rgba(255,255,255,0.2)');
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(X(p.t), padT); ctx.lineTo(X(p.t), height - padB); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(X(p.t), Y(p.v), 3, 0, Math.PI * 2);
    ctx.fillStyle = accent; ctx.fill();
    // tooltip bubble
    const label = fmtTip(p);
    ctx.font = '11.5px ' + tok('--sans', 'sans-serif');
    const tw = ctx.measureText(label).width + 16;
    let bx = clampN(X(p.t) - tw / 2, 2, w - tw - 2);
    const by = Math.max(2, Y(p.v) - 30);
    ctx.fillStyle = tok('--panel-2', '#16181d');
    ctx.strokeStyle = tok('--border-strong', 'rgba(255,255,255,0.13)');
    roundRect(ctx, bx, by, tw, 22, 6); ctx.fill(); ctx.stroke();
    ctx.fillStyle = tok('--fg', '#edeef0');
    ctx.textAlign = 'left';
    ctx.fillText(label, bx + 8, by + 15);
  };
  const clear = () => {
    priceChart(canvas, points, { height, accent, yFmt, onHover, live, liveColor });
    if (onHover) onHover(null, null);
  };
  if (onHover) {
    canvas.onpointermove = (e) => showAt(e.clientX);
    canvas.onpointerleave = clear;
    canvas.onpointercancel = clear;
  } else {
    canvas.onpointermove = null; canvas.onpointerleave = null;
  }
}

function clampN(v, a, b) { return Math.min(b, Math.max(a, v)); }
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function timeLabel(t) {
  const d = new Date(t * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
function tipTime(t) {
  const d = new Date(t * 1000);
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
