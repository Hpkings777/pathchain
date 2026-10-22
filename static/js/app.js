// PATHchain — hash router + nav wiring (top nav + mobile bottom tabs)
import { App, api } from './api.js';
import { toast, esc } from './ui.js';
import { startTour, maybeWelcome } from './tour.js';
import { wireVoteOverlay } from './chainview.js';
import * as home from './pages/home.js';
import * as market from './pages/market.js';
import * as chain from './pages/chain.js';
import * as settings from './pages/settings.js';
import * as blocks from './pages/blocks.js';
import * as block from './pages/block.js';
import * as tx from './pages/tx.js';
import * as address from './pages/address.js';
import * as wallet from './pages/wallet.js';
import * as mine from './pages/mine.js';
import * as network from './pages/network.js';
import * as charts from './pages/charts.js';

const routes = {
  '/': home, '/market': market, '/chain': chain, '/settings': settings, '/blocks': blocks,
  '/block': block, '/tx': tx, '/address': address, '/wallet': wallet, '/mine': mine,
  '/network': network, '/charts': charts,
};

// tabs map a detail path to the tab that should light up
const TAB_ALIAS = { '/block': '/blocks', '/tx': '/', '/address': '/' };

let currentPage = null;
let routeSeq = 0;

export function navigate(path) { location.hash = path; }

export async function route() {
  const seq = ++routeSeq;
  const raw = (location.hash || '#/').slice(1);
  const parts = raw.split('?')[0].split('/').filter(Boolean);
  const path = '/' + (parts[0] || '');
  const arg = parts.slice(1).join('/');
  const page = routes[path] || home;

  if (currentPage && currentPage.destroy) currentPage.destroy();
  const app = document.getElementById('app');
  currentPage = page;

  const topPath = TAB_ALIAS[path] || path;
  document.querySelectorAll('[data-nav]').forEach(a => {
    a.classList.toggle('active', a.dataset.nav === topPath);
  });
  closeMobileChrome();
  window.scrollTo(0, 0);
  app.innerHTML = '';
  try {
    await page.render(app, arg);
    // staggered enter for freshly rendered top-level chunks (skipped by reduced-motion via CSS)
    app.classList.remove('page-enter');
    void app.offsetWidth;
    app.classList.add('page-enter');
  } catch (e) {
    console.error(e);
    if (seq === routeSeq) {
      app.innerHTML = `<div class="card"><div class="empty">Could not load this page: ${esc(e.message)}</div></div>`;
    }
  }
}

// ---- search (shared by top bar, home hero, and mobile overlay) ----
export async function doSearch(q) {
  q = (q || '').trim();
  if (!q) return;
  // hash/hex fields must be hex — catch typos before the round-trip
  const looksHex = /^[0-9a-fA-F]+$/.test(q) && q.length >= 12;
  if (looksHex && q.length !== 40 && q.length !== 64 && q.length !== 66) {
    toast(`That looks like a hash but hashes here are 64 hex characters (this is ${q.length})`, 'err');
    return;
  }
  try {
    const r = await api.search(q);
    if (r.type === 'block') return navigate(`/block/${r.ref}`);
    if (r.type === 'tx') return navigate(`/tx/${r.ref}`);
    if (r.type === 'address') return navigate(`/address/${r.ref}`);
    toast(`Nothing found for "${q}" on this node yet`, 'err');
  } catch (e) { toast(e.message, 'err'); }
}
window.addEventListener('path-search', (e) => doSearch(e.detail));

// ---- mobile chrome: bottom sheet ("More") + search overlay ----
function closeMobileChrome() {
  document.getElementById('more-sheet')?.classList.remove('open');
  document.getElementById('search-overlay')?.classList.remove('open');
  document.getElementById('sheet-backdrop')?.classList.remove('show');
  // modals live outside #app — close them on navigation too
  const modalRoot = document.getElementById('modal-root');
  if (modalRoot && modalRoot.classList.contains('open')) {
    modalRoot.classList.remove('open');
    modalRoot.innerHTML = '';
  }
}
function wireMobileChrome() {
  const moreBtn = document.getElementById('tab-more');
  const sheet = document.getElementById('more-sheet');
  const backdrop = document.getElementById('sheet-backdrop');
  if (moreBtn && sheet && backdrop) {
    moreBtn.onclick = () => {
      const open = sheet.classList.toggle('open');
      backdrop.classList.toggle('show', open);
    };
    backdrop.onclick = closeMobileChrome;
    sheet.querySelectorAll('a').forEach(a => a.addEventListener('click', closeMobileChrome));
  }
  const searchBtn = document.getElementById('btn-search-mobile');
  const overlay = document.getElementById('search-overlay');
  const input = document.getElementById('search-overlay-input');
  if (searchBtn && overlay && input) {
    searchBtn.onclick = () => {
      overlay.classList.add('open');
      setTimeout(() => input.focus(), 60);
    };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeMobileChrome(); });
    document.getElementById('search-overlay-cancel')?.addEventListener('click', closeMobileChrome);
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMobileChrome(); });
}

// ---- top search form ----
const topForm = document.getElementById('nav-search');
if (topForm) {
  topForm.addEventListener('submit', (e) => {
    e.preventDefault();
    doSearch(document.getElementById('nav-search-input').value);
  });
}
const overlayForm = document.getElementById('search-overlay-form');
if (overlayForm) {
  overlayForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = document.getElementById('search-overlay-input').value;
    closeMobileChrome();
    doSearch(v);
  });
}

// global safety net — one friendly toast, never a storm
let errToastShown = 0;
window.addEventListener('error', (e) => {
  if (Date.now() - errToastShown > 8000) {
    errToastShown = Date.now();
    toast('Something went wrong — the page kept running. Check the console for details.', 'err');
  }
});

wireMobileChrome();
window.addEventListener('hashchange', route);

// consensus vote overlay — global, event-driven from the live state
wireVoteOverlay();

// guided tour entry points (nav button + first-visit welcome card)
document.getElementById('btn-tour')?.addEventListener('click', startTour);
document.getElementById('sheet-tour')?.addEventListener('click', (e) => {
  e.preventDefault();
  closeMobileChrome();
  startTour();
});

App.start();
route();
// offer the tour once the first page has painted
setTimeout(maybeWelcome, 1200);
