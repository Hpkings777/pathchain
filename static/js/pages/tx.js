// PATHchain — transaction detail with signature forensics
import { api } from '../api.js';
import { el, esc, empty, badge, copyable } from '../ui.js';
import { fmtAmount, fmtTime, shortHash, COIN } from '../fmt.js';

export async function render(container, txid) {
  container.innerHTML = `<div class="card">${empty('Loading transaction…')}</div>`;
  let t;
  try { t = await api.tx(txid); }
  catch (e) {
    container.innerHTML = `<div class="card"><div class="empty">${esc(e.message)}</div>
      <div class="empty">If you just sent it from another computer, wait for it to sync, or check the mempool.</div></div>`;
    return;
  }
  const isCoin = t.type === 'COINBASE';
  const statusColor = t.signature_status && t.signature_status.includes('VALID') ? 'green'
    : t.signature_status && t.signature_status.includes('INVALID') ? 'red' : 'yellow';

  container.innerHTML = `
    <div class="section-head">
      <h2>Transaction ${isCoin ? badge('COINBASE — NEWLY ISSUED ' + COIN, 'yellow') : badge('TRANSFER', 'blue')}</h2>
      <span class="right muted">${t.mempool ? 'waiting in mempool (not mined yet)' : `mined in block <a href="#/block/${t.block_height}">#${t.block_height}</a> · ${t.confirmations} confirmation(s)`}</span>
    </div>

    <div class="card">
      <div class="kv">
        <div class="k">Transaction ID</div><div class="v">${''}</div>
        <div class="k">Timestamp</div><div class="v">${fmtTime(t.timestamp)}</div>
        <div class="k">Signature status</div><div class="v">${badge(t.signature_status, statusColor)}
          <span class="muted" style="font-size:12px">verified by every node using the sender's public key</span></div>
        <div class="k">Signature algorithm</div><div class="v mono">${esc(t.signature_algorithm || '— (system transaction)')}</div>
      </div>

      <div class="divider"></div>
      <h3>${isCoin ? 'Issued by the network to the miner' : 'Value flow'}</h3>
      <div class="io-row">
        <div class="io-card ${isCoin ? '' : 'out'}">
          <div class="who">${esc(t.from_name || 'NETWORK')} ${isCoin ? '<span class="tag-sys">SYSTEM · NO SENDER (NEW MONEY)</span>' : ''}</div>
          <div class="addr">${esc(t.from_addr || 'NETWORK')}</div>
          ${isCoin ? '<div class="muted" style="font-size:12px">Coinbase: the only place new PATH is created. Total supply grows exactly by the block reward.</div>'
            : `<a href="#/address/${esc(t.from_addr)}">View address →</a>`}
        </div>
        <div class="io-arrow">→</div>
        <div class="io-card in">
          <div class="who">${esc(t.to_name || shortHash(t.to_addr, 8, 6))}</div>
          <div class="addr">${esc(t.to_addr)}</div>
          <a href="#/address/${esc(t.to_addr)}">View address →</a>
        </div>
      </div>

      ${!isCoin ? `
      <div class="divider"></div>
      <h3>Unlocking / locking scripts <span class="right muted">Bitcoin-style P2PKH notation</span></h3>
      <div class="key-row"><div class="kl">scriptPubKey (locks the coins)</div><div class="kv2">${esc(t.script_pub_key || '—')}</div></div>
      <div class="key-row"><div class="kl">scriptSig (unlocks + proves ownership)</div><div class="kv2" style="word-break:break-all">${esc(shortenSig(t.script_sig))}</div></div>
      <div class="key-row"><div class="kl">Public key (sender)</div><div class="kv2">${esc(t.public_key || '—')}</div></div>
      <div class="key-row"><div class="kl">Signature (ECDSA r‖s)</div><div class="kv2">${esc(shortenSig(t.signature))}</div></div>
      <div class="muted" style="font-size:12px;margin-top:10px">
        The signature covers from_addr, to_addr, amount, timestamp and nonce — changing any of them invalidates it.
        The private key never appears anywhere on the network.
      </div>` : `
      <div class="divider"></div>
      <div class="muted" style="font-size:12.5px">
        Coinbase transactions have no signature: new ${COIN} is created by the network itself and paid to
        <b>${esc(t.to_name || '')}</b> for finding a valid proof-of-work. This is the ONLY way ${COIN} enters circulation.
      </div>`}

      <details class="rawjson"><summary>Raw transaction JSON</summary><pre>${esc(JSON.stringify(t, null, 2))}</pre></details>
    </div>`;

  const firstV = container.querySelector('.kv .v');
  firstV.innerHTML = '';
  firstV.appendChild(copyable(t.txid, shortHash(t.txid, 20, 14)));
}

function shortenSig(sig) {
  if (!sig) return '—';
  if (sig.length < 130) return sig;
  return sig.slice(0, 60) + ' … ' + sig.slice(-40) + `   (${sig.length} hex chars)`;
}
