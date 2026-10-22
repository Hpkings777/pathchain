// PATHchain — API client + global live state + SSE market stream.
// Every fetch is same-origin (works offline on LAN, no CDN, no absolutes).
import { esc } from './ui.js';

async function req(path, opts = {}) {
  let res;
  try {
    res = await fetch('/api/' + path, opts);
  } catch (e) {
    throw new Error('Cannot reach this node — check that it is running');
  }
  if (!res.ok && res.status !== 400) throw new Error(`HTTP ${res.status}`);
  let body;
  try { body = await res.json(); }
  catch (e) { throw new Error('Node returned a non-JSON response'); }
  if (!body.ok) throw new Error(body.error || 'request failed');
  return body.data;
}

export const api = {
  state: () => req('state'),
  blocks: (offset = 0, limit = 20) => req(`blocks?offset=${offset}&limit=${limit}`),
  block: (ref) => req('block/' + encodeURIComponent(ref)),
  tx: (txid) => req('tx/' + encodeURIComponent(txid)),
  address: (addr) => req('address/' + encodeURIComponent(addr)),
  wallets: () => req('wallets'),
  walletKeys: (name) => req(`wallet/${encodeURIComponent(name)}/keys`),
  createWallet: (name) => req('wallet', post({ name })),
  send: (from_name, to, amount) => req('send', post({ from_name, to, amount })),
  mine: (action, attempts = 1) => req('mine', post({ action, attempts })),
  mineStatus: () => req('mine/status'),
  series: () => req('stats_series'),
  peers: () => req('peers'),
  events: () => req('events'),
  poll: () => req('poll'),
  vote: (v) => req('poll/vote', post({ vote: v })),
  dismissPoll: () => req('reset_vote_ui', post({})),
  connect: (target) => req('peer/connect', post({ target })),
  tamper: (note, index = null) => req('demo/tamper', post({ note, index })),
  rollback: () => req('demo/rollback', post({})),
  search: (q) => req('search?q=' + encodeURIComponent(q)),
  market: () => req('market'),
  marketCandles: (bucket) => req(`market/candles?bucket=${encodeURIComponent(bucket)}`),
  bots: () => req('bots'),
  saveBots: (config) => req('bots/config', post({ config })),
  toggleBots: (enabled) => req('bots/toggle', post({ enabled })),
};

function post(obj) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj || {}),
  };
}

// ---- SSE live market stream (server pushes at the bot tick rate) ----------
// Falls back to polling inside the market pages when this is unhealthy.
export const live = {
  es: null,
  snap: null,            // last market snapshot from the server
  connected: false,
  attempts: 0,
  listeners: new Set(),
  _timer: null,
  _candles: null,        // last full candle payload (light frames omit it)

  start() {
    if (this.es || typeof EventSource === 'undefined') return;
    try {
      const es = new EventSource('/api/stream');
      this.es = es;
      es.addEventListener('market', (e) => {
        try {
          const snap = JSON.parse(e.data);
          // light frames ship no candle arrays (~85% of payload) — merge the
          // cached ones so consumers always see a complete snapshot
          if (snap.candles) this._candles = snap.candles;
          else if (this._candles) snap.candles = this._candles;
          this.snap = snap;
          this.connected = true;
          this.attempts = 0;
          this.listeners.forEach(fn => { try { fn(this.snap); } catch (err) { console.error(err); } });
        } catch (err) { /* malformed frame — skip */ }
      });
      es.onopen = () => { this.connected = true; this.attempts = 0; };
      es.onerror = () => {
        this.connected = false;
        try { es.close(); } catch (e) { /* noop */ }
        this.es = null;
        // exponential retry: 1s, 2s, 4s … capped at 30s (mirrors the state poll)
        this.attempts++;
        const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(this.attempts, 5)));
        clearTimeout(this._timer);
        this._timer = setTimeout(() => this.start(), delay);
      };
    } catch (e) {
      this.connected = false;   // EventSource unavailable — polling fallback covers us
    }
  },

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  healthy() { return this.connected && this.snap && (Date.now() / 1000 - (this.snap.ts || 0)) < 8; },
};

// ---- pending-operation queue (graceful degradation when the node drops) ----
// Ops queued while offline replay automatically on reconnect; if replay fails
// the user gets a toast with explicit Retry / Discard choices.
const pendingOps = [];
let flushing = false;

function flushPending() {
  if (flushing || !pendingOps.length) return;
  flushing = true;
  (async () => {
    while (pendingOps.length) {
      const op = pendingOps[0];
      try {
        await op.run();
        pendingOps.shift();
      } catch (e) {
        pendingOps.shift();
        import('./ui.js').then(({ toastWithActions }) => {
          toastWithActions(`"${op.label}" failed: ${e.message}`, [
            { label: 'Retry', run: () => { pendingOps.unshift(op); flushPending(); } },
            { label: 'Discard', run: () => {} },
          ], 'err');
        }).catch(() => {});
      }
    }
    flushing = false;
  })();
}

// ---- global live state (polled with exponential backoff) -------------------
export const App = {
  state: null,
  listeners: new Set(),
  pollTimer: null,
  failStreak: 0,

  async refresh() {
    if (document.hidden) return; // save battery/data on phones
    try {
      this.state = await api.state();
      if (this.failStreak > 0) toastOnceBack();
      this.failStreak = 0;
      setReconnectChip(false);
      this.renderNav();
      this.renderAlertBanner();
      this.renderTapeFallback();
      this.listeners.forEach(fn => { try { fn(this.state); } catch (e) { console.error(e); } });
      flushPending();
    } catch (e) {
      this.failStreak++;
      setReconnectChip(true, this.failStreak);
      const dot = document.querySelector('#nav-node .dot');
      if (dot) dot.className = 'dot dot-red';
      const name = document.getElementById('nav-node-name');
      if (name) name.innerHTML = '<span class="muted">reconnecting…</span>';
    }
    this.scheduleNext();
  },

  scheduleNext() {
    clearTimeout(this.pollTimer);
    // exponential backoff: 1.5s → 2s → 4s → 8s → 16s → 30s (spec: 1s→30s band)
    const base = this.failStreak === 0 ? 1500
      : Math.min(30000, 1000 * Math.pow(2, this.failStreak));
    this.pollTimer = setTimeout(() => this.refresh(), base);
  },

  start() {
    this.refresh();
    live.start();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.refresh(); // instant catch-up when you come back
    });
  },

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },

  // queue an operation for replay when connectivity returns
  enqueue(label, run) {
    pendingOps.push({ label, run, ts: Date.now() });
    import('./ui.js').then(({ toast }) => toast(`Queued "${label}" — it will run when the node is reachable again`, '')).catch(() => {});
  },

  renderNav() {
    const s = this.state; if (!s) return;
    document.getElementById('nav-node-name').innerHTML =
      `<b>${esc(s.self.name)}</b>`;
    document.getElementById('nav-node-meta').textContent =
      ` #${s.self.height} · ${s.stats.peers} peer${s.stats.peers === 1 ? '' : 's'} · ${s.self.mempool_size} pending`;
    const dot = document.querySelector('#nav-node .dot');
    dot.className = 'dot ' + (s.self.compromised ? 'dot-red' : 'dot-green');
    const nodeChip = document.getElementById('tape-node');
    if (nodeChip && !nodeChip.textContent) nodeChip.textContent = s.self.name;
  },

  renderTapeFallback() {
    // SSE owns the tape when healthy; this keeps it correct during outages
    const tape = document.getElementById('tape');
    if (!tape) return;
    if (!live.healthy() && this.state && this.state.market) {
      renderTape(this.state.market);
    }
  },

  renderAlertBanner() {
    const s = this.state; if (!s) return;
    const banner = document.getElementById('alert-banner');
    if (s.self.compromised) {
      banner.className = 'alert-banner red';
      banner.style.display = 'flex';
      banner.innerHTML = `
        <span><b>Chain compromised</b> — block #${s.self.bad_index} fails validation. Mining is halted. The network is voting on a rollback.</span>
        <a class="btn btn-sm btn-red" href="#/chain">See it on the chain view</a>
        <a class="btn btn-sm" href="#/network">Open consensus panel</a>`;
      return;
    }
    const poll = s.poll;
    if (poll && poll.closed) {
      banner.className = 'alert-banner ' + (poll.approved ? 'green' : 'red');
      banner.style.display = 'flex';
      banner.innerHTML = poll.approved
        ? `<span><b>Consensus reached</b> — ${esc(poll.yes || 0)} YES / ${esc(poll.no || 0)} NO. Tampered blocks rolled back network-wide (epoch bumped). Chain restored.</span>
           <button class="btn btn-sm" id="banner-dismiss">Dismiss</button>`
        : `<span><b>Consensus rejected the rollback</b> (${esc(poll.yes || 0)} YES / ${esc(poll.no || 0)} NO) — the tampered chain remains flagged. You can restore it manually.</span>
           <button class="btn btn-sm btn-red" id="banner-reset">Reset chain</button>
           <button class="btn btn-sm" id="banner-dismiss">Dismiss</button>`;
      const d = banner.querySelector('#banner-dismiss');
      if (d) d.onclick = async () => { await api.dismissPoll(); };
      const r = banner.querySelector('#banner-reset');
      if (r) r.onclick = async () => {
        try { const res = await api.rollback(); toastOnce(res.message, 'ok'); }
        catch (e) { toastOnce(e.message, 'err'); }
      };
      return;
    }
    if (poll && !poll.hidden && poll.has_voted) {
      banner.className = 'alert-banner red';
      banner.style.display = 'flex';
      banner.innerHTML = `<span><b>Vote recorded</b> — waiting for the rest of the network (${esc(poll.yes || 0)} YES / ${esc(poll.no || 0)} NO, needs ${esc(poll.required || '?')} YES). You can change your vote in the consensus panel.</span>
        <a class="btn btn-sm" href="#/network">Open consensus panel</a>`;
      return;
    }
    if (poll && !poll.hidden && poll.is_eligible !== false) {
      banner.className = 'alert-banner red';
      banner.style.display = 'flex';
      banner.innerHTML = `
        <span>SECURITY ALERT: tampering by <b>${esc(poll.hacker)}</b> — block #${poll.compromised_from}. Required: ${poll.required} YES votes.</span>
        <button class="btn btn-sm btn-green" id="banner-vote-yes">Vote ROLLBACK</button>
        <button class="btn btn-sm" id="banner-vote-no">Vote KEEP</button>
        <a class="btn btn-sm" href="#/chain">Details</a>`;
      banner.querySelector('#banner-vote-yes').onclick = async () => {
        try { const r = await api.vote(true); toastOnce(r.message, 'ok'); } catch (e) { toastOnce(e.message, 'err'); }
      };
      banner.querySelector('#banner-vote-no').onclick = async () => {
        try { const r = await api.vote(false); toastOnce(r.message, ''); } catch (e) { toastOnce(e.message, 'err'); }
      };
      return;
    }
    banner.style.display = 'none';
  },
};

// ---- site-wide ticker tape rendering (shared by SSE + fallback) ------------
export function renderTape(m) {
  const tape = document.getElementById('tape');
  if (!tape || !m) return;
  tape.hidden = false;
  const priceEl = document.getElementById('tape-price');
  const prev = Number(priceEl.dataset.raw || 0);
  priceEl.dataset.raw = String(m.price);
  priceEl.textContent = '$' + Number(m.price).toFixed(4);
  if (prev && Math.abs(m.price - prev) > 1e-9) {
    priceEl.classList.toggle('up', m.price > prev);
    priceEl.classList.toggle('down', m.price < prev);
  }
  const chg = document.getElementById('tape-chg');
  chg.textContent = `${m.chg24h >= 0 ? '+' : ''}${Number(m.chg24h).toFixed(2)}%`;
  chg.style.color = m.chg24h >= 0 ? 'var(--green)' : 'var(--red)';
  const vol = document.getElementById('tape-vol');
  vol.textContent = fmtVol(m.vol24);
  const bots = document.getElementById('tape-bots');
  if (bots) bots.textContent = m.bots && m.bots.active !== undefined ? `${m.bots.active} live` : '—';
  const reg = document.getElementById('tape-regime');
  if (reg && m.regime) {
    reg.textContent = m.regime;
    reg.className = 'tape-regime ' + m.regime;
  }
  // scrolling prints (recent trades, doubled for a seamless loop)
  const scroll = document.getElementById('tape-scroll');
  if (scroll && Array.isArray(m.trades) && m.trades.length) {
    const chips = m.trades.slice(0, 14).map(t =>
      `<span class="tape-print ${t.side === 'buy' ? 'buy' : 'sell'}"><span class="tp-p">$${Number(t.price).toFixed(4)}</span><span class="tp-s">${Number(t.size).toFixed(1)} PATH</span><span class="tp-s">${esc(t.venue === 'PATHchain DEX' ? 'DEX' : 'SEC')}</span></span>`
    ).join('');
    if (scroll.dataset.sig !== chips) {
      scroll.dataset.sig = chips;
      scroll.innerHTML = chips + chips;   // 2× content = seamless marquee
    }
  }
}

function fmtVol(v) {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return Number(v).toFixed(1);
}

// ---- reconnect chip --------------------------------------------------------
let chipTimer = null;
function setReconnectChip(show, streak = 0) {
  const chip = document.getElementById('reconnect-chip');
  if (!chip) return;
  if (show) {
    chip.classList.add('show');
    const label = chip.querySelector('span');
    if (label) {
      const secs = Math.min(30, streak >= 5 ? 30 : 1000 * Math.pow(2, streak) / 1000);
      label.textContent = streak > 1 ? `Reconnecting… (retry ~${Math.round(secs)}s)` : 'Reconnecting…';
    }
    clearTimeout(chipTimer);
  } else {
    chipTimer = setTimeout(() => chip.classList.remove('show'), 600);
  }
}

let lastBackToast = 0;
function toastOnceBack() {
  if (Date.now() - lastBackToast < 4000) return;
  lastBackToast = Date.now();
  import('./ui.js').then(({ toast }) => toast('Connection restored — back in sync with the node', 'ok')).catch(() => {});
}
let lastToastMsg = '', lastToastTs = 0;
function toastOnce(msg, kind) {
  if (msg === lastToastMsg && Date.now() - lastToastTs < 3000) return;
  lastToastMsg = msg; lastToastTs = Date.now();
  import('./ui.js').then(({ toast }) => toast(msg, kind)).catch(() => {});
}

// ---- theme toggle + settings entry (wired once, site-wide) ------------------
function wireChrome() {
  const themeBtn = document.getElementById('btn-theme');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const root = document.documentElement;
      const next = root.dataset.theme === 'light' ? '' : 'light';
      if (next) root.dataset.theme = next; else delete root.dataset.theme;
      try { localStorage.setItem('path.theme', next); } catch (e) { /* private mode */ }
    });
  }
  const gear = document.getElementById('btn-settings');
  if (gear) gear.addEventListener('click', () => { location.hash = '#/settings'; });
}
wireChrome();
