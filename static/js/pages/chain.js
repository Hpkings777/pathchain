// PATHchain — Chain page: the visual blockchain flowchart.
import { App, api } from '../api.js';
import { el, esc, empty, badge, toast, confirmDanger } from '../ui.js';
import { fmtNum, timeAgo, shortHash, COIN } from '../fmt.js';
import { blockCard, linkEl, applyIntegrity, playTamperTheatre, playRestore, openBlockPanel } from '../chainview.js';

const MAX_CARDS = 22;

let offLive = null;
let lastTip = -1;
let lastBad = null;       // null = clean, number = first bad block
let lastEpoch = -1;       // +1 on every rollback — a bump invalidates all cards
let rendered = false;
let autoFollow = true;

export async function render(container) {
  lastTip = App.state ? App.state.self.height : -1;
  lastBad = null;
  lastEpoch = App.state ? App.state.self.epoch : -1;
  rendered = false;

  container.innerHTML = `
    <div class="section-head"><h2>Chain view</h2>
      <span class="right muted">every block commits to the hash of the block before it — break one link and the whole tail lights up</span></div>

    <div class="grid cols-6" id="chain-stats" style="margin-bottom:16px"></div>

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
        <h3 style="margin-bottom:0">Block linkage <span class="right" id="chain-flow-status"></span></h3>
        <div style="display:flex;gap:8px;align-items:center">
          <label class="toggle" title="Jump to the newest block as it lands">
            <input type="checkbox" id="flow-follow" checked><span class="track"></span><span class="tl" style="font-size:12px">auto-follow</span>
          </label>
          <button class="btn btn-sm btn-red" id="btn-reset-chain" style="display:none">Reset chain</button>
        </div>
      </div>
      <div class="chainflow-wrap" id="flow-wrap"><div class="chainflow" id="chainflow">${empty('Loading the chain…')}</div></div>
      <div class="chain-legend" id="chain-legend"></div>
    </div>

    <div class="grid cols-2" style="margin-top:16px">
      <div class="card">
        <h3>Why the chain can't be quietly rewritten</h3>
        <p class="muted" style="font-size:13px;line-height:1.6">Each block header contains the <b>hash of its parent</b>. A hash is a fingerprint: edit one digit of a transaction inside block #N and the fingerprint stored in block #N no longer matches — and because block #N+1 committed to the OLD fingerprint, block #N+1 breaks too. And #N+2. All the way to the tip.</p>
        <p class="muted" style="font-size:13px;line-height:1.6">To hide the damage you would have to re-mine every block after the edit — solving the same proof-of-work lottery the whole network already solved — faster than the honest miners extend the real chain. That is the actual security guarantee of Proof-of-Work.</p>
      </div>
      <div class="card">
        <h3>Try it (safe, network-wide demo)</h3>
        <p class="muted" style="font-size:13px;line-height:1.6">Click any block → <b>Edit this block's data</b>. The card shakes, its hash flickers to the new mismatched value, every downstream block flashes a warning, and the arrows to its neighbours turn red.</p>
        <p class="muted" style="font-size:13px;line-height:1.6">With at least one peer connected, a <b>consensus vote</b> overlay appears — each peer stamps the tampered block ❌ as it rejects it. Majority YES rolls the chain back; the <b>Reset chain</b> button does the same locally.</p>
        <p class="muted" style="font-size:12px">Tip: the demo needs ≥ 1 connected peer to trigger the vote — open Network and connect a second node.</p>
      </div>
    </div>`;

  // fix template literal slip above (kept simple): stats row rebuilt below
  const statsRow = container.querySelector('#chain-stats');
  statsRow.innerHTML = ['height', 'status', 'epoch', 'difficulty', 'mempool', 'supply'].map(k =>
    `<div class="card stat-card" data-k="${k}"><div class="label"></div><div class="value">—</div><div class="sub"></div></div>`).join('');

  const follow = container.querySelector('#flow-follow');
  follow.addEventListener('change', () => { autoFollow = follow.checked; });

  container.querySelector('#btn-reset-chain').addEventListener('click', async (e) => {
    const ok = await confirmDanger({
      title: 'Reset the chain to its last valid state?',
      body: 'Every tampered block from the first invalid one onward is removed locally and the epoch is bumped. Peers receive the recovery snapshot and adopt it.',
      confirmLabel: 'Reset chain',
    });
    if (!ok) return;
    try {
      const r = await api.rollback();
      toast(r.message, 'ok');
      await loadFlow(container, true);
    } catch (err) { toast(err.message, 'err'); }
  });

  const flow = container.querySelector('#chainflow');
  flow.addEventListener('click', (e) => {
    const card = e.target.closest('.chain-node');
    if (card) openBlockPanel(Number(card.dataset.height), {
      onTampered: () => setTimeout(() => loadFlow(container), 400),
    });
    const link = e.target.closest('a[href^="#/tx/"]');
    if (link) { /* panel auto-closes via data-close-panel */ }
  });
  flow.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.chain-node');
    if (card) { e.preventDefault(); openBlockPanel(Number(card.dataset.height)); }
  });

  paintLegend();
  await loadFlow(container);
  offLive = App.on(() => loadFlow(container));
}

async function loadFlow(container, force = false) {
  const s = App.state;
  const flow = document.getElementById('chainflow');
  if (!flow || !s) return;
  paintStats(s);

  const bad = s.self.compromised ? s.self.bad_index : null;
  const resetBtn = document.getElementById('btn-reset-chain');
  if (resetBtn) resetBtn.style.display = (bad !== null) ? '' : 'none';
  const statusEl = document.getElementById('chain-flow-status');
  if (statusEl) {
    statusEl.innerHTML = bad !== null
      ? badge(`INVALID FROM #${bad}`, 'red')
      : badge(`TIP #${s.self.height} · ALL VALID`, 'green');
  }

  let data;
  try { data = await api.blocks(0, MAX_CARDS); }
  catch (e) { return; }
  const blocks = [...data.blocks].reverse();   // oldest → newest (genesis first)

  // a rollback (epoch bump) re-mines blocks at the SAME heights — the stale
  // cards would keep showing the old hashes forever, so force a full repaint
  if (s.self.epoch !== lastEpoch) {
    rendered = false;
    lastEpoch = s.self.epoch;
  }

  if (!rendered || force) {
    flow.innerHTML = '';
    blocks.forEach((b, i) => {
      flow.appendChild(blockCard(b, i));
      if (i < blocks.length - 1) flow.appendChild(linkEl(i));
    });
    rendered = true;
    lastTip = s.self.height;
    applyIntegrity(flow, bad);
    scrollToTip();
    return;
  }

  // incremental: append cards for heights we have not rendered yet
  const have = new Set([...flow.querySelectorAll('.chain-node')].map(c => Number(c.dataset.height)));
  let idx = flow.querySelectorAll('.chain-node').length;
  let added = false;
  for (const b of blocks) {
    if (have.has(b.height)) continue;
    if (flow.querySelector('.empty')) flow.innerHTML = '';
    if (flow.children.length) flow.appendChild(linkEl(idx));
    const card = blockCard(b, idx);
    card.classList.add('is-new');
    flow.appendChild(card);
    have.add(b.height);
    idx++;
    added = true;
    setTimeout(() => card.classList.remove('is-new'), 3200);
  }
  // trim the oldest cards beyond MAX_CARDS
  while (flow.querySelectorAll('.chain-node').length > MAX_CARDS) {
    const first = flow.querySelector('.chain-node');
    const link = first.nextElementSibling;
    if (link && link.classList.contains('cn-link')) link.remove();
    first.remove();
  }
  if (added) { lastTip = s.self.height; scrollToTip(); }

  // integrity transitions drive the theatre
  applyIntegrity(flow, bad);
  if (bad !== null && lastBad === null) {
    playTamperTheatre(flow, bad);
    statusEl && (statusEl.innerHTML = badge('TAMPER DETECTED', 'red'));
  }
  if (bad === null && lastBad !== null) {
    playRestore(flow);
  }
  lastBad = bad;
}

function scrollToTip() {
  if (!autoFollow) return;
  const wrap = document.getElementById('flow-wrap');
  if (wrap) wrap.scrollTo({ left: wrap.scrollWidth, behavior: 'smooth' });
}

function paintStats(s) {
  const row = document.getElementById('chain-stats');
  if (!row) return;
  const set = (k, label, value, sub) => {
    const card = row.querySelector(`[data-k="${k}"]`);
    if (!card) return;
    card.querySelector('.label').textContent = label;
    const v = card.querySelector('.value');
    v.innerHTML = value;
    card.querySelector('.sub').textContent = sub || '';
  };
  set('height', 'Chain height', `#${s.stats.height}`, `incl. genesis · tip ${shortHash(s.self.tip_hash, 8, 6)}`);
  set('status', 'Integrity',
    s.self.compromised ? '<span class="red">COMPROMISED</span>' : '<span class="green">VALID</span>',
    s.self.compromised ? `first bad block #${s.self.bad_index}` : 'every block re-verified');
  set('epoch', 'Epoch', String(s.self.epoch), '+1 after each rollback');
  set('difficulty', 'Difficulty', `${s.stats.bits} zeros`, `${fmtNum(s.stats.difficulty)} avg hashes per block`);
  set('mempool', 'Mempool', String(s.stats.mempool), 'transactions waiting');
  set('supply', 'Supply', fmtNum(s.stats.supply), `${COIN} issued via mining only`);
}

function paintLegend() {
  const box = document.getElementById('chain-legend');
  if (!box) return;
  box.innerHTML = `
    <span class="lg"><span class="sw" style="background:var(--panel);border-color:var(--accent)"></span> valid block</span>
    <span class="lg"><span class="sw" style="background:var(--red-soft);border-color:var(--red)"></span> tampered block (shakes + hash flickers)</span>
    <span class="lg"><span class="sw" style="background:var(--panel);border-color:var(--amber)"></span> downstream — integrity broken</span>
    <span class="lg"><span class="sw" style="background:var(--accent);"></span> hash linkage arrow</span>
    <span class="lg"><span class="sw" style="background:repeating-linear-gradient(90deg,var(--red) 0 5px,transparent 5px 9px)"></span> broken linkage (animated)</span>
    <span class="muted">click any card for the full header, merkle root and transactions</span>`;
}

export function destroy() {
  if (offLive) { offLive(); offLive = null; }
  rendered = false;
}
