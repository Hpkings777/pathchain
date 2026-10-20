// PATHchain — tiny DOM helpers + shared UI components
import { shortHash, timeAgo, fmtAmount, COIN } from './fmt.js';

export const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

export function copyable(text, display) {
  const span = el(`<span class="copyable mono" title="Click to copy">${esc(display || shortHash(text, 14, 10))}</span>`);
  span.onclick = () => {
    navigator.clipboard?.writeText(text).then(() => toast('Copied to clipboard', 'ok'));
  };
  return span;
}

export function toast(msg, kind = '') {
  const root = document.getElementById('toast-root');
  // never stack more than 4 — errors during outages would otherwise bury the screen
  while (root.children.length >= 4) root.firstElementChild.remove();
  const t = el(`<div class="toast ${kind}">${esc(msg)}</div>`);
  root.appendChild(t);
  setTimeout(() => {
    // subtle exit: shorter than enter, drifts up (design-ui motion rules)
    t.classList.add('out');
    setTimeout(() => t.remove(), 200);
  }, 4200);
}

const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

// tween a numeric display from its current value to `to` — rAF, ~450ms, ease-out.
// Skips gracefully under prefers-reduced-motion or when torn down.
export function tweenNumber(elm, to, fmt) {
  if (!elm) return;
  const from = Number(elm.dataset.raw ?? NaN);
  const text = fmt(to);
  elm.dataset.raw = String(to);
  if (reducedMotion?.matches || Number.isNaN(from) || from === to) {
    elm.textContent = text;
    return;
  }
  if (elm._tw) cancelAnimationFrame(elm._tw);
  const t0 = performance.now(), dur = 450;
  const step = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);          // cubic ease-out
    elm.textContent = fmt(from + (to - from) * eased);
    if (p < 1) elm._tw = requestAnimationFrame(step);
  };
  elm._tw = requestAnimationFrame(step);
}

// brief green/red pulse on a value element when it moves
export function flashNum(elm, dir, cls = '') {
  if (!elm || !dir) return;
  if (reducedMotion?.matches) return;
  const c = dir > 0 ? 'num-flash-up' : 'num-flash-down';
  elm.classList.remove('num-flash-up', 'num-flash-down');
  void elm.offsetWidth;                            // restart the one-shot animation
  elm.classList.add(c);
  elm.addEventListener('animationend', () => elm.classList.remove(c), { once: true });
}

export function modal(title, bodyEl) {
  const root = document.getElementById('modal-root');
  root.innerHTML = '';
  const m = el(`<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><h3>${esc(title)}</h3><div class="modal-body"></div>
    <div class="close-row"><button class="btn btn-sm" id="modal-close">Close</button></div></div>`);
  m.querySelector('.modal-body').appendChild(bodyEl);
  root.appendChild(m);
  root.classList.add('open');
  const close = () => {
    root.classList.remove('open');
    root.innerHTML = '';
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  root.onclick = (e) => { if (e.target === root) close(); };
  m.querySelector('#modal-close').onclick = close;
  setTimeout(() => m.querySelector('#modal-close').focus(), 30);
  return close;
}

export function confirmBar(confirmations) {
  const total = Math.max(6, Math.min(confirmations, 30));
  const shown = Math.min(confirmations, 6);
  let bars = '';
  for (let i = 0; i < shown; i++) bars += `<i></i>`;
  if (confirmations > 6) bars += `<i class="dim" style="flex:0.6"></i><i class="dim" style="flex:0.3"></i><i class="dim" style="flex:0.15"></i>`;
  return `<div class="confirm-bar" title="${confirmations} confirmation(s)">${bars}</div>`;
}

export function badge(text, color) {
  return `<span class="badge ${color}">${esc(text)}</span>`;
}

export function amountCell(amount, cls = '') {
  return `<span class="amt ${cls}">${fmtAmount(amount)} <span class="unit">${COIN}</span></span>`;
}

export function nodeChip(name, color) {
  const initials = (name || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase();
  return `<span class="avatar chip" title="${esc(name || '')}">${esc(initials)}</span>`;
}

export function empty(msg) {
  return `<div class="empty">${esc(msg)}</div>`;
}

export function spinner(label = 'Loading live network data…') {
  return `<div class="empty">${esc(label)}</div>`;
}

export function skeletonRows(n = 4) {
  let out = '';
  for (let i = 0; i < n; i++) {
    out += `<div class="skel-row"><div class="skel" style="width:22%"></div><div class="skel grow"></div><div class="skel" style="width:16%"></div></div>`;
  }
  return out;
}

// renders a tx row for "latest transactions" tables
export function txRow(tx, tipHeight) {
  const isCoin = tx.type === 'COINBASE';
  const from = isCoin ? 'NETWORK (newly issued)' : (tx.from_name || shortHash(tx.from_addr, 8, 6));
  const to = tx.to_name || shortHash(tx.to_addr, 8, 6);
  const conf = tx.height === null || tx.height === undefined ? null
    : (tipHeight !== undefined && tipHeight !== null ? tipHeight - tx.height + 1 : null);
  const statusBadge = conf === null
    ? badge('MEMPOOL', 'yellow')
    : (conf >= 1 ? badge(`${conf} conf${conf === 1 ? '' : 's'}`, 'green') : '');
  return `<tr>
    <td><a class="mono" href="#/tx/${esc(tx.txid)}">${esc(shortHash(tx.txid, 10, 8))}</a></td>
    <td>${esc(from)} <span class="io-arrow">→</span> ${esc(to)}</td>
    <td class="num">${amountCell(tx.amount, isCoin ? 'pos' : '')}</td>
    <td>${statusBadge}</td>
  </tr>`;
}
