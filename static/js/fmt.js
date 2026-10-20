// PATHchain — formatting helpers
export const COIN = 'PATH';

export function fmtAmount(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('en-US');
}

export function fmtNum(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('en-US');
}

export function shortHash(h, head = 10, tail = 6) {
  if (!h) return '—';
  if (h.length <= head + tail + 3) return h;
  return h.slice(0, head) + '…' + h.slice(-tail);
}

export function timeAgo(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 5) return 'just now';
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return d.toLocaleString('en-GB', { hour12: false });
}

export function fmtDur(sec) {
  if (sec === null || sec === undefined) return '—';
  if (sec < 1) return `${Math.round(sec * 1000)} ms`;
  if (sec < 60) return `${sec.toFixed(1)} s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`;
}

export function fmtRate(hs) {
  if (hs === null || hs === undefined) return '—';
  if (hs < 1000) return `${Math.round(hs)} H/s`;
  if (hs < 1e6) return `${(hs / 1000).toFixed(1)} kH/s`;
  return `${(hs / 1e6).toFixed(2)} MH/s`;
}

export function txLabel(tx) {
  if (tx.type === 'COINBASE') return 'Mining reward';
  return '→ Transfer';
}

export function addrOrName(name, addr, shorten = true) {
  if (name && name !== 'NETWORK') return name;
  if (addr === 'NETWORK') return 'NETWORK';
  return shorten ? shortHash(addr || '—', 8, 6) : (addr || '—');
}

// ---- market formatting ----
export function fmtUsd(n, opts = {}) {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  const a = Math.abs(n);
  let s;
  if (a >= 1000) s = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  else if (a >= 1) s = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  else if (a >= 0.01) s = n.toFixed(4);
  else s = n.toFixed(6);
  return (opts.sign === false ? '' : '$') + s;
}

export function fmtPct(n, showSign = true) {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  const s = n >= 0 && showSign ? '+' : '';
  return `${s}${n.toFixed(2)}%`;
}

export function fmtCompact(n) {
  if (n === null || n === undefined || !isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}
