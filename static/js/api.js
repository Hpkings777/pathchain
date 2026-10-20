// PATHchain — API client + global live state
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
  tamper: (note) => req('demo/tamper', post({ note })),
  search: (q) => req('search?q=' + encodeURIComponent(q)),
};

function post(obj) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj || {}),
  };
}

// ---- global live state (polled every 1.5s while visible; pages read App.state) ----
export const App = {
  state: null,
  listeners: new Set(),
  pollTimer: null,
  failStreak: 0,

  async refresh() {
    if (document.hidden) return; // save battery/data on phones
    try {
      this.state = await api.state();
      this.failStreak = 0;
      this.renderNav();
      this.renderAlertBanner();
      this.listeners.forEach(fn => { try { fn(this.state); } catch (e) { console.error(e); } });
    } catch (e) {
      this.failStreak++;
      const dot = document.querySelector('#nav-node .dot');
      if (dot) dot.className = 'dot dot-red';
      const name = document.getElementById('nav-node-name');
      if (name) name.innerHTML = '<span class="muted">reconnecting…</span>';
    }
    this.scheduleNext();
  },

  scheduleNext() {
    clearInterval(this.pollTimer);
    // normal 1.5s; back off up to 6s while the node is unreachable
    const delay = this.failStreak > 3 ? 6000 : 1500;
    this.pollTimer = setTimeout(() => this.refresh(), delay);
  },

  start() {
    this.refresh();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.refresh(); // instant catch-up when you come back
    });
  },

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },

  renderNav() {
    const s = this.state; if (!s) return;
    document.getElementById('nav-node-name').innerHTML =
      `<b>${esc(s.self.name)}</b>`;
    document.getElementById('nav-node-meta').textContent =
      ` #${s.self.height} · ${s.stats.peers} peer${s.stats.peers === 1 ? '' : 's'} · ${s.self.mempool_size} pending`;
    const dot = document.querySelector('#nav-node .dot');
    dot.className = 'dot ' + (s.self.compromised ? 'dot-red' : 'dot-green');
  },

  renderAlertBanner() {
    const s = this.state; if (!s) return;
    const banner = document.getElementById('alert-banner');
    if (s.self.compromised) {
      banner.className = 'alert-banner red';
      banner.style.display = 'flex';
      banner.innerHTML = `
        <span><b>Chain compromised</b> — block #${s.self.bad_index} fails validation. Mining is halted. The network is voting on a rollback.</span>
        <a class="btn btn-sm btn-red" href="#/network">Open consensus panel</a>`;
      return;
    }
    const poll = s.poll;
    if (poll && poll.closed) {
      banner.className = 'alert-banner ' + (poll.approved ? 'green' : 'red');
      banner.style.display = 'flex';
      banner.innerHTML = poll.approved
        ? `<span><b>Consensus reached</b> — ${esc(poll.yes || 0)} YES / ${esc(poll.no || 0)} NO. Tampered blocks rolled back network-wide (epoch bumped). Chain restored.</span>
           <button class="btn btn-sm" id="banner-dismiss">Dismiss</button>`
        : `<span><b>Consensus rejected the rollback</b> (${esc(poll.yes || 0)} YES / ${esc(poll.no || 0)} NO) — the tampered chain remains flagged.</span>
           <button class="btn btn-sm" id="banner-dismiss">Dismiss</button>`;
      const d = banner.querySelector('#banner-dismiss');
      if (d) d.onclick = async () => { await api.dismissPoll(); };
      return;
    }
    if (poll && !poll.hidden && poll.has_voted) {
      banner.className = 'alert-banner red';
      banner.style.display = 'flex';
      banner.innerHTML = `<span><b>Vote recorded</b> — waiting for the rest of the network (${esc(poll.yes || 0)} YES / ${esc(poll.no || 0)} NO, needs ${esc(poll.required || '?')} YES).</span>
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
        <a class="btn btn-sm" href="#/network">Details</a>`;
      banner.querySelector('#banner-vote-yes').onclick = async () => {
        await api.vote(true); toast('YES vote broadcast', 'ok');
      };
      banner.querySelector('#banner-vote-no').onclick = async () => {
        await api.vote(false); toast('NO vote broadcast', '');
      };
      return;
    }
    banner.style.display = 'none';
  },
};
