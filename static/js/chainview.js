// PATHchain — visual blockchain chain view.
// Renders the chain as a horizontal (wrapping) flowchart of block cards
// connected by animated directional arrows, and orchestrates the tamper
// theatre: shake → flicker → downstream warning pulse → red dashed links →
// consensus overlay with peer rejection stamps → restore animation.
import { api, App } from './api.js';
import { el, esc, openSidePanel, toast, confirmDanger } from './ui.js';
import { fmtNum, timeAgo, shortHash, fmtTime, COIN } from './fmt.js';

const ARROW = `<svg width="44" height="14" viewBox="0 0 44 14" aria-hidden="true">
  <path class="arrow-path" d="M1 7 H33"></path>
  <polygon class="arrow-head" points="33,2.8 42,7 33,11.2"></polygon>
</svg>`;

const CHECK_SVG = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5 10-11"/></svg>`;

export function blockCard(b, i, opts = {}) {
  const transfers = Math.max(0, b.txs - 1);
  const genesis = b.height === 0;
  const card = el(`<article class="chain-node ${genesis ? 'cn-genesis' : ''}" style="--i:${i}" data-height="${b.height}" tabindex="0" role="button" aria-label="Block ${b.height} — open details">
    <div class="cn-head">
      <span class="cn-height">#${b.height}</span>
      <span class="cn-bits">${genesis ? 'GENESIS' : b.bits + ' zeros'}</span>
    </div>
    <div class="cn-hash" title="Block hash — click the card for the full header">prev <b>${esc(shortHash(b.prev_hash || ('0'.repeat(64)), 8, 6))}</b><br>hash <b data-role="hash">${esc(shortHash(b.hash, 12, 10))}</b></div>
    <div class="cn-meta">
      <span class="k">nonce</span><span class="v" data-role="nonce">${fmtNum(b.nonce)}</span>
      <span class="k">txs</span><span class="v">${transfers}${genesis ? '' : ' +1 cb'}</span>
      <span class="k">mined by</span><span class="v" title="${esc(b.miner || '')}">${esc((b.miner || '—').slice(0, 14))}</span>
      <span class="k">age</span><span class="v">${timeAgo(b.ts)}</span>
    </div>
    <div class="cn-ok">${CHECK_SVG} valid · PoW verified</div>
  </article>`);
  return card;
}

export function linkEl(i, bad = false) {
  const l = el(`<span class="cn-link ${bad ? 'bad' : ''}" style="--i:${i}" aria-hidden="true">${ARROW}</span>`);
  return l;
}

// Mark cards/links in place from the node's live validation state — no
// re-render, so the running animations are never interrupted.
export function applyIntegrity(flow, badIndex) {
  const cards = flow.querySelectorAll('.chain-node');
  cards.forEach((card) => {
    const h = Number(card.dataset.height);
    const link = card.nextElementSibling && card.nextElementSibling.classList.contains('cn-link')
      ? card.nextElementSibling : null;
    const isTampered = badIndex !== null && h === badIndex;
    const isDownstream = badIndex !== null && h > badIndex;
    card.classList.toggle('is-tampered', isTampered);
    card.classList.toggle('is-downstream', isDownstream);
    if (link) link.classList.toggle('bad', badIndex !== null && h >= badIndex);
    const ok = card.querySelector('.cn-ok');
    const badgeExists = card.querySelector('.integrity-badge');
    if (isDownstream && !badgeExists) {
      ok.style.display = 'none';
      card.insertAdjacentHTML('beforeend',
        `<div class="integrity-badge">⚠ Integrity broken</div>`);
    } else if (!isDownstream && badgeExists) {
      badgeExists.remove();
      ok.style.display = '';
    }
    if (isTampered) {
      const okLine = card.querySelector('.cn-ok');
      if (okLine) okLine.innerHTML = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg> <span style="color:var(--red)">hash mismatch — data was edited</span>`;
    }
  });
}

// One-shot theatre when a block freshly becomes tampered: shake + hash flicker.
export function playTamperTheatre(flow, badIndex) {
  const card = flow.querySelector(`.chain-node[data-height="${badIndex}"]`);
  if (!card) return;
  card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
  const hash = card.querySelector('[data-role="hash"]');
  if (hash) {
    hash.classList.remove('flicker'); void hash.offsetWidth; hash.classList.add('flicker');
    setTimeout(() => hash.classList.remove('flicker'), 1800);
  }
}

// Restore: brief reverse animation on every card (used after rollback).
export function playRestore(flow) {
  flow.querySelectorAll('.chain-node').forEach((c, i) => {
    c.classList.remove('is-restored', 'is-tampered', 'is-downstream');
    void c.offsetWidth;
    c.style.animationDelay = `${Math.min(i * 30, 400)}ms`;
    c.classList.add('is-restored');
    const ok = c.querySelector('.cn-ok');
    if (ok) { ok.style.display = ''; ok.innerHTML = `${CHECK_SVG} valid · PoW verified`; }
    const badge = c.querySelector('.integrity-badge');
    if (badge) badge.remove();
  });
  flow.querySelectorAll('.cn-link.bad').forEach(l => l.classList.remove('bad'));
}

// ---------------------------------------------------------------- panel -----
export async function openBlockPanel(height, ctx = {}) {
  let b;
  try { b = await api.block(height); }
  catch (e) { toast(e.message, 'err'); return; }
  const bad = b.chain_valid === false;   // covers header edits AND tx edits (signatures)
  const wrap = el(`<div></div>`);
  wrap.innerHTML = `
    <div class="sp-section">
      <div class="sp-kv">
        <span class="k">Height</span><span class="v">#${b.index}</span>
        <span class="k">Mined by</span><span class="v">${esc(b.miner || '—')}</span>
        <span class="k">Time</span><span class="v">${esc(fmtTime(b.timestamp))}</span>
        <span class="k">Nonce</span><span class="v">${fmtNum(b.nonce)}</span>
        <span class="k">Difficulty</span><span class="v">${b.bits} leading zeros</span>
        <span class="k">Size</span><span class="v">${fmtNum(b.size)} bytes</span>
        <span class="k">Confirmations</span><span class="v">${b.confirmations}</span>
      </div>
    </div>
    <div class="sp-section"><h4>Hash linkage</h4>
      <div class="sp-hash-box ${b.header_hash_valid === false ? 'mismatch' : ''}"><span class="lbl">prev_hash</span>${esc(b.prev_hash || '0'.repeat(64))}</div>
      <div style="height:8px"></div>
      <div class="sp-hash-box ${b.header_hash_valid === false ? 'mismatch' : ''}"><span class="lbl">hash (stored in block)</span>${esc(b.hash)}</div>
      ${b.header_hash_valid === false ? `<div style="height:8px"></div>
      <div class="sp-hash-box mismatch"><span class="lbl">hash (recomputed from the stored header — MISMATCH)</span>${esc(b.recomputed_hash || '—')}</div>` : ''}
      ${bad ? `<p class="red" style="font-size:12px;margin-top:8px"><b>This block fails the node's own validation${b.invalid_reason ? `: ${esc(b.invalid_reason)}` : ''}.</b> The stored data was edited after mining — every honest node rejects it on sight.</p>` : ''}
    </div>
    <div class="sp-section"><h4>Merkle root</h4>
      <div class="sp-hash-box">${esc(b.merkle_root || '—')}</div>
    </div>
    <div class="sp-section"><h4>Transactions (${(b.txs || []).length})</h4>
      ${(b.txs || []).map(tx => `
        <div class="sp-tx-row">
          <span><a class="mono" href="#/tx/${esc(tx.txid)}" data-close-panel>${esc(shortHash(tx.txid, 10, 8))}</a><br>
          <span class="muted" style="font-size:11px">${tx.type === 'COINBASE' ? 'mining reward' : esc(tx.from_name || shortHash(tx.from_addr || '', 6, 4))} → ${esc(tx.to_name || shortHash(tx.to_addr || '', 6, 4))}</span></span>
          <span class="amt ${tx.type === 'COINBASE' ? 'pos' : ''}">${fmtNum(tx.amount)} <span class="unit">${COIN}</span></span>
        </div>`).join('') || '<div class="muted" style="font-size:12px">none</div>'}
    </div>
    <div class="sp-section">
      ${b.index === 0 ? `<p class="muted" style="font-size:12px">The genesis block is the root of trust — it cannot be tampered with in this demo.</p>`
      : `<button class="btn btn-red btn-wide" id="sp-tamper">⚠ Edit this block's data (tamper demo)</button>
         <p class="muted" style="font-size:11.5px;margin-top:8px">Editing ANY stored byte breaks the hash. The network detects it instantly and votes on a rollback.</p>`}
    </div>`;
  const close = openSidePanel(`Block #${b.index}`, wrap);
  wrap.querySelectorAll('[data-close-panel]').forEach(a => a.addEventListener('click', () => close()));
  const tamperBtn = wrap.querySelector('#sp-tamper');
  if (tamperBtn) {
    tamperBtn.onclick = async () => {
      const ok = await confirmDanger({
        title: `Tamper with block #${b.index}?`,
        body: `This rewrites a transaction inside block #${b.index} — exactly what a hacker would do. The hash breaks, every peer sees the damage, and the network votes on a rollback.`,
        confirmLabel: 'Tamper — I understand',
      });
      if (!ok) return;
      try {
        const r = await api.tamper(`manual edit of block #${b.index}`, b.index);
        toast(r.message, 'err');
        if (ctx.onTampered) ctx.onTampered(b.index);
      } catch (e) { toast(e.message, 'err'); }
    };
  }
}

// ----------------------------------------------------- vote overlay ---------
// Global: renders into #vote-overlay-root whenever a tamper vote is open,
// stamps ❌ on every peer that rejects the tampered block, and shows the
// final verdict. One overlay at a time; latest poll wins.
export function wireVoteOverlay() {
  const root = document.getElementById('vote-overlay-root');
  if (!root) return;
  let current = null;      // hack_id being displayed
  let peers = [];          // [{node_id, name}]
  let stamped = new Set();
  let autoCloseTimer = null;
  const dismissed = new Set();   // hack_ids the user has already seen close

  const closeOverlay = () => {
    if (current) dismissed.add(current);
    root.innerHTML = '';
    current = null;
    stamped = new Set();
    clearTimeout(autoCloseTimer);
    autoCloseTimer = null;
  };

  const render = async (s) => {
    const poll = s.poll;
    if (!poll || !poll.hack_id || dismissed.has(poll.hack_id)) {
      if (root.childElementCount) closeOverlay();
      return;
    }
    // a poll that closed before we ever showed it — do not surface stale votes
    if (poll.closed && current !== poll.hack_id) {
      dismissed.add(poll.hack_id);
      return;
    }
    if (current !== poll.hack_id) {
      current = poll.hack_id;
      stamped = new Set(Object.keys(poll.votes || {}));
      try {
        const pr = await api.peers();
        peers = [
          { node_id: s.node_id, name: s.self.name + ' (you)' },
          ...(pr.connected || []).filter(p => p.node_id),
        ];
      } catch (e) { peers = [{ node_id: s.node_id, name: s.self.name + ' (you)' }]; }
    }
    const votedIds = new Set(Object.keys(poll.votes || {}));
    const shown = peers.slice(0, 10);
    root.innerHTML = `
      <div class="vote-overlay" role="alertdialog" aria-label="Consensus vote in progress">
        <div class="vo-head">
          <span class="vo-siren"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 3 2.6 20h18.8z"/><path d="M12 10v4.4"/><circle cx="12" cy="17.2" r="0.4" fill="currentColor"/></svg></span>
          <h3>Network under attack</h3>
        </div>
        <div class="vo-sub"><b class="red">${esc(poll.hacker || 'A peer')}</b> tampered with block #${poll.compromised_from} — ${esc(poll.note || 'block data was edited')}. ${poll.hidden ? 'This node started the tamper, so it coordinates the tally; every other peer votes.' : 'Connected peers are voting to reject the tampered history.'}</div>
        <div class="vote-peers">
          ${shown.map(p => {
            const voted = votedIds.has(String(p.node_id));
            return `<div class="vote-peer ${voted ? 'stamped' : ''}" data-nid="${esc(String(p.node_id))}">
              <span class="avatar chip">${esc((p.name || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase())}</span>
              <span class="stamp">✕</span>
              <span class="vp-name">${esc(p.name || 'peer')}</span>
            </div>`;
          }).join('')}
        </div>
        <div class="vote-track"><div class="yes" style="flex:${Math.max(poll.yes || 0, 0.001)}"></div><div class="no" style="flex:${Math.max(poll.no || 0, 0.001)}"></div></div>
        <div style="display:flex;justify-content:space-between;font-size:11.5px;margin-top:6px">
          <span><b class="green">${poll.yes || 0}</b> reject tamper</span>
          <span class="muted">needs ${poll.required || '?'} votes</span>
          <span><b class="red">${poll.no || 0}</b> keep</span>
        </div>
        <div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end">
          <a class="btn btn-sm" href="#/network">Open consensus panel</a>
          <a class="btn btn-sm" href="#/chain">See the chain</a>
        </div>
      </div>`;
    // animate stamps that appeared since the last paint
    root.querySelectorAll('.vote-peer').forEach((n) => {
      const nid = n.dataset.nid;
      if (votedIds.has(nid) && !stamped.has(nid)) {
        stamped.add(nid);
        n.classList.add('stamped');
      }
    });
    if (poll.closed) {
      const banner = poll.approved ? 'TAMPER REJECTED — CHAIN RESTORED' : 'VOTE REJECTED — CHAIN STAYS FLAGGED';
      const color = poll.approved ? 'var(--green)' : 'var(--red)';
      const head = root.querySelector('.vote-overlay h3');
      if (head) { head.textContent = banner; head.style.color = color; }
      if (!autoCloseTimer) autoCloseTimer = setTimeout(closeOverlay, 4200);
    } else {
      clearTimeout(autoCloseTimer);
      autoCloseTimer = null;
    }
  };

  App.on(render);
}
