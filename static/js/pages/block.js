// PATHchain — single block detail
import { App, api } from '../api.js';
import { el, esc, empty, txRow, badge, copyable, nodeChip } from '../ui.js';
import { fmtAmount, fmtNum, timeAgo, fmtTime, shortHash, COIN } from '../fmt.js';

let offLive = null;

export async function render(container, ref) {
  container.innerHTML = `<div class="card">${empty('Loading block…')}</div>`;
  let b;
  try { b = await api.block(ref); }
  catch (e) {
    container.innerHTML = `<div class="card"><div class="empty">${esc(e.message || 'Block not found')}</div>
      <div class="empty"><a href="#/blocks">← back to all blocks</a></div></div>`;
    return;
  }
  const conf = b.confirmations;
  const isGenesis = b.index === 0;
  const tampered = b.chain_valid === false;   // covers header edits AND tx edits
  container.innerHTML = `
    ${tampered ? `
    <div class="alert-banner red" style="display:flex;margin-bottom:14px">
      <span><b>Tamper forensics:</b> this block fails the node's own validation${b.invalid_reason ? ` — <span class="mono">${esc(b.invalid_reason)}</span>` : ''}. Every honest node rejects it on sight.</span>
      <a class="btn btn-sm" href="#/chain">See it on the chain view</a>
    </div>` : ''}
    <div class="section-head">
      <h2>Block <a href="#/block/${b.index}">#${b.index}</a> ${isGenesis ? badge('GENESIS', 'blue') : ''} ${tampered ? badge('TAMPERED', 'red') : ''}</h2>
      <span class="right muted">${b.confirmations} confirmation(s) · mined ${timeAgo(b.timestamp)}</span>
    </div>

    <div class="grid cols-4">
      <div class="card stat-card"><div class="label">Timestamp</div><div class="value" style="font-size:15px">${fmtTime(b.timestamp)}</div><div class="sub">${timeAgo(b.timestamp)}</div></div>
      <div class="card stat-card"><div class="label">Transactions</div><div class="value">${b.txs.length}</div><div class="sub">1 coinbase + ${Math.max(0, b.txs.length - 1)} transfer(s)</div></div>
      <div class="card stat-card"><div class="label">Miner</div><div class="value" style="font-size:16px">${nodeChip(b.miner)} ${esc(b.miner || '—')}</div><div class="sub mono">${esc(shortHash(b.miner_address || '', 8, 6))}</div></div>
      <div class="card stat-card"><div class="label">Proof-of-Work</div><div class="value">${b.bits} zeros</div><div class="sub">nonce ${fmtNum(b.nonce)} · ${fmtNum(b.size)} bytes</div></div>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>Block header <span class="right muted">the exact data the miner hashed ${fmtNum(b.nonce) + 1}+ times</span></h3>
      <div class="kv">
        <div class="k">Block hash (SHA-256)</div><div class="v">${''}</div>
        <div class="k">Previous block hash</div><div class="v">${''}</div>
        <div class="k">Merkle root</div><div class="v">${''}</div>
        <div class="k">Difficulty target</div><div class="v">${b.bits} leading zero hex digits — hash must start with <span class="mono green">${'0'.repeat(b.bits)}</span></div>
        <div class="k">Nonce (the winning attempt)</div><div class="v"><span class="mono yellow">${fmtNum(b.nonce)}</span></div>
        <div class="k">Header (pre-hash serialisation)</div><div class="v"><span class="mono faint" style="font-size:11px">${esc(b.header_hash_input)}</span></div>
      </div>
      <div class="divider"></div>
      <h3>Transactions in this block</h3>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Tx ID</th><th>Type</th><th>From → To</th><th class="num">Amount</th><th>Signature</th></tr></thead>
        <tbody>
          ${b.txs.map(t => `<tr>
            <td><a class="mono" href="#/tx/${esc(t.txid)}">${esc(shortHash(t.txid, 10, 8))}</a></td>
            <td>${t.type === 'COINBASE' ? badge('COINBASE', 'yellow') : badge('TRANSFER', 'blue')}</td>
            <td>${esc(t.from_name || 'NETWORK')} <span class="io-arrow">→</span> ${esc(t.to_name || shortHash(t.to_addr, 8, 6))}</td>
            <td class="num"><span class="amt ${t.type === 'COINBASE' ? 'pos' : ''}">${fmtAmount(t.amount)} <span class="unit">${COIN}</span></span></td>
            <td>${t.type === 'COINBASE' ? '<span class="muted">system tx</span>' : '<a href="#/tx/' + esc(t.txid) + '">view ECDSA proof</a>'}</td>
          </tr>`).join('')}
        </tbody></table></div>
      <details class="rawjson"><summary>Raw block JSON</summary><pre>${esc(JSON.stringify(b, null, 2))}</pre></details>
    </div>`;

  // attach hash rows with copyable content
  const kv = container.querySelectorAll('.kv .v');
  const hashRow = (row, text) => {
    row.innerHTML = '';
    row.appendChild(copyable(text, shortHash(text, 18, 12)));
    const st = document.createElement('span');
    const zeros = text.match(/^0+/);
    st.innerHTML = zeros && zeros[0].length >= b.bits
      ? badge(`PoW valid · ${zeros[0].length} zeros`, 'green')
      : badge('PoW invalid', 'red');
    row.appendChild(st);
  };
  hashRow(kv[0], b.hash);
  kv[1].innerHTML = ''; kv[1].appendChild(copyable(b.prev_hash, shortHash(b.prev_hash, 18, 12)));
  kv[2].innerHTML = ''; kv[2].appendChild(copyable(b.merkle_root, shortHash(b.merkle_root, 18, 12)));
}

export function destroy() { if (offLive) { offLive(); offLive = null; } }
