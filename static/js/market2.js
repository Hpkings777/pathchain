// PATHchain — live market client (server-driven bot engine).
//
// The node's MarketEngine streams snapshots over SSE at the configured tick
// rate. The displayed price eases toward the server target inside a
// requestAnimationFrame loop — smooth, no setInterval jumps. If SSE dies,
// a 1 s poller keeps the page alive (clearly marked).
import { live, api, renderTape } from './api.js';

// re-export so pages can treat this module as the single live-market surface
export { live };

const snapListeners = new Set();
const priceListeners = new Set();

let displayPrice = null;      // eased price shown in the UI
let targetPrice = null;       // latest server price
let lastDir = 0;              // -1 / 0 / +1 — direction of the last move
let rafId = null;
let pollTimer = null;
let started = false;

export function ensureMarketLive() {
  if (started) return;
  started = true;
  live.start();
  if (live.snap) ingest(live.snap);
  live.on(ingest);
  // fallback poller: only fetches when the stream is unhealthy
  pollTimer = setInterval(async () => {
    if (document.hidden) return;
    if (live.healthy()) return;
    try {
      const snap = await api.market();
      ingest({ ...snap, polled: true });
    } catch (e) { /* offline — the state poller shows the reconnect chip */ }
  }, 1000);
  startRaf();
}

function ingest(snap) {
  if (!snap || typeof snap.price !== 'number') return;
  targetPrice = snap.price;
  if (displayPrice === null) displayPrice = snap.price;
  renderTape(snap);
  snapListeners.forEach(fn => { try { fn(snap); } catch (e) { console.error(e); } });
}

function startRaf() {
  if (rafId !== null) return;
  let last = performance.now();
  const frame = (now) => {
    rafId = requestAnimationFrame(frame);
    if (document.hidden) { last = now; return; }
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (targetPrice === null || displayPrice === null) return;
    const diff = targetPrice - displayPrice;
    if (Math.abs(diff) < 1e-7) return;
    // exponential ease — reaches ~95% of the gap in ~300ms at 60fps
    displayPrice += diff * (1 - Math.exp(-dt * 10));
    if (Math.abs(targetPrice - displayPrice) < Math.max(1e-7, targetPrice * 1e-8)) {
      displayPrice = targetPrice;
    }
    lastDir = diff > 0 ? 1 : -1;
    const p = displayPrice;
    priceListeners.forEach(fn => { try { fn(p, lastDir); } catch (e) { console.error(e); } });
  };
  rafId = requestAnimationFrame(frame);
}

export function onSnap(fn) { snapListeners.add(fn); return () => snapListeners.delete(fn); }
export function onPrice(fn) { priceListeners.add(fn); return () => priceListeners.delete(fn); }
export function currentDisplayPrice() { return displayPrice; }
export function streamHealthy() { return live.healthy(); }

// ---- shared market page helpers --------------------------------------------
// ids match the server's candle bucket keys exactly (bots.py BUCKET_SIZES)
export const BUCKETS = [
  { id: '2', label: '2s' },
  { id: '10', label: '10s' },
  { id: '60', label: '1m' },
  { id: '300', label: '5m' },
];

export function pickCandles(snap, bucketId) {
  if (!snap || !snap.candles) return [];
  return snap.candles[String(bucketId)] || [];
}
