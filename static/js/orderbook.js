// PATHchain — order book ladder + trade prints (DOM diffing, 60fps-safe).
// Sizes animate via transform scaleX on a background bar (never layout);
// changed/new levels get a one-shot flash class so eyes catch the delta.

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

const fmtP = (p) => '$' + Number(p).toFixed(4);
const fmtS = (s) => {
  s = Number(s);
  if (s >= 1e6) return (s / 1e6).toFixed(2) + 'M';
  if (s >= 1e3) return (s / 1e3).toFixed(1) + 'K';
  return s.toFixed(1);
};

// depth: {bids: [[p, s]…best-first], asks: [[p, s]…best-first]}
export function renderBook(container, depth, prevRef = {}) {
  if (!container || !depth) return;
  const maxLevel = Math.max(
    1, ...depth.bids.map(l => l[1]), ...depth.asks.map(l => l[1]));

  const paintSide = (sideEl, levels, kind, reverse) => {
    if (!sideEl) return;
    // cumulative totals accumulate from the BEST price outward; on the ask
    // side the ladder is drawn reversed so the best ask sits next to the mid
    let cum = 0;
    const withCum = levels.map(([p, s]) => { cum += s; return [p, s, cum]; });
    const display = reverse ? [...withCum].reverse() : withCum;
    const rows = sideEl.querySelectorAll('.ob-row');
    display.forEach(([p, s, c], i) => {
      let row = rows[i];
      if (!row) {
        row = el(`<div class="ob-row"><i class="ob-bar"></i><span class="p"></span><span class="s"></span><span class="csum"></span></div>`);
        sideEl.appendChild(row);
      }
      const pEl = row.querySelector('.p'), sEl = row.querySelector('.s'), cEl = row.querySelector('.csum');
      const prevS = prevRef[kind + ':' + p];
      if (prevS === undefined) {
        row.classList.remove('lvl-chg'); void row.offsetWidth; row.classList.add('lvl-new');
      } else if (Math.abs(prevS - s) > 1e-6) {
        row.classList.remove('lvl-new'); void row.offsetWidth; row.classList.add('lvl-chg');
      }
      if (pEl.textContent !== fmtP(p)) pEl.textContent = fmtP(p);
      if (sEl.textContent !== fmtS(s)) sEl.textContent = fmtS(s);
      if (cEl.textContent !== fmtS(c)) cEl.textContent = fmtS(c);
      row.style.setProperty('--w', (Math.sqrt(s / maxLevel)).toFixed(3));
    });
    for (let i = display.length; i < rows.length; i++) rows[i].remove();
  };

  paintSide(container.querySelector('.ob-side.bids'), depth.bids, 'b', false);
  paintSide(container.querySelector('.ob-side.asks'), depth.asks, 'a', true);

  // remember sizes for next-frame diffing
  for (const [p, s] of depth.bids) prevRef['b:' + p] = s;
  for (const [p, s] of depth.asks) prevRef['a:' + p] = s;
}

// trades: newest-first [{t, side, price, size, venue}…]
export function renderTrades(container, trades, prevTopId = 0) {
  if (!container || !trades) return { topId: prevTopId };
  const top = trades[0];
  if (!top || top.id === prevTopId) return { topId: prevTopId };
  const frag = document.createDocumentFragment();
  for (const t of trades.slice(0, 30)) {
    if (t.id <= prevTopId) break;
    const row = el(`<div class="tr-row ${t.side === 'buy' ? 'buy' : 'sell'}">
      <span class="tp">${fmtP(t.price)}</span>
      <span class="tv">${fmtS(t.size)}</span>
      <span class="ts">${new Date(t.t * 1000).toLocaleTimeString('en-GB', { hour12: false })}</span>
    </div>`);
    frag.appendChild(row);
  }
  container.prepend(frag);
  while (container.children.length > 30) container.lastElementChild.remove();
  return { topId: top.id };
}
