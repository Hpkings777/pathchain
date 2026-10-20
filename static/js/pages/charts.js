// PATHchain — charts & statistics (all computed from the live chain)
import { App, api } from '../api.js';
import { empty, esc, badge, nodeChip } from '../ui.js';
import { fmtNum, fmtDur, fmtRate, COIN } from '../fmt.js';
import { lineChart, barChart } from '../charts.js';

let offLive = null;
let lastHeight = -1;

export async function render(container) {
  container.innerHTML = `
    <div class="section-head"><h2>Charts & Statistics</h2>
      <span class="right muted">every point is computed from real blocks on your chain</span></div>
    <div class="grid cols-2">
      <div class="card"><h3>Transactions per block</h3><div id="c-tx">${empty('…')}</div></div>
      <div class="card"><h3>Block interval (seconds)</h3><div id="c-int">${empty('…')}</div></div>
      <div class="card"><h3>Difficulty (leading zeros)</h3><div id="c-bits">${empty('…')}</div></div>
      <div class="card"><h3>${COIN} supply growth</h3><div id="c-supply">${empty('…')}</div></div>
      <div class="card"><h3>Estimated hashrate per block</h3><div id="c-hr">${empty('…')}</div></div>
      <div class="card"><h3>Miner leaderboard</h3><div id="c-miners">${empty('…')}</div></div>
    </div>`;

  lastHeight = -1;
  await load();
  // recompute only when a new block actually arrives — not on every 1.5s poll
  offLive = App.on((s) => { if (s && s.stats.height !== lastHeight) load(); });
}

async function load() {
  let data;
  try { data = await api.series(); } catch (e) { return; }
  const s = data.series;
  if (!s.length) return;
  lastHeight = s[s.length - 1].height;
  const recent = s.slice(-60);

  lineChart(document.getElementById('c-tx'), {
    series: [{ name: 'transfers per block', color: '#7ca5cc', area: true, points: recent.map(p => ({ x: p.height, y: p.txs })) }],
    yFmt: v => Math.round(v), xFmt: v => `#${v}`, height: 200,
  });
  lineChart(document.getElementById('c-int'), {
    series: [{ name: 'seconds to mine', color: '#4cbb8f', points: recent.filter(p => p.interval !== null).map(p => ({ x: p.height, y: p.interval })) }],
    yFmt: v => `${Math.round(v)}s`, xFmt: v => `#${v}`, height: 200,
  });
  barChart(document.getElementById('c-bits'), {
    data: recent.map(p => ({ x: p.height, y: p.bits })), height: 200, color: '#d2a83c',
    yFmt: v => `${Math.round(v)}`, xFmt: v => `#${v}`,
  });
  lineChart(document.getElementById('c-supply'), {
    series: [{ name: `total ${COIN}`, color: '#7ca5cc', area: true, points: s.map(p => ({ x: p.height, y: p.supply })) }],
    yFmt: v => fmtNum(Math.round(v)), xFmt: v => `#${v}`, height: 200,
  });
  lineChart(document.getElementById('c-hr'), {
    series: [{ name: 'hashes/sec (est.)', color: '#9a9da5', points: recent.filter(p => p.hashrate).map(p => ({ x: p.height, y: p.hashrate })) }],
    yFmt: v => fmtRate(v), xFmt: v => `#${v}`, height: 200,
  });

  // miner leaderboard
  const counts = {};
  for (const p of s) {
    if (!p.miner || p.miner === 'SYSTEM') continue;
    counts[p.miner] = (counts[p.miner] || 0) + 1;
  }
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const max = rows.length ? rows[0][1] : 1;
  document.getElementById('c-miners').innerHTML = rows.length ? `
    <div style="display:flex;flex-direction:column;gap:9px">
      ${rows.map(([name, n], i) => `
        <div style="display:flex;align-items:center;gap:10px">
          <span class="faint" style="min-width:18px">${i + 1}.</span>
          ${nodeChip(name)}
          <span style="min-width:110px">${esc(name)}</span>
          <div class="lb-bar"><i style="width:${(n / max) * 100}%"></i></div>
          <b style="min-width:90px;text-align:right;font-weight:600">${n} block${n === 1 ? '' : 's'}</b>
        </div>`).join('')}
    </div>` : empty('No mined blocks yet.');
}

export function destroy() { if (offLive) { offLive(); offLive = null; } }
