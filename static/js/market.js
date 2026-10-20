// PATHchain market engine — client-side, zero dependencies.
//
// PATH/USD is a SIMULATED market with a twist: the price series is a
// deterministic random walk (sync SHA-256 chain, so every phone/laptop on the
// LAN sees the exact same candles), and the live price is multiplied by an
// "activity factor" computed from the REAL chain state (supply, transactions,
// hashrate, mempool). Mine a block or send a transfer and the market moves.
//
// Real-coin rows (BTC, ETH, …) come from the public CoinGecko API when the
// internet is reachable; otherwise the last known values are shown and clearly
// marked. No real-coin price is ever invented here.

import { fmtUsd, fmtPct, fmtCompact } from './fmt.js';

// ---------------------------------------------------------------- sha256 ----
// Compact synchronous SHA-256 (FIPS 180-4). Deterministic across devices.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const W = new Uint32Array(64);

function sha256(msg) {
  const len = msg.length;
  const bitLen = len * 8;
  const padded = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  padded.set(msg);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 4, bitLen >>> 0);
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a,
      h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((v, i) => odv.setUint32(i * 4, v));
  return out;
}
const enc = new TextEncoder();
function shaHex(str) {
  const b = sha256(enc.encode(str));
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}
function uni(hex, salt) { // uniform [0,1) from a hex seed + salt
  return parseInt(shaHex(hex + '|' + salt).slice(0, 8), 16) / 4294967296;
}
function gauss(hex, salt) { // standard normal from two uniforms (Box–Muller)
  const u1 = Math.max(1e-12, uni(hex, salt + 'u'));
  const u2 = uni(hex, salt + 'v');
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smooth = (t) => t * t * (3 - 2 * t);

// ------------------------------------------------------------------ walk ----
// PATH "listed" at a fixed reference instant so every device computes the
// identical history. Minute-resolution cumulative walk, mean-reverting to an
// adoption trend, with scheduled volatility regimes and pump/dump events.
const LAUNCH = Date.UTC(2026, 8, 1, 0, 0, 0) / 1000; // 2026-09-01 00:00 UTC
const BASE_PRICE = 0.85;      // USD at launch
const GROWTH = 0.0052;        // log-trend per day (adoption narrative)
const STEP = 60;              // seconds per walk step
const KAPPA = 0.0016;         // mean-reversion pull per step (half-life ~7h)

const dayRegimes = new Map();
function regime(day) {
  let r = dayRegimes.get(day);
  if (r) return r;
  const h = shaHex('path/regime/' + day);
  const f = (i) => parseInt(h.slice(i * 8, i * 8 + 8), 16) / 4294967296;
  r = {
    sigma: 0.0012 + f(0) * 0.0048,
    hasEvent: f(1) < 0.15,
    dir: f(2) < 0.5 ? 1 : -1,
    mag: 0.05 + f(3) * 0.09,
    at: Math.floor(f(4) * 1400),
    dur: 35 + Math.floor(f(5) * 45),
  };
  if (dayRegimes.size > 200) dayRegimes.clear();
  dayRegimes.set(day, r);
  return r;
}

function eventShape(p) { // rises over first 35% of the window, then decays
  if (p <= 0) return 0;
  if (p < 0.35) return smooth(p / 0.35);
  return Math.exp(-(p - 0.35) / 0.30);
}

// Persistent walk state: { mi (next minute to compute), cum (log deviation), hash }
const store = {
  get() {
    try {
      const s = JSON.parse(localStorage.getItem('path.mkt.walk') || 'null');
      if (s && Number.isInteger(s.mi) && isFinite(s.cum) && typeof s.hash === 'string' && s.hash.length === 64) return s;
    } catch (e) { /* private mode etc. */ }
    return null;
  },
  set(s) {
    try { localStorage.setItem('path.mkt.walk', JSON.stringify(s)); } catch (e) { /* ignore */ }
  },
};

let walk = null;          // { mi, cum, hash }
let ring = [];            // recent [{t, cum}] for history (last ~8.5 days)
const RING_CAP = 12800;   // > 8 days of minutes
let lastStore = 0;

function walkInit() {
  walk = store.get() || { mi: 0, cum: 0, hash: shaHex('path/genesis/seed') };
}

function walkAdvanceTo(targetMi) {
  if (!walk) walkInit();
  let guard = 0;
  while (walk.mi < targetMi && guard++ < 400000) {
    const mi = walk.mi;
    const day = Math.floor(mi / 1440);
    const rg = regime(day);
    const miInDay = mi - day * 1440;
    let r = rg.sigma * gauss(walk.hash, 'g');
    r += -KAPPA * walk.cum; // pull back to the trend line
    if (rg.hasEvent && miInDay >= rg.at && miInDay <= rg.at + rg.dur) {
      const p = (miInDay - rg.at) / rg.dur;
      const d = (eventShape(p) - eventShape(p - 1 / rg.dur)) * rg.mag * rg.dir;
      r += d;
    }
    const hash2 = shaHex(walk.hash + '|' + mi);
    walk = { mi: mi + 1, cum: walk.cum + r, hash: hash2 };
    const t = LAUNCH + mi * STEP;
    ring.push({ t, cum: walk.cum });
    if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP);
    if (t > lastStore) { lastStore = t + 305; store.set(walk); }
  }
  return guard < 400000;
}

// price of one minute-close (no activity factor, no jitter)
function basePriceAtCum(cum, tSec) {
  const days = (tSec - LAUNCH) / 86400;
  return BASE_PRICE * Math.exp(GROWTH * days + cum);
}

// ------------------------------------------------------- activity factor ----
// Multiplier from the REAL chain — this is what makes the market react to
// mining and transfers. Fully explainable: every input is on the Networks page.
let chain = { supply: 0, total_txs: 0, height: 0, hashrate: 0, mempool: 0 };
export function updateChainStats(stats) {
  if (!stats) return;
  chain = {
    supply: Number(stats.supply) || 0,
    total_txs: Number(stats.total_txs) || 0,
    height: Number(stats.height) || 0,
    hashrate: Number(stats.network_hashrate_est) || 0,
    mempool: Number(stats.mempool) || 0,
  };
}

export function activityFactor() {
  const c = chain;
  const f = 1
    + 0.035 * Math.log1p(c.total_txs)
    + 0.012 * Math.log1p(c.height)
    + 0.015 * Math.log1p(c.hashrate / 40)
    + 0.008 * Math.min(20, c.mempool);
  return clamp(f, 0.90, 1.50);
}

// Smoothed factor: the market glides toward the target over ~30–60 s instead
// of teleporting when a burst of blocks lands (nicer + more believable).
let displayFactor = null;
export function smoothFactor(target) {
  if (displayFactor === null) displayFactor = target;
  else displayFactor += (target - displayFactor) * 0.05; // ~5% per 2s tick
  return displayFactor;
}

export function activityInputs() {
  return { ...chain, factor: activityFactor() };
}

// ------------------------------------------------------------- live price ----
let curMinute = -1;
function liveJitter(ts) {
  const slot = Math.floor(ts / 2);
  const mi = Math.max(0, Math.floor((ts - LAUNCH) / STEP));
  return 1 + 0.0016 * gauss(shaHex('path/tick/' + mi + '/' + slot), 'j');
}

function minuteClose(mi) {
  // cum for minute mi: advance walk then read from ring (last entry per minute)
  walkAdvanceTo(mi + 1);
  const t = LAUNCH + mi * STEP;
  // ring is append-only in minute order; binary search is overkill, scan tail
  for (let i = ring.length - 1; i >= 0; i--) {
    if (ring[i].t === t) return { t, price: basePriceAtCum(ring[i].cum, t) };
    if (ring[i].t < t) break;
  }
  return { t, price: basePriceAtCum(walk ? walk.cum : 0, t) };
}

// sampled series of minute closes: at most ~240 points over the window
function seriesFor(windowSec, maxPts = 240) {
  const nowMi = Math.max(0, Math.floor((Date.now() / 1000 - LAUNCH) / STEP));
  const startMi = Math.max(0, nowMi - Math.floor(windowSec / STEP));
  const span = Math.max(1, nowMi - startMi);
  const stride = Math.max(1, Math.ceil(span / maxPts));
  const pts = [];
  // ensure ring holds [startMi..nowMi]
  walkAdvanceTo(nowMi + 1);
  const startT = LAUNCH + startMi * STEP;
  for (let i = 0; i < ring.length; i++) {
    if (ring[i].t < startT) continue;
    if ((ring[i].t - startT) % (stride * STEP) < STEP) {
      pts.push({ t: ring[i].t, v: basePriceAtCum(ring[i].cum, ring[i].t) });
    }
  }
  if (!pts.length && walk) pts.push({ t: LAUNCH + nowMi * STEP, v: basePriceAtCum(walk.cum, LAUNCH + nowMi * STEP) });
  return pts;
}

function changeOver(windowSec) {
  const now = Date.now() / 1000;
  const a = minuteClose(Math.max(0, Math.floor((now - LAUNCH - windowSec) / STEP)));
  const b = minuteClose(Math.max(0, Math.floor((now - LAUNCH) / STEP)));
  if (!a.price) return 0;
  return (b.price / a.price - 1) * 100;
}

export function pathSnapshot() {
  const now = Date.now() / 1000;
  const mi = Math.max(0, Math.floor((now - LAUNCH) / STEP));
  const act = smoothFactor(activityFactor());
  const base = minuteClose(mi).price;
  const price = base * act * liveJitter(now);
  const high24 = { v: -Infinity, t: 0 }, low24 = { v: Infinity, t: 0 };
  for (const p of seriesFor(86400, 288)) {
    if (p.v > high24.v) high24.v = p.v;
    if (p.v < low24.v) low24.v = p.v;
  }
  const snap = {
    symbol: 'PATH', price, act,
    chg1h: changeOver(3600), chg24h: changeOver(86400), chg7d: changeOver(604800),
    high24: isFinite(high24.v) ? high24.v * act : price,
    low24: isFinite(low24.v) ? low24.v * act : price,
    mcap: price * chain.supply,
    supply: chain.supply,
    volume24: chain.supply * price * (0.02 + 0.10 * Math.abs(changeOver(86400) / 100) + 0.02 * Math.min(1, chain.mempool / 5)),
  };
  return snap;
}

// ---------------------------------------------------------------- coins -----
const COIN_IDS = 'bitcoin,ethereum,solana,binancecoin,ripple,dogecoin';
const coinStore = {
  get() {
    try { return JSON.parse(localStorage.getItem('path.mkt.coins') || 'null'); } catch (e) { return null; }
  },
  set(rows) {
    try { localStorage.setItem('path.mkt.coins', JSON.stringify({ ts: Date.now(), rows })); } catch (e) { /* ignore */ }
  },
};

export const coins = { rows: [], state: 'loading', lastTs: 0 };

async function fetchCoins() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${COIN_IDS}` +
      `&order=market_cap_desc&sparkline=true&price_change_percentage=24h`,
      { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
    clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) throw new Error('bad payload');
    coins.rows = data.map(c => ({
      id: c.id, symbol: String(c.symbol || '').toUpperCase(), name: c.name,
      price: Number(c.current_price), chg24h: Number(c.price_change_percentage_24h),
      mcap: Number(c.market_cap),
      spark: downsample((c.sparkline_in_7d && c.sparkline_in_7d.price) || [], 56),
      state: 'live',
    })).filter(c => isFinite(c.price));
    coins.state = 'live';
    coins.lastTs = Date.now();
    coinStore.set(coins.rows);
    listeners.coins.forEach(fn => { try { fn(coins); } catch (e) {} });
  } catch (e) {
    clearTimeout(timer);
    const cached = coinStore.get();
    if (cached && cached.rows && cached.rows.length) {
      coins.rows = cached.rows.map(r => ({ ...r, state: 'cached' }));
      coins.lastTs = cached.ts;
      coins.state = 'cached';
    } else {
      coins.state = 'offline';
    }
    listeners.coins.forEach(fn => { try { fn(coins); } catch (e) {} });
    scheduleCoins(coins.state === 'cached' ? 300000 : 45000); // retry later
  }
}

function downsample(arr, n) {
  if (!arr || arr.length <= n) return (arr || []).slice();
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * arr.length / n)]);
  return out;
}

let coinsTimer = null;
function scheduleCoins(delay) {
  clearTimeout(coinsTimer);
  coinsTimer = setTimeout(pollCoins, delay);
}
function pollCoins() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) { scheduleCoins(60000); return; }
  fetchCoins().finally(() => { if (coins.state === 'live') scheduleCoins(90000); });
}

// ---------------------------------------------------------------- wiring ----
const listeners = { tick: new Set(), coins: new Set() };
export function onTick(fn) { listeners.tick.add(fn); return () => listeners.tick.delete(fn); }
export function onCoins(fn) { listeners.coins.add(fn); return () => listeners.coins.delete(fn); }

let tickTimer = null;
function startEngine() {
  if (tickTimer) return;
  walkInit();
  pollCoins();
  tickTimer = setInterval(() => {
    if (document.hidden) return;
    const snap = pathSnapshot();
    listeners.tick.forEach(fn => { try { fn(snap); } catch (e) { console.error(e); } });
  }, 2000);
}
export function ensureEngine() { startEngine(); }

// history accessor for the chart page
export function pathSeries(windowSec) { return seriesFor(windowSec); }
export const MARKET = { LAUNCH, STEP, isSimulated: true };

// convenience formatting re-exports
export { fmtUsd, fmtPct, fmtCompact };
