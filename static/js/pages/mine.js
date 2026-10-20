// PATHchain — Mining Lab: SEE proof-of-work happening, hash by hash.
import { App, api } from '../api.js';
import { el, esc, empty, badge, toast, nodeChip } from '../ui.js';
import { fmtAmount, fmtNum, fmtRate, fmtDur, timeAgo, shortHash, COIN } from '../fmt.js';

let offLive = null;
let fastTimer = null;
let lastBlockHeight = -1;

const STEP_DEFS = [
  { t: 'Collect transactions', p: 'Pull pending transfers from the mempool and add one coinbase (the +10 PATH reward). This is the block template.' },
  { t: 'Build the header', p: 'Header = previous hash + merkle root + timestamp + difficulty + miner address. It commits to ALL of it.' },
  { t: 'Hash with a nonce', p: 'SHA-256(header + nonce). One nonce = one lottery ticket. Each attempt gives a totally unpredictable hash.' },
  { t: 'Check the target', p: 'Does the hash start with the required zeros? If yes — you found the golden nonce. If not, bump the nonce by 1 and retry.' },
  { t: 'Broadcast the block', p: 'Send the block to every peer. They re-hash your header and check the target BEFORE accepting it. Cheating is impossible.' },
  { t: 'Collect the reward', p: 'The coinbase pays new PATH to your address, every node replays it, and the chain grows by one block.' },
];

export async function render(container) {
  lastBlockHeight = App.state ? App.state.self.height : -1;
  container.innerHTML = `
    <div class="section-head"><h2>Mining Lab</h2>
      <span class="right muted">real SHA-256 proof-of-work on this node — no simulation</span></div>

    <div class="steps" id="steps">
      ${STEP_DEFS.map((s, i) => `
        <div class="step-card" data-step="${i}">
          <div class="n">${i + 1}</div><h4>${s.t}</h4><p>${s.p}</p>
        </div>`).join('')}
    </div>

    <div class="mine-grid" style="margin-top:16px">
      <div>
        <div class="card">
          <h3>Controls</h3>
          <button class="big-mine-btn" id="btn-auto">Start auto-mining</button>
          <div class="divider"></div>
          <div style="text-align:center">
            <div class="muted" style="font-size:12px;font-weight:500;letter-spacing:.5px">MANUAL MODE — FEEL THE LOTTERY</div>
            <button class="big-mine-btn alt" id="btn-hash" style="margin-top:8px">Try 1 nonce <span class="muted" style="font-size:11px;font-weight:500">(or press Space)</span></button>
            <div style="display:flex;gap:8px;margin-top:8px">
              <button class="btn" id="btn-x100" style="flex:1">×100</button>
              <button class="btn" id="btn-x2000" style="flex:1">×2000</button>
            </div>
          </div>
          <div class="divider"></div>
          <div class="grid cols-2" style="gap:10px">
            <div><div class="muted" style="font-size:11px;text-transform:uppercase;font-weight:700">Attempts (this template)</div><div class="gauge-num" id="g-attempts">0</div></div>
            <div><div class="muted" style="font-size:11px;text-transform:uppercase;font-weight:700">This node's speed</div><div class="gauge-num" id="g-rate">—</div></div>
            <div><div class="muted" style="font-size:11px;text-transform:uppercase;font-weight:700">Expected tries</div><div class="gauge-num" id="g-expected" style="font-size:19px">—</div></div>
            <div><div class="muted" style="font-size:11px;text-transform:uppercase;font-weight:700">Blocks found here</div><div class="gauge-num" id="g-found">0</div></div>
          </div>
          <div class="divider"></div>
          <div class="muted" style="font-size:12px">
            <b class="yellow">Why a lottery?</b> SHA-256 output is unpredictable — the only way to find a hash
            starting with <span id="lab-target" class="mono green"></span> is to try nonce after nonce. That wasted
            effort IS the security: faking history means redoing the work faster than the whole network combined.
          </div>
        </div>

        <div class="card" style="margin-top:16px">
          <h3>Race board <span class="right muted">who found the recent blocks</span></h3>
          <div id="race-board" class="feed"><div class="empty">No blocks found yet…</div></div>
        </div>
      </div>

      <div>
        <div class="card" id="template-card">
          <h3>Block header being hashed
            <span class="right"><span id="mining-status-badge"></span></span></h3>
          <div class="header-diagram" id="header-diagram"></div>
          <div class="divider"></div>
          <h3 style="font-size:13.5px">Live hash waterfall <span class="right muted">newest attempts first — green = met the target</span></h3>
          <div id="waterfall" style="max-height:300px;overflow:hidden;display:flex;flex-direction:column-reverse;gap:2px"></div>
          <div class="needle" id="needle">
            <span class="muted" style="font-size:11.5px;min-width:190px" id="needle-text">idle — press a button above</span>
            <div class="bar"><i id="needle-bar" style="width:0%"></i></div>
          </div>
        </div>

        <div class="card" style="margin-top:16px">
          <h3>Mempool → next block template <span class="right muted" id="mempool-count"></span></h3>
          <div id="mempool-list" class="feed"></div>
        </div>
      </div>
    </div>`;

  document.getElementById('btn-auto').onclick = toggleAuto;
  document.getElementById('btn-hash').onclick = () => manual(1);
  document.getElementById('btn-x100').onclick = () => manual(100);
  document.getElementById('btn-x2000').onclick = () => manual(2000);
  document.addEventListener('keydown', keyHandler);

  const paint = (s) => { if (s) paintGlobal(s); };
  if (App.state) paint(App.state);
  offLive = App.on(paint);
  fastTimer = setInterval(pollMine, 280);
  await pollMine();
}

function keyHandler(e) {
  if (location.hash.slice(1) !== '/mine') return;
  if (e.code === 'Space' && !e.target.matches('input,textarea')) {
    e.preventDefault();
    manual(1);
  }
}

async function toggleAuto() {
  const btn = document.getElementById('btn-auto');
  const starting = !btn.classList.contains('stop');
  try {
    await api.mine(starting ? 'start' : 'stop');
    btn.classList.toggle('stop', starting);
    btn.textContent = starting ? 'Stop mining' : 'Start auto-mining';
    toast(starting ? 'Auto-mining started — the lottery is running' : 'Mining stopped', 'mine');
  } catch (e) { toast(e.message, 'err'); }
}

async function manual(attempts) {
  const btn = document.getElementById('btn-hash');
  btn.disabled = true;
  try {
    const r = await api.mine('step', attempts);
    if (r.blocked) { toast(r.blocked, 'err'); return; }
    if (r.found && r.found_block) {
      toast(`Block found: #${r.found_block.height} — nonce ${fmtNum(r.found_block.nonce)} · +${fmtAmount(r.found_block.reward)} ${COIN}`, 'mine');
      document.getElementById('template-card')?.classList.add('flash-win');
      setTimeout(() => document.getElementById('template-card')?.classList.remove('flash-win'), 1300);
    }
  } catch (e) { toast(e.message, 'err'); }
  finally { btn.disabled = false; }
}

let lastRecentKey = '';

async function pollMine() {
  if (document.hidden) return; // phone battery first
  let m;
  try { m = await api.mineStatus(); } catch (e) { return; }
  const s = App.state;

  // status badge
  const sb = document.getElementById('mining-status-badge');
  if (sb) {
    if (m.mode === 'auto') sb.innerHTML = badge('AUTO-MINING', 'green');
    else if (m.mode === 'manual') sb.innerHTML = badge('MANUAL MODE', 'yellow');
    else sb.innerHTML = badge('IDLE', 'gray');
  }

  // gauges
  document.getElementById('g-attempts').textContent = fmtNum(m.attempts);
  document.getElementById('g-rate').textContent = fmtRate(m.hashrate);
  document.getElementById('g-expected').textContent = '≈ ' + fmtNum(m.expected_attempts);
  document.getElementById('g-found').textContent = fmtNum(m.blocks_found);
  document.getElementById('lab-target').textContent = '"' + '0'.repeat(m.bits) + '"';

  // auto button state sync (if mining started on another tab)
  const btn = document.getElementById('btn-auto');
  const isAuto = m.mode === 'auto';
  if (btn) {
    btn.classList.toggle('stop', isAuto);
    btn.textContent = isAuto ? 'Stop mining' : 'Start auto-mining';
  }
  // manual controls lock while the machine is mining on its own
  ['btn-hash', 'btn-x100', 'btn-x2000'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.disabled = isAuto;
  });

  // header diagram
  const hd = document.getElementById('header-diagram');
  if (m.template) {
    const t = m.template;
    hd.innerHTML = `
      <div class="row"><span class="lab">index</span><span class="val"><b>#${t.index}</b></span></div>
      <div class="row"><span class="lab">prev_hash</span><span class="val">${esc(shortHash(t.prev_hash, 14, 10))}</span></div>
      <div class="row"><span class="lab">merkle_root</span><span class="val">${esc(shortHash(t.merkle_root, 14, 10))} <span class="muted">(${t.tx_count} txs committed)</span></span></div>
      <div class="row"><span class="lab">timestamp</span><span class="val">${new Date(t.timestamp * 1000).toLocaleTimeString('en-GB')}</span></div>
      <div class="row"><span class="lab">bits (target)</span><span class="val"><span class="hl">${t.bits} leading zeros</span> — hash must start <span class="mono green">${'0'.repeat(t.bits)}</span></span></div>
      <div class="row"><span class="lab">nonce</span><span class="val"><span class="hl">${fmtNum(m.attempts)}</span> <span class="muted">← the only number being changed</span></span></div>
      <div class="row"><span class="lab">miner</span><span class="val">${esc(t.miner)} <span class="muted">(coinbase reward +10 ${COIN})</span></span></div>`;
  } else {
    hd.innerHTML = `<div class="empty">No template yet — press “TRY 1 NONCE” or start auto-mining.<br>
      <span class="muted">Requires at least one wallet on this node (the coinbase needs a payee).</span></div>`;
  }

  // waterfall
  const wf = document.getElementById('waterfall');
  const key = m.recent.map(r => r.nonce).join(',');
  if (key !== lastRecentKey) {
    lastRecentKey = key;
    const bits = m.bits;
    wf.innerHTML = m.recent.map(r => {
      const zeros = (r.hash.match(/^0+/) || [''])[0];
      const zCount = zeros.length;
      const close = zCount >= bits - 1 && zCount < bits;
      return `<div class="hash-line ${r.ok ? 'win' : ''}">
        <span class="nonce">#${fmtNum(r.nonce)}</span>
        <span class="h">${zCount ? `<span class="zero">${zeros}</span>` : ''}<span class="rest">${esc(r.hash.slice(zCount, zCount + 34))}…</span>
        ${close ? ' <span class="yellow" style="font-size:10.5px;font-weight:600">SO CLOSE</span>' : ''}
        ${r.ok ? ` <span class="green" style="font-size:10.5px;font-weight:600">VALID BLOCK</span>` : ''}</span>
      </div>`;
    }).join('');
    const near = m.recent.reduce((best, r) => Math.max(best, (r.hash.match(/^0+/) || [''])[0].length), 0);
    document.getElementById('needle-text').textContent =
      `best streak this batch: ${near} zero${near === 1 ? '' : 's'} (need ${m.bits})`;
    document.getElementById('needle-bar').style.width = `${Math.min(100, (near / Math.max(1, m.bits)) * 100)}%`;
  }

  // steps highlight
  const stepIdx = m.mode === 'idle' ? -1
    : m.template ? (m.recent.length && m.recent[0].ok ? 5 : 3) : 0;
  document.querySelectorAll('.step-card').forEach((c, i) => {
    c.classList.toggle('active', i === stepIdx);
    c.classList.toggle('done', i < stepIdx);
  });

  // race board — recent blocks by all miners (from global state)
  const rb = document.getElementById('race-board');
  if (rb && s) {
    const recentBlocks = s.latest_blocks.slice(0, 6);
    rb.innerHTML = recentBlocks.length ? recentBlocks.map(b => `
      <div class="feed-item">
        <span class="t">${timeAgo(b.ts)}</span>
        <span class="k block">WIN</span>
        <span style="flex:1">${nodeChip(b.miner)} <b>${esc(b.miner)}</b> found #${b.height}
          <span class="muted">(nonce ${fmtNum(b.nonce)}, ${b.bits} zeros)</span></span>
        <a class="mono muted" href="#/block/${b.height}">view</a>
      </div>`).join('') : empty('No blocks yet…');
  }

  // mempool list
  const ml = document.getElementById('mempool-list');
  const mc = document.getElementById('mempool-count');
  if (ml && s) {
    mc.textContent = `${s.stats.mempool} waiting`;
    ml.innerHTML = s.mempool_preview.length ? s.mempool_preview.map(t => `
      <div class="feed-item">
        <span class="t">${timeAgo(t.timestamp)}</span>
        <span class="k tx">TX</span>
        <span style="flex:1">${esc(t.from_name || '?')} → ${esc(t.to_name || shortHash(t.to_addr, 8, 6))} <b>${fmtAmount(t.amount)}</b></span>
      </div>`).join('') : empty('Nothing waiting — the next block will just be the coinbase reward.');
  }

  // toast when a new block appears globally
  if (s && lastBlockHeight >= 0 && s.self.height > lastBlockHeight) {
    const top = s.latest_blocks[0];
    if (top) toast(`Block #${top.height} accepted — mined by ${top.miner} (nonce ${fmtNum(top.nonce)})`, 'mine');
  }
  if (s) lastBlockHeight = s.self.height;
}

function paintGlobal(s) { /* reserved for heavier global paints */ }

export function destroy() {
  if (offLive) { offLive(); offLive = null; }
  if (fastTimer) { clearInterval(fastTimer); fastTimer = null; }
  document.removeEventListener('keydown', keyHandler);
}
