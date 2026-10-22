// PATHchain — wallet manager (real secp256k1 keys, stored locally only)
import { App, api } from '../api.js';
import { el, esc, empty, badge, copyable, toast, modal, amountCell } from '../ui.js';
import { fmtAmount, timeAgo, shortHash, COIN } from '../fmt.js';

let offLive = null;
let selected = null;
let lastWalletsJson = '';

export async function render(container) {
  container.innerHTML = `
    <div class="section-head"><h2>Wallets on this node</h2>
      <span class="right muted">private keys live ONLY in this computer's data folder — they are never broadcast or synced</span></div>
    <div class="grid wallet-grid" style="align-items:start">
      <div>
        <div class="card">
          <h3>My wallets <button class="btn btn-sm btn-primary" id="btn-new" style="margin-left:auto">+ New wallet</button></h3>
          <div id="wallet-list"><div class="empty">Loading…</div></div>
          <div class="muted" style="font-size:12px;margin-top:12px">
            PATH enters existence only through <b>mining rewards</b>. Create a wallet, then mine (or ask another
            computer to mine for you) to earn coins you can spend.
          </div>
        </div>
        <div class="card" style="margin-top:16px">
          <h3>Send ${COIN}</h3>
          <div id="send-area">${empty('Create or select a wallet first')}</div>
        </div>
      </div>
      <div>
        <div class="card">
          <h3>What is a wallet, really?</h3>
          <div class="muted" style="font-size:13px; line-height:1.7">
            <p style="margin-bottom:10px">A wallet is just a <b>secp256k1 keypair</b> — the same elliptic curve Bitcoin uses.
            The <b>private key</b> is a random 256-bit number. The <b>public key</b> is derived from it (this direction is easy).</p>
            <p style="margin-bottom:10px">Your <b>address</b> = Base58Check( 0x00 + HASH160(public key) ) — a short, checksummed
            form you can share. Anyone can verify a signature with your public key; nobody can derive your private key from it.</p>
            <p>Click a wallet → <b>Show keys</b> to see the actual hex numbers behind it.</p>
          </div>
        </div>
        <div class="card" style="margin-top:16px">
          <h3>Pending (mempool)</h3>
          <div id="pending-list"><div class="empty">Loading…</div></div>
        </div>
      </div>
    </div>`;

  document.getElementById('btn-new').onclick = openCreateModal;

  await loadWallets();
  offLive = App.on(() => loadWallets(true));
}

function openCreateModal() {
  const body = el(`
    <div>
      <div class="field">
        <label for="nw-name">Wallet name</label>
        <input id="nw-name" maxlength="24" placeholder="e.g. Alice" autocomplete="off" spellcheck="false">
        <div class="hint">Letters, numbers, _ and - only. The name is a label; the address is what the network sees.</div>
      </div>
      <div class="note-warn" id="nw-err" style="display:none"></div>
      <button class="btn btn-primary btn-wide" id="nw-go">Generate keypair &amp; create</button>
    </div>`);
  const close = modal('New wallet', body);
  const input = body.querySelector('#nw-name');
  const err = body.querySelector('#nw-err');
  const go = body.querySelector('#nw-go');
  const submit = async () => {
    const name = input.value.trim();
    if (!name) { err.textContent = 'Enter a wallet name first.'; err.style.display = 'block'; input.focus(); return; }
    go.disabled = true;
    try {
      const r = await api.createWallet(name);
      toast(r.message, 'ok');
      selected = r.name;
      lastWalletsJson = '';
      close();
      await loadWallets();
    } catch (e) {
      err.textContent = e.message;
      err.style.display = 'block';
      go.disabled = false;
      input.focus();
    }
  };
  go.onclick = submit;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  setTimeout(() => input.focus(), 40);
}

async function loadWallets(quiet = false) {
  const list = document.getElementById('wallet-list');
  if (!list) return;
  let wallets;
  try { wallets = await api.wallets(); }
  catch (e) { if (!quiet) list.innerHTML = empty(e.message); return; }
  const json = JSON.stringify(wallets.map(w => [w.name, w.balance, w.spendable, w.pending_out, w.is_bot]));
  if (quiet && json === lastWalletsJson) return; // nothing changed — skip re-render
  lastWalletsJson = json;
  if (!wallets.length) {
    list.innerHTML = empty('No wallets on this node yet — tap “+ New wallet”.');
    document.getElementById('send-area').innerHTML = empty('Create a wallet first');
    return;
  }
  if (!selected || !wallets.find(w => w.name === selected)) selected = wallets[0].name;

  list.innerHTML = wallets.map(w => `
    <div class="wallet-row ${w.name === selected ? 'selected' : ''}" data-w="${esc(w.name)}">
      <span class="avatar">${esc(w.name.slice(0, 2).toUpperCase())}</span>
      <div style="min-width:0">
        <div class="wname">${esc(w.name)} ${w.is_bot ? badge('BOT', 'yellow') : ''} ${w.name === selected ? badge('SELECTED', 'blue') : ''}</div>
        <div class="waddr">${esc(w.address)}</div>
      </div>
      <div class="wbal">
        <div class="amt" style="font-size:17px">${fmtAmount(w.balance)} <span class="unit">${COIN}</span></div>
        <div class="muted" style="font-size:11.5px">${w.pending_out > 0 ? `${fmtAmount(w.spendable)} spendable (${fmtAmount(w.pending_out)} pending)` : 'all spendable'}</div>
      </div>
      <div style="display:flex;gap:6px;margin-left:12px;flex-wrap:wrap;justify-content:flex-end">
        <button class="btn btn-sm" data-keys="${esc(w.name)}">Keys</button>
        <a class="btn btn-sm" href="#/address/${esc(w.address)}">Explorer</a>
      </div>
    </div>`).join('');

  list.querySelectorAll('.wallet-row').forEach(row => {
    row.onclick = (e) => {
      if (e.target.closest('button') || e.target.closest('a')) return;
      if (selected === row.dataset.w) return;
      selected = row.dataset.w;
      lastWalletsJson = '';
      loadWallets();
    };
  });
  list.querySelectorAll('[data-keys]').forEach(btn => {
    btn.onclick = () => showKeys(btn.dataset.keys);
  });

  renderSend(wallets.find(w => w.name === selected));
  renderPending();
}

function renderSend(w) {
  const area = document.getElementById('send-area');
  if (!w) return;
  area.innerHTML = `
    <div class="field"><label>From wallet</label>
      <input value="${esc(w.name)}" disabled>
      <div class="hint">balance ${fmtAmount(w.balance)} ${COIN} · spendable ${fmtAmount(w.spendable)} ${COIN}</div></div>
    <div class="field"><label>To (wallet name or full PATH address)</label>
      <input id="send-to" placeholder="e.g. Bob — or paste a 1… address" autocomplete="off" spellcheck="false"></div>
    <div class="field"><label>Amount (${COIN})</label>
      <input id="send-amt" type="number" min="1" step="1" inputmode="numeric" placeholder="5"></div>
    <button class="btn btn-primary" id="btn-send" style="width:100%">Sign &amp; broadcast transaction</button>
    <div class="muted" style="font-size:11.5px;margin-top:9px">
      The tx is signed locally with ECDSA-secp256k1, dropped into the mempool, and miners race to include it in the next block.
    </div>`;
  const btn = area.querySelector('#btn-send');
  btn.onclick = async () => {
    const to = area.querySelector('#send-to').value.trim();
    const raw = area.querySelector('#send-amt').value.trim();
    if (!to) return toast('Fill in the recipient', 'err');
    if (!/^\d+$/.test(raw)) return toast('Amount must be a whole number of ' + COIN, 'err');
    const amt = parseInt(raw, 10);
    if (amt <= 0) return toast('Amount must be positive', 'err');
    if (amt > w.spendable) return toast(`Only ${fmtAmount(w.spendable)} ${COIN} spendable (rest pending)`, 'err');
    btn.disabled = true;
    try {
      const r = await api.send(w.name, to, amt);
      toast(`Broadcast! ${r.txid.slice(0, 18)}… — waiting for a miner`, 'ok');
      area.querySelector('#send-to').value = '';
      area.querySelector('#send-amt').value = '';
      lastWalletsJson = '';
    } catch (e) { toast(e.message, 'err'); }
    finally { btn.disabled = false; }
  };
}

async function renderPending() {
  const box = document.getElementById('pending-list');
  if (!box) return;
  try {
    const s = App.state;
    const items = (s?.mempool_preview || []);
    box.innerHTML = items.length ? items.map(t => `
      <div class="feed-item">
        <span class="t">${esc(timeAgo(t.timestamp))}</span>
        <span class="k tx">TX</span>
        <span style="flex:1">${esc(t.from_name || 'NETWORK')} → ${esc(t.to_name || shortHash(t.to_addr, 8, 6))}
          <b class="green">+${fmtAmount(t.amount)}</b></span>
        <a class="mono muted" href="#/tx/${esc(t.txid)}">${esc(shortHash(t.txid, 6, 4))}</a>
      </div>`).join('') : empty('Mempool is empty — send something!');
  } catch (e) { box.innerHTML = empty(e.message); }
}

async function showKeys(name) {
  try {
    const k = await api.walletKeys(name);
    const body = el(`<div>
      <div class="note-warn">Demo keys — never use these addresses for real funds; the key file is not encrypted.</div>
      <div class="key-row"><div class="kl">Wallet name</div><div class="kv2">${esc(k.name)}</div></div>
      <div class="key-row"><div class="kl">Address (P2PKH)</div><div class="kv2">${esc(k.address)}</div></div>
      <div class="key-row"><div class="kl">Public key (compressed)</div><div class="kv2">${esc(k.public_key_hex)}</div></div>
      <div class="key-row">
        <div class="kl">Private key (hex)</div>
        <div class="kv2">
          <span class="mono red" data-secret>•••• •••• •••• •••• •••• •••• •••• ••••</span>
          <button class="btn btn-sm" data-reveal style="margin-left:8px">Reveal</button>
        </div>
      </div>
      <div class="key-row">
        <div class="kl">Private key (WIF)</div>
        <div class="kv2">
          <span class="mono red" data-secret>•••• •••• •••• •••• •••• ••••</span>
          <button class="btn btn-sm" data-reveal style="margin-left:8px">Reveal</button>
        </div>
      </div>
      <div class="note-warn" data-reveal-warn style="display:none"><b>In a real wallet this is the moment that matters:</b> whoever sees this string owns every coin in the wallet — there is no reset, no password, no undo. That is why real wallets never let you peek at the key after setup.</div>
      <div class="muted" style="font-size:12px;margin-top:10px">
        Address = Base58Check(0x00 + RIPEMD160(SHA256(pubkey))). WIF = Base58Check(0x80 + key + 0x01) — the
        exact encodings Bitcoin uses, so students can cross-check with any textbook.
      </div>
    </div>`);
    // real wallets NEVER show the private key after creation — mask it behind an
    // explicit reveal so the demo tells the true story, not a convenient one
    let revealed = false;
    body.querySelectorAll('[data-reveal]').forEach(btn => {
      btn.onclick = () => {
        revealed = !revealed;
        body.querySelectorAll('[data-secret]').forEach(s => {
          s.textContent = revealed
            ? (s.closest('.key-row').querySelector('.kl').textContent.includes('WIF') ? k.wif : k.private_key_hex)
            : '•••• •••• •••• •••• •••• •••• •••• ••••';
        });
        body.querySelector('[data-reveal-warn]').style.display = revealed ? 'block' : 'none';
        btn.textContent = revealed ? 'Hide' : 'Reveal';
      };
    });
    modal(`Keys for ${name}`, body);
  } catch (e) { toast(e.message, 'err'); }
}

export function destroy() { if (offLive) { offLive(); offLive = null; } lastWalletsJson = ''; }
