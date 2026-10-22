// PATHchain — guided tour: a 60-second walkthrough of the network.
// Pure vanilla: spotlight (box-shadow cutout) + popover card, path-aware steps,
// keyboard navigation, respects prefers-reduced-motion. No dependencies.

import { navigate } from './app.js';
import { esc } from './ui.js';

const DONE_KEY = 'pathchain_tour_done_v2';

const STEPS = [
  {
    path: '/', sel: '.tape',
    title: 'A living ticker tape',
    body: 'PATH/USD is priced by a real bot economy running on this node: trades stream through an actual order book and the tape scrolls every print. BTC and ETH below come from a public market API when the internet is reachable.',
  },
  {
    path: '/', sel: '#stat-row',
    title: 'Everything here is real',
    body: 'Block height, hashrate, difficulty, peers — computed from this node\'s live chain. Zero mock data anywhere in this explorer.',
  },
  {
    path: '/', sel: '#latest-blocks',
    title: 'Blocks confirm transactions',
    body: 'Every ~15 seconds miners (human and bot) pack pending transfers into a new block. The green bars show how many blocks confirm each one — just like a real explorer.',
  },
  {
    path: '/chain', sel: '#chainflow',
    title: 'The chain, as a living flowchart',
    body: 'Each block commits to the hash of the one before it — that is the whole trick. New blocks slide in as they are mined. Click any card to open its full header, Merkle root and transactions.',
  },
  {
    path: '/chain', sel: '.chain-node',
    title: 'The tamper theatre',
    body: 'Open a block and press “Edit this block’s data”. The card shakes, its hash flickers to the mismatched value, every downstream block flags “integrity broken”, and the network votes on a rollback — consensus you can watch.',
  },
  {
    path: '/mine', sel: '.big-mine-btn',
    title: 'Try it yourself',
    body: 'Hash one nonce at a time in front of your audience, or switch on auto-mining and watch the waterfall race. This is the exact process that secures Bitcoin.',
  },
  {
    path: '/wallet', sel: '.wallet-grid',
    title: 'Wallets with real cryptography',
    body: 'Each wallet is a real secp256k1 keypair — the same curve as Bitcoin. Note the private key stays masked behind a Reveal button: in a real wallet, whoever sees that string owns the coins.',
  },
  {
    path: '/market', sel: '#mkt-price',
    title: 'How the PATH price is made',
    body: 'Traders size orders from mean-reversion + momentum, market makers quote both sides and widen spreads on volatility, arbitrageurs close the gap between the DEX and Secondary books. Every candle comes from their printed trades — a transparent simulation, honestly labelled.',
  },
  {
    path: '/settings', sel: '.regime-grid',
    title: 'You are the market controller',
    body: 'Set the market regime — bullish, bearish, volatile, even a crash or a pump — tune the bot population and mix, and watch the whole economy react on every screen in the room.',
  },
  {
    path: '/network', sel: '#btn-tamper',
    title: 'Break it on purpose',
    body: 'Press this to corrupt the newest block. Every node turns red, votes, and the majority rolls the chain back — Proof-of-Work + consensus, live on your LAN.',
  },
];

let layer = null, spot = null, card = null, idx = 0, active = false;
let onKeyBound = null, resizeBound = null;

function reduced() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
}

function build() {
  if (layer) return;
  layer = document.createElement('div');
  layer.className = 'tour-layer';
  spot = document.createElement('div');
  spot.className = 'tour-spot';
  card = document.createElement('div');
  card.className = 'tour-card';
  layer.appendChild(spot);
  document.body.appendChild(layer);
  document.body.appendChild(card);
  resizeBound = () => place(idx, true);
  window.addEventListener('resize', resizeBound);
  window.addEventListener('scroll', resizeBound, true);
}

function teardown() {
  layer?.remove(); card?.remove();
  layer = spot = card = null;
  active = false;
  if (onKeyBound) document.removeEventListener('keydown', onKeyBound);
  if (resizeBound) {
    window.removeEventListener('resize', resizeBound);
    window.removeEventListener('scroll', resizeBound, true);
    resizeBound = null;
  }
}

function findTarget(step) {
  if (!step) return null;
  const root = document.getElementById('app');
  const t = root?.querySelector(step.sel) || document.querySelector(step.sel) || null;
  if (!t) return null;
  // elements still hidden (e.g. the tape before the first market frame) have
  // no box to spotlight — treat them as missing so the step skips gracefully
  if (!t.offsetParent && getComputedStyle(t).position !== 'fixed') return null;
  return t;
}

async function goToStep(i) {
  idx = Math.max(0, Math.min(STEPS.length - 1, i));
  const step = STEPS[idx];
  // navigate if the target lives on another page, then wait for it to render
  const raw = (location.hash || '#/').slice(1).split('?')[0];
  const path = '/' + (raw.split('/').filter(Boolean)[0] || '');
  if (path !== step.path) {
    navigate(step.path);
    const ok = await waitFor(() => findTarget(step), 1600);
    if (!ok) { next(); return; }         // target missing (e.g. no blocks yet) — skip
  } else {
    const ok = await waitFor(() => findTarget(step), 900);
    if (!ok) { next(); return; }
  }
  place(idx);
}

function waitFor(fn, timeout) {
  return new Promise((res) => {
    const t0 = performance.now();
    const tick = () => {
      const v = fn();
      if (v) return res(v);
      if (performance.now() - t0 > timeout) return res(null);
      setTimeout(tick, 90);
    };
    tick();
  });
}

function place() {
  const step = STEPS[idx];
  const target = findTarget(step);
  if (!target) return;
  target.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
  // measure after the scroll settles
  setTimeout(() => {
    const r = target.getBoundingClientRect();
    const pad = 8;
    spot.style.top = `${r.top - pad}px`;
    spot.style.left = `${r.left - pad}px`;
    spot.style.width = `${r.width + pad * 2}px`;
    spot.style.height = `${r.height + pad * 2}px`;
    spot.style.borderRadius = '14px';
    // position the card below the target; flip above if there is no room
    const cardH = 210, cardW = Math.min(340, window.innerWidth - 28);
    let top = r.bottom + 14;
    if (top + cardH > window.innerHeight - 12) top = Math.max(12, r.top - cardH - 14);
    let left = r.left + r.width / 2 - cardW / 2;
    left = Math.max(14, Math.min(left, window.innerWidth - cardW - 14));
    card.style.top = `${top}px`;
    card.style.left = `${left}px`;
    renderCard();
  }, reduced() ? 0 : 230);
}

function renderCard() {
  const step = STEPS[idx];
  card.innerHTML = `
    <div class="tour-step-n">Step ${idx + 1} of ${STEPS.length}</div>
    <h4>${esc(step.title)}</h4>
    <p>${esc(step.body)}</p>
    <div class="tour-row">
      <span class="tour-count">${idx + 1}/${STEPS.length}</span>
      <button class="tour-quit" id="tour-quit">End tour</button>
      ${idx > 0 ? '<button class="btn btn-sm" id="tour-back">Back</button>' : ''}
      <button class="btn btn-sm btn-primary" id="tour-next">${idx === STEPS.length - 1 ? 'Finish' : 'Next'}</button>
    </div>
    <div class="tour-progress"><i style="width:${((idx + 1) / STEPS.length) * 100}%"></i></div>`;
  card.querySelector('#tour-next').onclick = () => (idx === STEPS.length - 1 ? end() : goToStep(idx + 1));
  card.querySelector('#tour-back')?.addEventListener('click', () => goToStep(idx - 1));
  card.querySelector('#tour-quit').onclick = end;
}

function next() { if (idx < STEPS.length - 1) goToStep(idx + 1); else end(); }

function end() {
  teardown();
  try { localStorage.setItem(DONE_KEY, '1'); } catch (_) { /* private mode */ }
}

onKeyBound = null;
function bindKeys() {
  onKeyBound = (e) => {
    if (!active) return;
    if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); goToStep(idx - 1); }
    else if (e.key === 'Escape') end();
  };
  document.addEventListener('keydown', onKeyBound);
}

export function startTour() {
  build();
  active = true;
  bindKeys();
  goToStep(0);
}

// first-visit nudge — a small card, never a modal blocking the page
export function maybeWelcome() {
  let seen = false;
  try { seen = !!localStorage.getItem(DONE_KEY); } catch (_) { /* private mode */ }
  if (seen) return;
  try { localStorage.setItem(DONE_KEY, '1'); } catch (_) { /* ignore */ }
  const w = document.createElement('div');
  w.className = 'welcome-card';
  w.innerHTML = `
    <h4>Welcome to PATHchain</h4>
    <p>A live proof-of-work blockchain running on this network — real mining, real signatures, real consensus.
       New here? Take the 60-second tour.</p>
    <div class="tour-row">
      <button class="btn btn-sm btn-ghost" id="w-later">Explore on my own</button>
      <button class="btn btn-sm btn-primary" id="w-start">Start the tour</button>
    </div>`;
  document.body.appendChild(w);
  w.querySelector('#w-start').onclick = () => { w.remove(); startTour(); };
  w.querySelector('#w-later').onclick = () => w.remove();
  setTimeout(() => w.remove(), 30000);   // auto-dismiss so it never lingers
}
