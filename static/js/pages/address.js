// PATHchain — address detail
import { App, api } from '../api.js';
import { el, esc, empty, badge, copyable, txRow } from '../ui.js';
import { fmtAmount, fmtTime, shortHash, COIN } from '../fmt.js';

let offLive = null;
let lastPaintJson = '';

export async function render(container, addr) {
  container.innerHTML = `<div class="card">${empty('Loading address…')}</div>`;

  const paint = async () => {
    let a;
    try { a = await api.address(addr); }
    catch (e) {
      container.innerHTML = `<div class="card"><div class="empty">${esc(e.message)}</div></div>`;
      return;
    }
    const json = JSON.stringify([a.balance, a.name, a.txs.map(t => [t.txid, t.confirmations, t.mempool ? 1 : 0])]);
    if (json === lastPaintJson) return; // no change since last paint
    lastPaintJson = json;
    container.innerHTML = `
      <div class="section-head"><h2>Address <span class="mono muted" style="font-size:14px">${esc(shortHash(addr, 14, 10))}</span></h2>
        <span class="right">${a.local ? badge('LOCAL WALLET ON THIS NODE', 'blue') : (a.name ? badge('KNOWN WALLET', 'blue') : '')}</span></div>

      <div class="grid cols-3">
        <div class="card stat-card"><div class="label">Final balance</div><div class="value">${fmtAmount(a.balance)} <span class="unit">${COIN}</span></div><div class="sub">replayed from every block on the chain</div></div>
        <div class="card stat-card"><div class="label">Wallet label</div><div class="value">${esc(a.name || 'Unknown')}</div><div class="sub">${a.local ? 'managed by this node' : 'advertised by the owning node'}</div></div>
        <div class="card stat-card"><div class="label">Transactions</div><div class="value">${a.txs.length}</div><div class="sub">${a.is_mempool_pending ? 'some pending in mempool' : 'all mined'}</div></div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="kv">
          <div class="k">Full address (Base58Check)</div><div class="v">${''}</div>
          <div class="k">Format</div><div class="v mono">P2PKH · version 0x00 · HASH160(compressed secp256k1 pubkey) · 4-byte checksum</div>
        </div>
        <div class="divider"></div>
        <h3>Transaction history</h3>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>Tx ID</th><th>Direction</th><th>Counterparty</th><th class="num">Amount</th><th>Status</th></tr></thead>
          <tbody>
            ${a.txs.length ? a.txs.map(t => {
              const isIn = t.direction === 'in';
              const other = isIn ? (t.from_name || t.from_addr) : (t.to_name || t.to_addr);
              const conf = t.mempool ? null : t.confirmations;
              return `<tr>
                <td><a class="mono" href="#/tx/${esc(t.txid)}">${esc(shortHash(t.txid, 10, 8))}</a>
                    ${t.type === 'COINBASE' ? ' <span class="tag-sys">COINBASE</span>' : ''}</td>
                <td>${isIn ? badge('RECEIVED', 'green') : badge('SENT', 'red')}</td>
                <td><a href="#/address/${esc(isIn ? t.from_addr : t.to_addr)}">${esc(other)}</a></td>
                <td class="num"><span class="amt ${isIn ? 'pos' : 'neg'}">${isIn ? '+' : '−'}${fmtAmount(t.amount)} <span class="unit">${COIN}</span></span></td>
                <td>${conf === null ? badge('MEMPOOL', 'yellow') : badge(conf + ' conf', conf > 0 ? 'green' : 'gray')}</td>
              </tr>`;
            }).join('') : `<tr><td colspan="5">${empty('No transactions for this address yet')}</td></tr>`}
          </tbody></table></div>
      </div>`;

    const v = container.querySelector('.kv .v');
    v.innerHTML = '';
    v.appendChild(copyable(addr, addr));
    if (a.name) {
      const b = document.createElement('span');
      b.innerHTML = badge(`label: ${a.name}`, 'blue');
      v.appendChild(b);
    }
  };

  await paint();
  offLive = App.on(paint);
}

export function destroy() { if (offLive) { offLive(); offLive = null; } lastPaintJson = ''; }
