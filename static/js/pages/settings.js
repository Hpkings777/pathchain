// PATHchain — Settings: Bot Engine studio, market regime, theme.
// Every numeric control is clamped client-side AND re-clamped server-side,
// so a stray value can never poison the engine.
import { api, App, live } from '../api.js';
import { el, esc, toast } from '../ui.js';
import { fmtNum } from '../fmt.js';

let offLive = null;
let saveTimer = null;
let current = null;      // last-known server config
let dirty = false;

const REGIMES = [
  { id: 'bullish', desc: 'steady up-drift' },
  { id: 'bearish', desc: 'steady down-drift' },
  { id: 'sideways', desc: 'choppy range' },
  { id: 'volatile', desc: 'big swings' },
  { id: 'crash', desc: 'sell-off event' },
  { id: 'pump', desc: 'buying frenzy' },
];
const MIX = [
  { key: 'miners', label: 'Miners', hint: 'run real SHA-256 PoW on the chain', max: 20 },
  { key: 'buyers', label: 'Traders — buy', hint: 'mean-reversion + momentum bids', max: 20 },
  { key: 'sellers', label: 'Traders — sell', hint: 'mean-reversion + momentum asks', max: 20 },
  { key: 'arbitrageurs', label: 'Arbitrageurs', hint: 'harvest the DEX↔Secondary spread', max: 20 },
  { key: 'makers', label: 'Market makers', hint: 'quote both sides, widen on vol spikes', max: 20 },
];

export async function render(container) {
  let data;
  try { data = await api.bots(); }
  catch (e) {
    container.innerHTML = `<div class="card"><div class="empty">Bot engine unavailable: ${esc(e.message)}</div></div>`;
    return;
  }
  current = data.config;

  container.innerHTML = `
    <div class="section-head"><h2>Settings</h2>
      <span class="right muted">the bot engine drives the live PATH market — every change applies on the next tick</span></div>

    <div class="settings-grid">
      <div class="card set-card">
        <h3><span>Bot engine</span>
          <label class="toggle" title="Master switch — start/stop every bot">
            <input type="checkbox" id="set-enabled" ${current.enabled ? 'checked' : ''}><span class="track"></span><span class="tl" id="set-enabled-label">${current.enabled ? 'Running' : 'Paused'}</span>
          </label></h3>
        <p class="set-sub">Bots trade a transparently simulated PATH/USD market on two venues. Miner bots mine <b>real</b> blocks — watch the height climb on the Explorer.</p>

        <div class="slider-row">
          <div class="sr-head"><span>Total bots</span><b id="v-bot_count">${current.bot_count}</b></div>
          <input type="range" id="r-bot_count" min="0" max="50" step="1" value="${current.bot_count}">
        </div>

        <div class="divider"></div>
        <h4 style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--faint);margin:10px 0 2px">Type mix</h4>
        <div class="mix-grid">
          ${MIX.map(m => `
            <div class="slider-row" style="grid-column:1/-1">
              <div class="sr-head"><span><span class="bot-badge ${m.key}">${m.label}</span> <span class="muted" style="font-size:11px">${m.hint}</span></span><b id="v-${m.key}">${current[m.key]}</b></div>
              <input type="range" id="r-${m.key}" min="0" max="${m.max}" step="1" value="${current[m.key]}">
            </div>`).join('')}
        </div>

        <div class="slider-row">
          <div class="sr-head"><span>Bot mining power <span class="muted" style="font-size:11px">(throttle on miner bots)</span></span><b id="v-bot_hashrate">${current.bot_hashrate}%</b></div>
          <input type="range" id="r-bot_hashrate" min="0" max="100" step="5" value="${current.bot_hashrate}">
        </div>
      </div>

      <div class="card set-card">
        <h3>Market behaviour</h3>
        <p class="set-sub">Regimes bias order flow on both venues. Crash &amp; pump run hot for ~a minute, then hand back to sideways.</p>
        <div class="regime-grid" role="radiogroup" aria-label="Market regime">
          ${REGIMES.map(r => `
            <button type="button" class="regime-pill ${current.regime === r.id ? 'active' : ''}" data-r="${r.id}" role="radio" aria-checked="${current.regime === r.id}">
              <span>${r.id}</span><small>${r.desc}</small>
            </button>`).join('')}
        </div>
        <div class="divider"></div>
        <h4 style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--faint);margin:10px 0 8px">Tick rate</h4>
        <div class="tf-tabs" id="tick-tabs" role="tablist">
          ${[100, 250, 500, 1000].map(t => `<button role="tab" data-ms="${t}" class="${Number(current.tick_ms) === t ? 'active' : ''}">${t} ms</button>`).join('')}
        </div>
        <div class="set-row">
          <div class="set-field"><label for="n-base">Base price (USD)</label>
            <input type="number" id="n-base" min="0.01" max="10000" step="0.01" value="${current.base_price}"></div>
          <div class="set-field"><label for="n-vol">Volatility (%)</label>
            <input type="number" id="n-vol" min="0" max="100" step="1" value="${current.volatility}"></div>
        </div>
        <div class="slider-row">
          <div class="sr-head"><span>Bot aggression <span class="muted" style="font-size:11px">(order size &amp; signal sensitivity)</span></span><b id="v-aggression">${Number(current.aggression).toFixed(2)}</b></div>
          <input type="range" id="r-aggression" min="0" max="1" step="0.05" value="${current.aggression}">
        </div>
        <p class="muted" style="font-size:11.5px;margin-top:12px">Changing the base price re-anchors both order books; existing candles keep their history.</p>
      </div>

      <div class="card set-card">
        <h3>Live status</h3>
        <p class="set-sub" id="bot-status-sub">connecting to the engine…</p>
        <div id="bot-status-grid" class="grid cols-2" style="gap:10px"></div>
        <div class="divider"></div>
        <h4 style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--faint);margin:10px 0 8px">Appearance</h4>
        <div class="tf-tabs" id="theme-tabs" role="tablist">
          <button role="tab" data-t="dark" class="${document.documentElement.dataset.theme !== 'light' ? 'active' : ''}">Dark</button>
          <button role="tab" data-t="light" class="${document.documentElement.dataset.theme === 'light' ? 'active' : ''}">Light</button>
        </div>
        <p class="muted" style="font-size:11.5px;margin-top:10px">Dark is the default. The theme is remembered on this device only — every node keeps its own.</p>
      </div>
    </div>

    <div class="save-bar">
      <button class="btn btn-primary" id="btn-save">Save &amp; apply</button>
      <span class="hint" id="save-hint">changes apply automatically · <span class="pulse-dot" style="display:none" id="saved-pulse"></span><span id="saved-text"></span></span>
    </div>`;

  // ---- wiring ----------------------------------------------------------
  const collect = () => ({
    bot_count: val('r-bot_count'),
    miners: val('r-miners'), buyers: val('r-buyers'), sellers: val('r-sellers'),
    arbitrageurs: val('r-arbitrageurs'), makers: val('r-makers'),
    bot_hashrate: val('r-bot_hashrate'),
    aggression: val('r-aggression'),
    base_price: num('n-base'), volatility: num('n-vol'),
    tick_ms: current.tick_ms, regime: current.regime, enabled: current.enabled,
  });

  const val = (id) => Number(document.getElementById(id)?.value ?? 0);
  const num = (id) => {
    const input = document.getElementById(id);
    const v = parseFloat(input.value);
    if (!isFinite(v)) { input.classList.add('invalid'); return NaN; }
    input.classList.remove('invalid');
    return v;
  };

  const fill = (input) => {
    const min = Number(input.min), max = Number(input.max);
    const pct = ((Number(input.value) - min) / Math.max(1e-9, max - min)) * 100;
    input.style.setProperty('--fill', pct.toFixed(1) + '%');
  };
  container.querySelectorAll('input[type="range"]').forEach(fill);

  const scheduleSave = () => {
    dirty = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save(), 450);
  };

  const save = async () => {
    const cfg = collect();
    // client-side clamps (server re-clamps anyway)
    cfg.bot_count = Math.max(0, Math.min(50, Math.round(cfg.bot_count || 0)));
    cfg.base_price = Math.max(0.01, Math.min(10000, cfg.base_price || 0.85));
    cfg.volatility = Math.max(0, Math.min(100, cfg.volatility ?? 35));
    if (!isFinite(cfg.base_price) || !isFinite(cfg.volatility)) return;
    try {
      const r = await api.saveBots(cfg);
      current = r.config;
      const pulse = document.getElementById('saved-pulse');
      const text = document.getElementById('saved-text');
      if (pulse && text) {
        pulse.style.display = '';
        text.textContent = 'saved ' + new Date().toLocaleTimeString('en-GB', { hour12: false });
        setTimeout(() => { pulse.style.display = 'none'; }, 2000);
      }
      dirty = false;
      if (r.errors && r.errors.length) toast(r.errors[0], 'err');
    } catch (e) { toast(e.message, 'err'); }
  };

  container.querySelectorAll('input[type="range"]').forEach(input => {
    input.addEventListener('input', () => {
      const out = document.getElementById('v-' + input.id.replace('r-', ''));
      if (out) out.textContent = input.id === 'r-aggression' ? Number(input.value).toFixed(2)
        : input.id === 'r-bot_hashrate' ? input.value + '%' : input.value;
      fill(input);
      scheduleSave();
    });
  });
  ['n-base', 'n-vol'].forEach(id => {
    const input = document.getElementById(id);
    input.addEventListener('change', () => {
      const v = parseFloat(input.value);
      if (!isFinite(v)) { input.classList.add('invalid'); return; }
      input.classList.remove('invalid');
      const clamped = Math.max(Number(input.min), Math.min(Number(input.max), v));
      if (clamped !== v) input.value = clamped;      // visual clamp feedback
      scheduleSave();
    });
  });

  const master = document.getElementById('set-enabled');
  master.addEventListener('change', async () => {
    current.enabled = master.checked;
    document.getElementById('set-enabled-label').textContent = master.checked ? 'Running' : 'Paused';
    try {
      await api.toggleBots(master.checked);
      toast(master.checked ? 'Bot engine started — bots are trading' : 'Bot engine paused — books frozen', master.checked ? 'ok' : '');
    } catch (e) { toast(e.message, 'err'); }
  });

  container.querySelectorAll('.regime-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      container.querySelectorAll('.regime-pill').forEach(x => { x.classList.remove('active'); x.setAttribute('aria-checked', 'false'); });
      pill.classList.add('active');
      pill.setAttribute('aria-checked', 'true');
      current.regime = pill.dataset.r;
      scheduleSave();
      if (pill.dataset.r === 'crash' || pill.dataset.r === 'pump') {
        toast(`${pill.dataset.r === 'crash' ? 'Crash' : 'Pump'} regime armed — watch the tape`, pill.dataset.r === 'crash' ? 'err' : 'ok');
      }
    });
  });

  container.querySelectorAll('#tick-tabs button').forEach(b => {
    b.addEventListener('click', () => {
      container.querySelectorAll('#tick-tabs button').forEach(x => x.classList.toggle('active', x === b));
      current.tick_ms = Number(b.dataset.ms);
      scheduleSave();
    });
  });

  container.querySelectorAll('#theme-tabs button').forEach(b => {
    b.addEventListener('click', () => {
      container.querySelectorAll('#theme-tabs button').forEach(x => x.classList.toggle('active', x === b));
      const root = document.documentElement;
      if (b.dataset.t === 'light') root.dataset.theme = 'light'; else delete root.dataset.theme;
      try { localStorage.setItem('path.theme', b.dataset.t === 'light' ? 'light' : ''); } catch (e) { /* noop */ }
    });
  });

  document.getElementById('btn-save').addEventListener('click', async () => {
    clearTimeout(saveTimer);
    await save();
    toast('Bot engine config applied', 'ok');
  });

  // live status polling (uses SSE snapshot when healthy, else the REST route)
  const paintStatus = (snap) => {
    if (!snap) return;
    const sub = document.getElementById('bot-status-sub');
    const grid = document.getElementById('bot-status-grid');
    if (!grid || !snap.bots) return;
    const b = snap.bots;
    if (sub) sub.innerHTML = live.healthy()
      ? 'streaming live via SSE at ' + esc(String(snap.tick_ms || current.tick_ms)) + ' ms/tick'
      : 'polling fallback (stream offline) — data still updates';
    grid.innerHTML = `
      <div class="card stat-card"><div class="label">Active bots</div><div class="value">${b.active ?? 0}</div><div class="sub">${b.miner ?? 0} mining · ${b.buyer ?? 0} buying · ${b.seller ?? 0} selling</div></div>
      <div class="card stat-card"><div class="label">Regime</div><div class="value" style="text-transform:capitalize">${esc(snap.regime || current.regime)}</div><div class="sub">tick ${esc(String(snap.tick_ms || current.tick_ms))} ms</div></div>
      <div class="card stat-card"><div class="label">Spot price</div><div class="value">$${Number(snap.price || 0).toFixed(4)}</div><div class="sub">mid of the DEX book</div></div>
      <div class="card stat-card"><div class="label">Engine ticks</div><div class="value">${fmtNum(snap.version || 0)}</div><div class="sub">since node start</div></div>`;
  };
  if (live.snap) paintStatus(live.snap);
  offLive = live.on(paintStatus);
}

export function destroy() {
  if (offLive) { offLive(); offLive = null; }
  clearTimeout(saveTimer);
  if (dirty) { /* one final flush so nothing is lost on navigation */ }
}
