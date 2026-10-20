// PATHchain — all blocks
import { App, api } from '../api.js';
import { el, esc, empty, nodeChip } from '../ui.js';
import { fmtAmount, fmtNum, timeAgo, fmtTime, shortHash, COIN } from '../fmt.js';

let offLive = null;
let state = { offset: 0, limit: 20 };

export async function render(container, arg) {
  state.offset = parseInt(arg) || 0;
  container.innerHTML = `
    <div class="section-head"><h2>All Blocks</h2><span class="right muted">newest first · every block re-verified by every node</span></div>
    <div class="card"><div class="table-wrap">
      <table class="tbl">
        <thead><tr>
          <th></th><th>Height</th><th>Hash</th><th>Mined by</th>
          <th class="num">Txs</th><th class="num">Reward</th><th class="num hide-sm">Difficulty</th>
          <th class="num hide-sm">Size</th><th>Timestamp</th>
        </tr></thead>
        <tbody id="blocks-body"><tr><td colspan="9">${empty('Loading…')}</td></tr></tbody>
      </table></div>
      <div class="pager" id="pager"></div>
    </div>`;
  await load();
  offLive = App.on(async (s) => { if (state.offset === 0) await load(); });
}

async function load() {
  let data;
  try { data = await api.blocks(state.offset, state.limit); }
  catch (e) {
    document.getElementById('blocks-body').innerHTML = `<tr><td colspan="9">${empty(e.message)}</td></tr>`;
    return;
  }
  const tb = document.getElementById('blocks-body');
  tb.innerHTML = data.blocks.length ? data.blocks.map(b => `
    <tr>
      <td style="width:130px"><div class="confirm-bar" title="${b.confirmations} confirmations"><i style="flex:1"></i><i style="flex:.8;opacity:.75"></i><i style="flex:.6;opacity:.5"></i><i style="flex:.4;opacity:.35"></i></div></td>
      <td><a href="#/block/${b.height}"><b>${b.height}</b></a></td>
      <td><a class="mono" href="#/block/${b.height}">${esc(shortHash(b.hash, 10, 8))}</a></td>
      <td>${nodeChip(b.miner)} ${esc(b.miner || '—')}</td>
      <td class="num">${Math.max(0, b.txs - 1)}</td>
      <td class="num"><span class="amt pos">+${fmtAmount(b.reward)} <span class="unit">${COIN}</span></span></td>
      <td class="num muted hide-sm">${b.bits} zeros</td>
      <td class="num muted hide-sm">${fmtNum(b.size)} B</td>
      <td class="nowrap muted" title="${fmtTime(b.ts)}">${timeAgo(b.ts)}</td>
    </tr>`).join('') : `<tr><td colspan="9">${empty('No blocks yet — go to Mine and start hashing!')}</td></tr>`;

  const pager = document.getElementById('pager');
  const older = data.tip - state.offset >= data.limit;
  const hi = Math.max(0, data.tip - state.offset);
  const lo = Math.max(0, hi - data.limit + 1);
  pager.innerHTML = `
    <button class="btn btn-sm" id="pg-newer" ${state.offset === 0 ? 'disabled' : ''}>← Newer</button>
    <span class="info">showing blocks ${lo}–${hi} of ${data.tip}</span>
    <button class="btn btn-sm" id="pg-older" ${!older ? 'disabled' : ''}>Older →</button>`;
  pager.querySelector('#pg-newer').onclick = () => { location.hash = `#/blocks/${Math.max(0, state.offset - state.limit)}`; };
  pager.querySelector('#pg-older').onclick = () => { location.hash = `#/blocks/${state.offset + state.limit}`; };
}

export function destroy() { if (offLive) { offLive(); offLive = null; } }
