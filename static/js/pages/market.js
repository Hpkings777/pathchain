// PATHchain — Markets: the live bot-engine order book + candlesticks, plus
// real-coin rows from the public API when the internet is reachable.
// PATH pricing is a transparent simulation (bots on two venues); when the bot
// engine is paused the legacy deterministic walk takes over, clearly labelled.
import { App, api } from '../api.js';
import { live, ensureMarketLive, onSnap, onPrice, pickCandles, streamHealthy } from '../market2.js';
import { candles as drawCandles, depthChart } from '../candles.js';
import { renderBook, renderTrades } from '../orderbook.js';
import { fmtUsd, fmtPct, fmtCompact, fmtNum } from '../fmt.js';
import { esc, empty, badge, tweenNumber, flashNum } from '../ui.js';
import { ensureEngine, onCoins, pathSnapshot, coins as coinState, updateChainStats } from '../market.js';

const BUCKETS = [
  { id: '2', label: '2s' },
  { id: '10', label: '10s' },
  { id: '60', label: '1m' },
  { id: '300', label: '5m' },
];

let bucket = '10';
let offSnap = null, offPrice = null, offCoins = null, offLive2 = null;
let lastChartPaint = 0;
let prevTopTrade = 0;
let prevPrice = null;
const bookPrev = {};

export async function render(container) {
  ensureMarketLive();
  ensureEngine();
  updateChainStats(App.state ? App.state.stats : null);

  container.innerHTML = `
    <div class="section-head"><h2>Markets</h2>
      <span class="right muted" id="mkt-mode">connecting to the bot engine…</span></div>

    <div class="mkt-live-grid">
      <div>
        <div class="card">
          <div class="mkt-hero-top">
            <div class="mkt-coin-id">
              <span class="coin-badge path">P</span>
              <div>
                <div class="mkt-name">PATH <span class="muted">/ USD</span></div>
                <div class="mkt-sub">PATHchain DEX · <span class="tag-sys">SIMULATED — bot engine</span></div>
              </div>
            </div>
            <div class="mkt-price-box">
              <div class="mkt-price" id="mkt-price">—</div>
              <div class="mkt-chg-row">
                <span class="chg-chip" id="mkt-chg">—</span>
                <span class="muted small-text" id="mkt-regime"></span>
              </div>
            </div>
          </div>
          <div class="tf-tabs" id="bucket-tabs" role="tablist">
            ${BUCKETS.map(b => `<button role="tab" data-b="${b.id}" class="${b.id === bucket ? 'active' : ''}">${b.label}</button>`).join('')}
          </div>
          <div class="candle-host"><canvas id="mkt-candles" height="300"></canvas></div>
          <div class="mkt-stat-row" id="mkt-stats"></div>
        </div>

        <div class="card" style="margin-top:16px">
          <h3>How this price is made
            <span class="right"><a href="#/settings">configure bots →</a></span></h3>
          <p class="muted small-text">Every candle and every print comes from bots hitting real limit-order books on this node:</p>
          <ol class="mkt-how-list">
            <li><b>Traders</b> size orders from mean-reversion + momentum — <span class="mono" style="font-size:11px">size = f(price deviation, momentum, aggression)</span></li>
            <li><b>Market makers</b> quote both sides around fair value and widen their spread when volatility spikes</li>
            <li><b>Arbitrageurs</b> close the gap between the <b>DEX</b> and <b>Secondary</b> books when the spread beats fees</li>
            <li><b>Miner bots</b> mine real SHA-256 blocks — chain activity you can verify on the Explorer</li>
          </ol>
          <div id="mkt-venue-cards" style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px"></div>
        </div>
      </div>

      <div>
        <div class="card">
          <div class="ob-head"><h3 style="margin-bottom:0">Order book</h3>
            <span class="ob-venue-tag" id="ob-venue">PATHchain DEX</span></div>
          <div class="ob-cols"><span>Price</span><span>Size</span><span>Total</span></div>
          <div class="ob-side asks" id="ob-asks"></div>
          <div class="ob-mid"><span class="mid-p" id="ob-mid">—</span><span class="mid-s" id="ob-spread">—</span></div>
          <div class="ob-side bids" id="ob-bids"></div>
        </div>

        <div class="card" style="margin-top:16px">
          <h3>Market depth <span class="right muted">cumulative size</span></h3>
          <div class="depth-host"><canvas id="mkt-depth"></canvas></div>
        </div>

        <div class="card" style="margin-top:16px">
          <h3>Live trades <span class="right muted" id="trades-count"></span></h3>
          <div class="ob-cols"><span>Price</span><span>Size</span><span>Time</span></div>
          <div class="trades-list" id="mkt-trades"><div class="empty">No trades yet — waiting for the bots…</div></div>
        </div>
      </div>
    </div>

    <div class="section-head" style="margin-top:20px"><h2>All markets</h2>
      <span class="right" id="coins-state"></span></div>
    <div class="card">
      <div class="mkt-list" id="mkt-list">
        <div class="mkt-row mkt-head-row">
          <span class="mc-asset">Asset</span><span class="mc-price">Price</span>
          <span class="mc-chg">24h</span><span class="mc-spark">Last 7 days</span><span class="mc-mcap">Market cap</span>
        </div>
        <div id="mkt-rows"><div class="empty">Loading market data…</div></div>
      </div>
    </div>`;

  container.querySelectorAll('#bucket-tabs button').forEach(b => {
    b.addEventListener('click', () => {
      bucket = b.dataset.b;
      container.querySelectorAll('#bucket-tabs button').forEach(x => x.classList.toggle('active', x === b));
      lastChartPaint = 0;
      paintAll(live.snap);
    });
  });

  const paintAll = (snap) => {
    if (!snap) return;
    paintMode(snap);
    paintStats(snap);
    paintChart(snap);
    paintBook(snap);
    paintTrades(snap);
    paintVenues(snap);
  };

  const paintPrice = (p, dir) => {
    const priceEl = document.getElementById('mkt-price');
    if (!priceEl) return;
    tweenNumber(priceEl, p, fmtUsd);
    if (prevPrice !== null && dir !== 0) {
      priceEl.classList.remove('flash-up', 'flash-down');
      void priceEl.offsetWidth;
      priceEl.classList.add(dir > 0 ? 'flash-up' : 'flash-down');
    }
    prevPrice = p;
    const mid = document.getElementById('ob-mid');
    if (mid) {
      mid.textContent = fmtUsd(p);
      mid.classList.remove('up', 'down'); void mid.offsetWidth;
      mid.classList.add(dir >= 0 ? 'up' : 'down');
    }
  };

  paintAll(live.snap);
  paintPrice(live.snap ? live.snap.price : 0, 0);
  offSnap = onSnap(paintAll);
  offPrice = onPrice(paintPrice);
  offCoins = onCoins(paintCoins);
  offLive2 = App.on((s) => { if (s) updateChainStats(s.stats); });
  paintCoins();
}

function paintMode(snap) {
  const elx = document.getElementById('mkt-mode');
  if (!elx) return;
  if (streamHealthy()) {
    elx.innerHTML = `<span class="green">● live</span> · streaming at tick rate · ${snap.bots ? snap.bots.active : 0} bots active`;
  } else if (snap.polled) {
    elx.innerHTML = `<span class="yellow">● polling fallback</span> · stream offline, refreshing 1×/s`;
  } else {
    elx.innerHTML = `connecting to the bot engine…`;
  }
  const reg = document.getElementById('mkt-regime');
  if (reg && snap.regime) {
    reg.innerHTML = `regime <span class="tape-regime ${esc(snap.regime)}">${esc(snap.regime)}</span>`;
  }
}

function paintStats(s) {
  const box = document.getElementById('mkt-stats');
  if (!box) return;
  const mcap = s.supply ? s.price * s.supply : null;
  box.innerHTML = `
    <div><div class="mkt-stat-k">24h high</div><div class="mkt-stat-v">${fmtUsd(s.high24)}</div></div>
    <div><div class="mkt-stat-k">24h low</div><div class="mkt-stat-v">${fmtUsd(s.low24)}</div></div>
    <div><div class="mkt-stat-k">24h volume</div><div class="mkt-stat-v">${fmtNum(s.vol24)} PATH</div></div>
    <div><div class="mkt-stat-k">DEX↔SEC spread</div><div class="mkt-stat-v">${s.spread_ab === null || s.spread_ab === undefined ? '—' : fmtPct(s.spread_ab)}</div></div>
    <div><div class="mkt-stat-k">Market cap</div><div class="mkt-stat-v">${mcap ? fmtCompact(mcap) : '—'}</div></div>
    <div><div class="mkt-stat-k">Supply</div><div class="mkt-stat-v">${s.supply ? fmtNum(s.supply) + ' PATH' : '—'}</div></div>`;
}

function paintChart(s) {
  const now = performance.now();
  if (now - lastChartPaint < 400) return;       // ~2.5 fps is plenty for candles
  lastChartPaint = now;
  const rows = pickCandles(s, bucket);
  drawCandles(document.getElementById('mkt-candles'), rows, {
    height: 300,
    yFmt: v => '$' + v.toFixed(4),
  });
}

function paintBook(s) {
  const d = s.venues && s.venues.a && s.venues.a.depth;
  if (!d) return;
  renderBook(document.getElementById('ob-bids')?.parentElement, d, bookPrev);
  const spreadEl = document.getElementById('ob-spread');
  const a = s.venues.a;
  if (spreadEl && a.best_bid && a.best_ask) {
    spreadEl.textContent = `spread ${fmtUsd(a.best_ask - a.best_bid)} · ${(((a.best_ask - a.best_bid) / a.best_bid) * 100).toFixed(3)}%`;
  }
  const depthCv = document.getElementById('mkt-depth');
  if (depthCv) depthChart(depthCv, d, { height: 120 });
}

function paintTrades(s) {
  const list = document.getElementById('mkt-trades');
  if (!list || !Array.isArray(s.trades)) return;
  const r = renderTrades(list, s.trades, prevTopTrade);
  prevTopTrade = r.topId;
  const count = document.getElementById('trades-count');
  if (count) count.textContent = `${s.trades.length} recent prints`;
}

function paintVenues(s) {
  const box = document.getElementById('mkt-venue-cards');
  if (!box || !s.venues) return;
  const vA = s.venues.a, vB = s.venues.b;
  box.innerHTML = `
    <span class="tape-stat card" style="padding:8px 14px;border-radius:12px"><span class="k">DEX mid</span><span class="v">${fmtUsd(vA.mid)}</span></span>
    <span class="tape-stat card" style="padding:8px 14px;border-radius:12px"><span class="k">Secondary mid</span><span class="v">${fmtUsd(vB.mid)}</span></span>
    <span class="tape-stat card" style="padding:8px 14px;border-radius:12px"><span class="k">Arb spread</span><span class="v" style="color:${Math.abs(s.spread_ab || 0) > 0.12 ? 'var(--green)' : 'var(--muted)'}">${s.spread_ab === null || s.spread_ab === undefined ? '—' : fmtPct(s.spread_ab)}</span></span>`;
}

// ---- real-coin table (unchanged behaviour, offline-safe) --------------------
function paintCoins() {
  const stateEl = document.getElementById('coins-state');
  const rows = document.getElementById('mkt-rows');
  if (!rows) return;
  if (stateEl) {
    if (coinState.state === 'live') stateEl.innerHTML = '<span class="green">live via public API</span>';
    else if (coinState.state === 'cached') stateEl.innerHTML = `<span class="yellow">offline — showing last fetched prices</span>`;
    else if (coinState.state === 'offline') stateEl.innerHTML = `<span class="yellow">offline — real-coin prices unavailable</span>`;
    else stateEl.textContent = '';
  }
  const s = live.snap;
  const pathRow = s ? `
    <div class="mkt-row featured" data-nav-go="#/market" title="The native currency — the chart above">
      <span class="mc-asset"><span class="coin-badge path">P</span>
        <span class="mc-names"><b>PATH</b><span class="mc-full">PATHchain</span></span></span>
      <span class="mc-price">${fmtUsd(s.price)}</span>
      <span class="mc-chg"><span class="chg-chip ${s.chg24h >= 0 ? 'up' : 'down'}">${fmtPct(s.chg24h)}</span></span>
      <span class="mc-spark"><span class="muted small-text">see chart above</span></span>
      <span class="mc-mcap">${s.supply ? fmtCompact(s.price * s.supply) : '—'}</span>
    </div>` : '';
  const coinRows = coinState.rows.map(coinRowHtml).join('');
  rows.innerHTML = pathRow + (coinRows ||
    `<div class="empty">BTC, ETH and other real coins appear here when this device can reach the public price API.</div>`);
  coinState.rows.forEach(c => {
    /* sparkline canvases dropped for offline determinism — table stays live */
  });
}

function coinRowHtml(c) {
  const cls = c.chg24h >= 0 ? 'up' : 'down';
  const stateBadge = c.state === 'live' ? '' : ' <span class="tag-sys">CACHED</span>';
  return `
    <div class="mkt-row" title="${esc(c.name)} — price fetched from a public market API${c.state === 'live' ? '' : ' (last known value, this device is offline)'}">
      <span class="mc-asset"><span class="coin-badge">${esc(c.symbol.slice(0, 1))}</span>
        <span class="mc-names"><b>${esc(c.symbol)}</b><span class="mc-full">${esc(c.name)}${stateBadge}</span></span></span>
      <span class="mc-price">${fmtUsd(c.price)}</span>
      <span class="mc-chg"><span class="chg-chip ${cls}">${fmtPct(c.chg24h)}</span></span>
      <span class="mc-spark"></span>
      <span class="mc-mcap">${fmtCompact(c.mcap)}</span>
    </div>`;
}

export function destroy() {
  if (offSnap) { offSnap(); offSnap = null; }
  if (offPrice) { offPrice(); offPrice = null; }
  if (offCoins) { offCoins(); offCoins = null; }
  if (offLive2) { offLive2(); offLive2 = null; }
  prevTopTrade = 0;
  prevPrice = null;
  for (const k of Object.keys(bookPrev)) delete bookPrev[k];
}
