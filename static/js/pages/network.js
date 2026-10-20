// PATHchain — network page: peers, discovery, tamper demo, consensus votes
import { App, api } from '../api.js';
import { el, esc, empty, badge, toast, nodeChip } from '../ui.js';
import { fmtNum, timeAgo, fmtTime, shortHash, COIN } from '../fmt.js';

let offLive = null;

export async function render(container) {
  container.innerHTML = `
    <div class="section-head"><h2>Network</h2>
      <span class="right muted">one node becomes many — peers over your local network</span></div>

    <div class="grid cols-2" style="align-items:start">
      <div>
        <div class="card">
          <h3>This node</h3>
          <div id="self-card">${empty('…')}</div>
        </div>

        <div class="card" style="margin-top:16px">
          <h3>Connected peers <span class="right" id="peer-count"></span></h3>
          <div id="peer-table">${empty('…')}</div>
          <div class="divider"></div>
          <div style="display:flex;gap:8px">
            <input id="connect-target" placeholder="IP:port e.g. 192.168.1.27:9574" style="flex:1;background:var(--bg-deep);color:var(--text);border:1px solid var(--border-strong);border-radius:10px;padding:10px 13px">
            <button class="btn btn-primary" id="btn-connect">Connect</button>
          </div>
          <div class="muted" style="font-size:11.5px;margin-top:8px">
            Auto-discovery runs via UDP broadcast every 6 s. If your Wi-Fi blocks broadcast (AP isolation), connect by IP here.
          </div>
        </div>
      </div>

      <div>
        <div class="card" id="vote-card" style="display:none">
          <h3>Consensus vote — tamper response <span class="right" id="vote-state"></span></h3>
          <div id="vote-body"></div>
        </div>

        <div class="card" style="margin-top:16px">
          <h3>Demonstrations <span class="right muted">safe to run live</span></h3>
          <div class="grid cols-2" style="gap:10px">
            <button class="btn" id="btn-tamper">Simulate tampering (tip block)</button>
            <button class="btn" id="btn-sync">Force state broadcast</button>
          </div>
          <div class="muted" style="font-size:12px;margin-top:10px">
            <b>Tamper demo script:</b> 1) keep two computers connected → 2) press “Simulate tampering” here →
            every node's chain turns RED (the edited transaction fails its signature check) → 3) other computers
            vote → 4) majority YES rolls the chain back to the last valid block and bumps the epoch —
            the hacker keeps nothing.
          </div>
        </div>

        <div class="card" style="margin-top:16px">
          <h3>Live network feed</h3>
          <div id="event-feed" class="feed">${empty('…')}</div>
        </div>
      </div>
    </div>`;

  document.getElementById('btn-connect').onclick = async () => {
    const t = document.getElementById('connect-target').value.trim();
    if (!t) return;
    try { const r = await api.connect(t); toast(r.message, 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  };
  document.getElementById('btn-tamper').onclick = async () => {
    if (!confirm('Tamper with the newest block (demo)? The network will vote on a rollback.')) return;
    try { const r = await api.tamper('tamper test'); toast(r.message, 'err'); }
    catch (e) { toast(e.message, 'err'); }
  };
  document.getElementById('btn-sync').onclick = async () => {
    try { const r = await api.connect(''); } catch (e) { /* noop */ }
    toast('State broadcast queued (peers sync every 4s automatically)', 'ok');
  };

  const paint = async (s) => { if (s) await paintAll(s); };
  if (App.state) await paint(App.state);
  offLive = App.on(paint);
}

let lastSelfSig = '', lastPeerSig = '', lastEventSig = 0, lastEventHtml = '';

async function paintAll(s) {
  // self card
  const selfBox = document.getElementById('self-card');
  if (selfBox) {
    const v = s.self;
    const html = `
      <div class="kv">
        <div class="k">Node name</div><div class="v"><b>${esc(v.name)}</b> ${badge('ID ' + esc(v.node_id.slice(0, 8)), 'gray')}</div>
        <div class="k">Web explorer</div><div class="v mono">http://${esc(v.ips.find(i => !i.startsWith('127.')) || '127.0.0.1')}:${v.http_port} <span class="muted">← open this from phones/other PCs</span></div>
        <div class="k">Peer / discovery ports</div><div class="v mono">TCP ${v.tcp_port} · UDP ${v.udp_port}</div>
        <div class="k">Chain epoch</div><div class="v">${v.epoch} <span class="muted">+1 after every successful rollback</span></div>
        <div class="k">Chain tip</div><div class="v"><a href="#/block/${v.height}">#${v.height}</a> <span class="mono muted">${esc(shortHash(v.tip_hash, 10, 8))}</span></div>
        <div class="k">Local wallets</div><div class="v">${v.wallet_count}</div>
        <div class="k">Validation</div><div class="v">${v.compromised ? badge('COMPROMISED at block #' + v.bad_index, 'red') : badge('ALL BLOCKS VALID', 'green')}</div>
      </div>`;
    if (html !== lastSelfSig) { lastSelfSig = html; selfBox.innerHTML = html; }
  }

  // peers (re-render only when the picture actually changed)
  let peers;
  try { peers = await api.peers(); } catch (e) { peers = null; }
  if (peers) {
    const pt = document.getElementById('peer-table');
    const pc = document.getElementById('peer-count');
    if (pc) pc.textContent = `${peers.connected.length} connected · ${peers.discovered.length} discovered`;
    const sig = JSON.stringify([peers.connected.map(p => [p.node_id, p.height, Math.round(p.lag)]), peers.discovered.length]);
    if (sig !== lastPeerSig) {
      lastPeerSig = sig;
      pt.innerHTML = peers.connected.length ? `
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th></th><th>Node</th><th>IP</th><th class="num">Height</th><th>Last seen</th></tr></thead>
        <tbody>${peers.connected.map(p => `
          <tr>
            <td>${nodeChip(p.name)}</td>
            <td><b>${esc(p.name || '?')}</b><div class="faint mono" style="font-size:10.5px">${esc((p.node_id || '').slice(0, 12))}</div></td>
            <td class="mono">${esc(p.ip)}:${p.port}</td>
            <td class="num">${p.height || '—'}</td>
            <td class="muted">${p.lag < 6 ? `${p.lag.toFixed(1)}s ago` : badge('STALE', 'yellow')}</td>
          </tr>`).join('')}</tbody></table></div>`
      : empty('No peers connected yet. Start PATHchain on another computer — it auto-discovers via UDP. Or connect by IP above.');
    }
  }

  // vote panel
  const poll = s.poll;
  const voteCard = document.getElementById('vote-card');
  if (voteCard) {
    if (poll) {
      voteCard.style.display = 'block';
      const vs = document.getElementById('vote-state');
      const eligible = poll.eligible_voters || [];
      const yes = poll.yes || 0, no = poll.no || 0;
      const required = poll.required || (Math.floor(eligible.length / 2) + 1);
      let stateBadge;
      if (poll.closed) stateBadge = poll.approved ? badge('APPROVED — ROLLED BACK', 'green') : badge('REJECTED', 'red');
      else stateBadge = badge('OPEN', 'yellow');
      vs.innerHTML = stateBadge;

      const canVote = !poll.hidden && !poll.has_voted && !poll.closed;
      document.getElementById('vote-body').innerHTML = `
        <div class="muted" style="font-size:13px">
          <b class="red">${esc(poll.hacker)}</b> tampered with block #${poll.compromised_from}
          ${poll.note ? `<span class="muted">(${esc(poll.note)})</span>` : ''}.
          The network must now reach majority consensus to roll back.
        </div>
        <div class="vote-track">
          <div class="yes" style="flex:${yes}"></div>
          <div class="no" style="flex:${Math.max(no, 0.001)}"></div>
          <div style="flex:${Math.max(eligible.length - yes - no, 0.001)};opacity:.25"></div>
        </div>
        <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
          <span><b class="green">${yes}</b> YES</span>
          <span><b class="red">${no}</b> NO</span>
          <span class="muted">needs ${required} YES from ${eligible.length} eligible node(s)</span>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn btn-green" id="v-yes" ${canVote ? '' : 'disabled'}>Vote ROLLBACK (YES)</button>
          <button class="btn btn-red" id="v-no" ${canVote ? '' : 'disabled'}>Vote KEEP (NO)</button>
        </div>
        ${poll.hidden ? '<div class="muted" style="font-size:11.5px;margin-top:8px">This node started the tamper, so it does not vote — it coordinates the tally.</div>' : ''}
        ${poll.has_voted && !poll.closed ? '<div class="muted" style="font-size:11.5px;margin-top:8px">This node has voted — waiting for the rest of the network.</div>' : ''}`;
      const vy = document.getElementById('v-yes'), vn = document.getElementById('v-no');
      if (vy) vy.onclick = async () => { try { const r = await api.vote(true); toast(r.message, 'ok'); } catch (e) { toast(e.message, 'err'); } };
      if (vn) vn.onclick = async () => { try { const r = await api.vote(false); toast(r.message, ''); } catch (e) { toast(e.message, 'err'); } };
    } else {
      voteCard.style.display = 'none';
    }
  }

  // events feed — polled at most every 5s (it is informational, not live-critical)
  const now = Date.now();
  if (now - lastEventSig > 5000) {
    lastEventSig = now;
    try {
      const ev = await api.events();
      const feed = document.getElementById('event-feed');
      if (feed) {
        const html = ev.events.length ? ev.events.map(e => `
          <div class="feed-item">
            <span class="t">${new Date(e.ts * 1000).toLocaleTimeString('en-GB')}</span>
            <span class="k ${esc(e.kind)}">${esc(e.kind).toUpperCase()}</span>
            <span style="flex:1">${esc(e.text)}</span>
          </div>`).join('') : empty('No network events yet.');
        if (html !== lastEventHtml) { lastEventHtml = html; feed.innerHTML = html; }
      }
    } catch (e) { /* ignore */ }
  }
}

export function destroy() { if (offLive) { offLive(); offLive = null; } lastSelfSig = lastPeerSig = ''; lastEventHtml = ''; }
