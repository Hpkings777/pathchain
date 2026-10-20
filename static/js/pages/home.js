// PATHchain — Home / Explorer (blockchain.com style, mobile-first lists)
import { App, api } from '../api.js';
import { esc, empty, badge, nodeChip, confirmBar, skeletonRows, tweenNumber, flashNum } from '../ui.js';
import { fmtAmount, fmtNum, timeAgo, fmtDur, fmtRate, shortHash, COIN, fmtUsd, fmtPct, fmtCompact } from '../fmt.js';
import { lineChart } from '../charts.js';
import { ensureEngine, onTick, onCoins, pathSnapshot, coins as coinState } from '../market.js';

let offLive = null, offTick = null, offCoins = null;
let blockKey = '', txKey = '', chartHeight = -1;
let prevStats = null, prevPathPrice = null;

export async function render(container) {
  ensureEngine();
  container.innerHTML = `
    <div class="hero">
      <h1>The trusted source for data on the <span class="grad">${COIN} blockchain</span></h1>
      <p>Every block, transaction and hash attempt on this network is real. Nothing is mocked.</p>
      <form class="hero-search" id="hero-search">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input id="hero-search-input" placeholder="Search by block height, hash, tx ID, address or wallet name" autocomplete="off">
        <button class="btn btn-primary">Search</button>
      </form>
    </div>

    <div class="ticker" id="ticker" aria-label="Market prices"></div>

    <div class="grid cols-6" id="stat-row">${skeletonStats()}</div>

    <div class="grid cols-2" style="margin-top:16px">
      <div class="card">
        <h3>Latest Blocks <span class="right"><a href="#/blocks">See all blocks →</a></span></h3>
        <div id="latest-blocks">${skeletonRows(5)}</div>
      </div>
      <div class="card">
        <h3>Latest Transactions <span class="right muted" id="mempool-note"></span></h3>
        <div id="latest-txs">${skeletonRows(5)}</div>
      </div>
    </div>

    <div class="grid cols-2" style="margin-top:16px">
      <div class="card">
        <h3>${COIN} in circulation <span class="right muted">issued only via mining rewards</span></h3>
        <div id="supply-chart"></div>
      </div>
      <div class="card">
        <h3>Network pulse</h3>
        <div class="grid cols-2" id="pulse-grid">${skeletonStats(4)}</div>
      </div>
    </div>`;

  document.getElementById('hero-search').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = document.getElementById('hero-search-input').value.trim();
    if (q) window.dispatchEvent(new CustomEvent('path-search', { detail: q }));
  });

  const paint = (s) => { if (s) paintAll(s); };
  if (App.state) paintAll(App.state);
  offLive = App.on(paint);
  offTick = onTick(paintTicker);
  offCoins = onCoins(paintTicker);
  paintTicker();
}

function paintAll(s) {
  paintStats(s);
  paintBlocks(s);
  paintTxs(s);
  paintChartsThrottled(s);
}

function skeletonStats(n = 6) {
  return Array.from({ length: n }, () =>
    `<div class="card stat-card"><div class="skel" style="width:56%"></div><div class="skel" style="width:38%;height:20px;margin-top:10px"></div></div>`).join('');
}

// ------------------------------------------------------------- ticker -------
function paintTicker() {
  const box = document.getElementById('ticker');
  if (!box) return;
  const s = pathSnapshot();
  const pathChip = `
    <a class="ticker-chip path" href="#/market">
      <span class="coin-badge sm path">P</span>
      <span class="sym">PATH</span>
      <span class="px">${fmtUsd(s.price)}</span>
      <span class="pct ${s.chg24h >= 0 ? 'up' : 'down'}">${fmtPct(s.chg24h)}</span>
      <span class="st">sim</span>
    </a>`;
  const coinChips = coinState.rows.slice(0, 5).map(c => `
    <a class="ticker-chip" href="#/market" title="${esc(c.name)} — ${c.state === 'live' ? 'live from public API' : 'last fetched value'}">
      <span class="coin-badge sm">${esc(c.symbol.slice(0, 1))}</span>
      <span class="sym">${esc(c.symbol)}</span>
      <span class="px">${fmtUsd(c.price)}</span>
      <span class="pct ${c.chg24h >= 0 ? 'up' : 'down'}">${fmtPct(c.chg24h)}</span>
      ${c.state !== 'live' ? '<span class="st">cached</span>' : ''}
    </a>`).join('');
  const offline = coinState.state === 'offline'
    ? `<div class="ticker-chip" title="This device cannot reach the public price API"><span class="sym muted">BTC · ETH …</span><span class="px muted">offline</span></div>` : '';
  const loading = coinState.state === 'loading' && !coinChips
    ? `<div class="ticker-chip"><span class="skel" style="width:90px"></span></div>` : '';
  box.innerHTML = pathChip + coinChips + offline + loading;
  // pulse the PATH price when the simulation ticks it up or down
  if (prevPathPrice !== null && Math.abs(s.price - prevPathPrice) > 1e-9) {
    const px = box.querySelector('.ticker-chip.path .px');
    if (px) flashNum(px, s.price > prevPathPrice ? 1 : -1);
  }
  prevPathPrice = s.price;
}

// --------------------------------------------------------------- stats ------
// built once, updated in place — so values can count-up and flash when they move
function paintStats(s) {
  const st = s.stats;
  const row = document.getElementById('stat-row');
  if (!row) return;
  if (!row.querySelector('.stat-card[data-k]')) {
    row.innerHTML = ['height', 'txs', 'avg', 'rate', 'diff', 'peers'].map(k =>
      `<div class="card stat-card" data-k="${k}"><div class="label"></div><div class="value"></div><div class="sub"></div></div>`
    ).join('');
    prevStats = null;
  }
  const labels = { height: 'Blocks mined', txs: 'Transactions', avg: 'Avg block time',
                   rate: 'Network hashrate', diff: 'Difficulty', peers: 'Peers on LAN' };
  const subs = {
    height: `incl. genesis · epoch ${s.self.epoch}`,
    txs: `${st.mempool} waiting in mempool`,
    avg: `target ${fmtDur(s.self.target_block_time)}`,
    rate: 'estimated from recent blocks',
    diff: `${fmtNum(st.difficulty)} avg hashes per block · next: ${st.next_bits}`,
    peers: `${st.wallets_known} wallets known network-wide`,
  };
  const values = {
    height: { v: st.height, fmt: v => fmtNum(Math.round(v)) },
    txs: { v: st.total_txs, fmt: v => fmtNum(Math.round(v)) },
    avg: { v: st.avg_block_time ? fmtDur(st.avg_block_time) : '—' },
    rate: { v: st.network_hashrate_est, fmt: v => fmtRate(v) },
    diff: { v: `${st.bits} zeros` },
    peers: { v: st.peers, fmt: v => String(Math.round(v)) },
  };
  for (const k of Object.keys(labels)) {
    const card = row.querySelector(`.stat-card[data-k="${k}"]`);
    if (!card) continue;
    const lab = card.querySelector('.label'), vEl = card.querySelector('.value'), sEl = card.querySelector('.sub');
    if (lab.textContent !== labels[k]) lab.textContent = labels[k];
    const def = values[k];
    if (typeof def.v === 'number') {
      const old = prevStats ? prevStats[k] : null;
      if (old !== null && def.v !== old) {
        tweenNumber(vEl, def.v, def.fmt);
        flashNum(vEl, def.v > old ? 1 : -1);
      } else if (old === null) {
        vEl.textContent = def.fmt(def.v);
        vEl.dataset.raw = String(def.v);
      }
    } else if (vEl.textContent !== def.v) {
      vEl.textContent = def.v;
      delete vEl.dataset.raw;
    }
    if (sEl.textContent !== subs[k]) sEl.textContent = subs[k];
  }
  prevStats = { height: st.height, txs: st.total_txs, rate: st.network_hashrate_est, peers: st.peers };
}

// -------------------------------------------------------------- blocks ------
function blockRow(b) {
  const txCount = Math.max(0, b.txs - 1);
  return `
    <div class="lrow">
      <span class="l-side" style="width:auto">${confirmBar(b.confirmations)}</span>
      <div class="l-main">
        <div class="t1"><a href="#/block/${b.height}"><b>#${b.height}</b></a> ${nodeChip(b.miner)} <a href="#/address/${esc(b.miner_address || '')}">${esc(b.miner || '—')}</a></div>
        <div class="t2">${timeAgo(b.ts)} · ${txCount} transfer${txCount === 1 ? '' : 's'}</div>
      </div>
      <div class="l-side">
        <span class="amt pos">+${fmtAmount(b.reward || 10)} <span class="unit">${COIN}</span></span>
      </div>
    </div>`;
}

function paintBlocks(s) {
  const box = document.getElementById('latest-blocks');
  if (!box) return;
  const key = s.latest_blocks.map(b => `${b.height}:${b.txs}`).join(',');
  if (key === blockKey) return; // nothing changed — don't touch the DOM
  blockKey = key;
  box.innerHTML = s.latest_blocks.length
    ? s.latest_blocks.map(blockRow).join('')
    : empty('No blocks yet — open Mine and start hashing!');
}

// ----------------------------------------------------------------- txs ------
function txRowItem(tx, tipHeight) {
  const isCoin = tx.type === 'COINBASE';
  const from = isCoin ? 'NETWORK' : (tx.from_name || shortHash(tx.from_addr, 8, 6));
  const to = tx.to_name || shortHash(tx.to_addr, 8, 6);
  const conf = tx.height === null || tx.height === undefined ? null
    : (tipHeight !== undefined && tipHeight !== null ? tipHeight - tx.height + 1 : null);
  const status = conf === null ? badge('MEMPOOL', 'yellow') : badge(`${conf} conf`, 'green');
  return `
    <div class="lrow">
      <div class="l-main">
        <div class="t1"><a class="mono" href="#/tx/${esc(tx.txid)}">${esc(shortHash(tx.txid, 10, 8))}</a> ${status}</div>
        <div class="t2">${esc(from)} <span class="io-arrow" style="font-size:13px">→</span> ${esc(to)} · ${timeAgo(tx.timestamp)}</div>
      </div>
      <div class="l-side"><span class="amt ${isCoin ? 'pos' : ''}">${fmtAmount(tx.amount)} <span class="unit">${COIN}</span></span></div>
    </div>`;
}

function paintTxs(s) {
  const box = document.getElementById('latest-txs');
  if (!box) return;
  const rows = [...s.latest_txs, ...s.mempool_preview.map(t => ({ ...t, height: null }))].slice(0, 9);
  const key = rows.map(t => `${t.txid}:${t.height ?? 'm'}`).join(',');
  if (key === txKey) return;
  txKey = key;
  const note = document.getElementById('mempool-note');
  if (note) note.textContent = s.stats.mempool > 0 ? `${s.stats.mempool} in mempool` : 'mempool empty';
  box.innerHTML = rows.length ? rows.map(t => txRowItem(t, s.stats.height)).join('')
    : empty(`No transactions yet — create wallets and send ${COIN}`);
}

// --------------------------------------------------------------- charts -----
async function paintChartsThrottled(s) {
  if (s.stats.height === chartHeight) return; // only recompute on a new block
  chartHeight = s.stats.height;
  try {
    const { series } = await api.series();
    const box = document.getElementById('supply-chart');
    if (box && series.length) {
      lineChart(box, {
        height: 200,
        series: [{ name: `${COIN} supply`, color: '#7ca5cc', area: true, points: series.map(p => ({ x: p.height, y: p.supply })) }],
        yFmt: v => fmtNum(Math.round(v)),
        xFmt: v => `#${v}`,
      });
    }
    const pg = document.getElementById('pulse-grid');
    if (pg) {
      const recent = series.slice(-10);
      const fastest = recent.reduce((a, b) => (b.interval && (!a || b.interval < a.interval) ? b : a), null);
      const top = s.latest_blocks[0];
      pg.innerHTML = `
        <div class="card stat-card"><div class="label">Fastest recent block</div><div class="value">${fastest ? fmtDur(fastest.interval) : '—'}</div><div class="sub">${fastest ? `block #${fastest.height} by ${esc(fastest.miner)}` : ''}</div></div>
        <div class="card stat-card"><div class="label">Latest block</div><div class="value">#${s.stats.height}</div><div class="sub">${top ? `${timeAgo(top.ts)} · ${top.confirmations} conf` : ''}</div></div>
        <div class="card stat-card"><div class="label">This node</div><div class="value">${esc(s.self.name)}</div><div class="sub">${s.self.wallet_count} local wallet(s) · epoch ${s.self.epoch}</div></div>
        <div class="card stat-card"><div class="label">Network health</div><div class="value">${s.self.compromised ? '<span class="red">COMPROMISED</span>' : '<span class="green">HEALTHY</span>'}</div><div class="sub">${s.self.compromised ? 'consensus vote active' : 'all blocks validate'}</div></div>`;
    }
  } catch (e) { /* charts are best-effort */ }
}

export function destroy() {
  if (offLive) { offLive(); offLive = null; }
  if (offTick) { offTick(); offTick = null; }
  if (offCoins) { offCoins(); offCoins = null; }
  blockKey = txKey = ''; chartHeight = -1;
  prevStats = null; prevPathPrice = null;
}
