"""
PATHchain bot & market simulation engine — zero-dependency, stdlib only.

A transparent, clearly-labelled simulation (PATH is not traded anywhere real):

  * two in-memory limit-order books ("PATHchain DEX" and "PATH Secondary") —
    real price levels, real size per level, real matching with printed trades
  * bots drive both books:
      - trader bots     mean-reversion + momentum sizing
                          size = f(price deviation from EMA, recent momentum,
                                   user aggression)
      - arbitrage bots  watch the A/B spread and fire offsetting orders when
                          it exceeds a threshold
      - market makers   quote both sides around fair value and widen their
                          spread when volatility spikes
      - miner bots      run REAL SHA-256 proof-of-work against the actual
                          chain (same validation as human miners) — their
                          mining rate genuinely changes block frequency
  * market regimes (bull / bear / sideways / volatile / crash / pump) bias
    order flow so every regime looks and behaves differently
  * OHLCV candles aggregated at 2s / 10s / 60s / 300s buckets
  * config persists to data/market_config.json; every numeric value is
    clamped server-side so a bad payload can never poison the engine

All bot money lives in the engine's own in-memory inventory — the engine
never touches chain balances (the market page labels itself SIMULATED).
"""

import json
import math
import os
import random
import threading
import time

from . import blockchain as bcmod

# ----------------------------------------------------------------- clamps ----
CLAMPS = {
    "enabled": None,
    "bot_count": (0, 50, 12),
    "miners": (0, 20, 2),
    "buyers": (0, 20, 3),
    "sellers": (0, 20, 3),
    "arbitrageurs": (0, 20, 1),
    "makers": (0, 20, 2),
    "tick_ms": ((100, 250, 500, 1000), 250),
    "base_price": (0.05, 10000.0, 0.85),
    "volatility": (0.0, 100.0, 35.0),
    "aggression": (0.0, 1.0, 0.5),
    "regime": (["bullish", "bearish", "sideways", "volatile", "crash", "pump"], "sideways"),
    "bot_hashrate": (0.0, 100.0, 60.0),   # % throttle on miner-bot work
}
REGIMES = CLAMPS["regime"][0]

DEFAULT_CONFIG = {
    "enabled": True,
    "bot_count": 12,
    "miners": 2,
    "buyers": 3,
    "sellers": 3,
    "arbitrageurs": 1,
    "makers": 2,
    "tick_ms": 250,
    "base_price": 0.85,
    "volatility": 35.0,
    "aggression": 0.5,
    "regime": "sideways",
    "bot_hashrate": 60.0,
}

TICK = 0.0005            # order-book price granularity (USD)
LEVEL_CUSHION = 40       # how many levels a marketable order may sweep
BOOK_DEPTH_USD = 0.06    # passive liquidity half-spread as fraction of price
MM_BASE_SPREAD = 0.004   # maker spread around fair value
FEE = 0.0004             # arbitrage friction threshold


def clamp_config(raw):
    """Validate + clamp a partial config dict. Returns (clean, errors)."""
    clean, errors = {}, []
    for key, spec in CLAMPS.items():
        if key not in raw:
            continue
        val = raw[key]
        if key == "enabled":
            clean[key] = bool(val)
        elif key == "regime":
            if val in REGIMES:
                clean[key] = val
            else:
                errors.append(f"regime must be one of: {', '.join(REGIMES)}")
        elif key == "tick_ms":
            allowed = spec[0]
            try:
                v = int(val)
                clean[key] = v if v in allowed else spec[1]
            except (TypeError, ValueError):
                errors.append("tick rate must be one of 100/250/500/1000 ms")
        else:
            lo, hi, dflt = spec
            try:
                v = float(val)
                if not math.isfinite(v):
                    raise ValueError
                clean[key] = max(lo, min(hi, v))
            except (TypeError, ValueError):
                errors.append(f"{key} must be a number in [{lo}, {hi}]")
    return clean, errors


# --------------------------------------------------------------- order book --
class OrderBook:
    """Price-level limit order book. bids/asks: {price: size}."""

    def __init__(self, name):
        self.name = name
        self.bids = {}
        self.asks = {}
        self.lock = threading.RLock()

    def best_bid(self):
        return max(self.bids) if self.bids else None

    def best_ask(self):
        return min(self.asks) if self.asks else None

    def mid(self):
        with self.lock:
            b, a = self.best_bid(), self.best_ask()
            if b is not None and a is not None:
                return (b + a) / 2.0
            return b or a

    def add(self, side, price, size):
        """Rest a passive order. Price snaps to the tick grid."""
        price = round(round(price / TICK) * TICK, 6)
        if price <= 0 or size <= 0:
            return
        with self.lock:
            levels = self.bids if side == "bid" else self.asks
            levels[price] = levels.get(price, 0.0) + size

    def execute(self, side, size, slippage_levels=LEVEL_CUSHION):
        """Take liquidity: cross the spread for `size`. Returns
        (filled_size, avg_price, notional). side = the taker's side."""
        filled, notional = 0.0, 0.0
        with self.lock:
            levels = self.asks if side == "bid" else self.bids
            if not levels:
                return 0.0, None, 0.0
            prices = sorted(levels)[:slippage_levels] if side == "bid" else sorted(levels, reverse=True)[:slippage_levels]
            remaining = size
            for p in prices:
                if remaining <= 1e-9:
                    break
                avail = levels[p]
                take = min(avail, remaining)
                filled += take
                notional += take * p
                remaining -= take
                if take >= avail - 1e-12:
                    del levels[p]
                else:
                    levels[p] = avail - take
        return filled, (notional / filled if filled else None), notional

    def depth(self, n=14):
        with self.lock:
            bids = sorted(self.bids.items(), key=lambda kv: -kv[0])[:n]
            asks = sorted(self.asks.items(), key=lambda kv: kv[0])[:n]
            return {"bids": [[p, round(s, 2)] for p, s in bids],
                    "asks": [[p, round(s, 2)] for p, s in asks]}

    def seed(self, mid, depth_usd=BOOK_DEPTH_USD, steps=18):
        """Fill the book with passive liquidity around `mid` so the ladder
        and depth view are alive from the first second."""
        with self.lock:
            step = max(TICK, mid * depth_usd / steps)
            for i in range(1, steps + 1):
                size = random.uniform(40, 260) * (1 + i / 6.0)
                self.bids[round(mid - step * i, 6)] = size
                self.asks[round(mid + step * i, 6)] = size


BUCKET_SIZES = (2, 10, 60, 300)
BUCKET_KEEP = 420


class Candles:
    """Multi-resolution OHLCV aggregation over printed trades + mid closes."""

    def __init__(self):
        self.buckets = {s: [] for s in BUCKET_SIZES}   # dicts: t,o,h,l,c,v

    def update(self, ts, price, volume=0.0):
        for size in BUCKET_SIZES:
            slot = int(ts // size) * size
            arr = self.buckets[size]
            if arr and arr[-1]["t"] == slot:
                c = arr[-1]
                c["h"] = max(c["h"], price)
                c["l"] = min(c["l"], price)
                c["c"] = price
                c["v"] += volume
            else:
                if arr and slot > arr[-1]["t"] + size and arr[-1]["v"] == 0:
                    # gap filler keeps charts continuous across quiet stretches
                    gap_t = arr[-1]["t"] + size
                    while gap_t < slot and len(arr) < BUCKET_KEEP:
                        arr.append({"t": gap_t, "o": arr[-1]["c"], "h": arr[-1]["c"],
                                    "l": arr[-1]["c"], "c": arr[-1]["c"], "v": 0.0})
                        gap_t += size
                o = arr[-1]["c"] if arr else price
                arr.append({"t": slot, "o": o, "h": max(o, price),
                            "l": min(o, price), "c": price, "v": volume})
                if len(arr) > BUCKET_KEEP:
                    del arr[:len(arr) - BUCKET_KEEP]

    def series(self, size, limit=240):
        return [list(c.values()) for c in self.buckets.get(size, [])[-limit:]]


# ------------------------------------------------------------------ engine ---
class MarketEngine:
    """Two venues + bot roster + regime driver + tick loop."""

    def __init__(self, data_dir, events=None):
        self.lock = threading.RLock()
        self.events = events or (lambda kind, text: None)
        self.config = dict(DEFAULT_CONFIG)
        self.config_file = os.path.join(data_dir, "market_config.json")
        self._load_config()

        self.venue_a = OrderBook("PATHchain DEX")
        self.venue_b = OrderBook("PATH Secondary")
        self.candles = Candles()
        self.trades = []                      # newest first
        self.price = float(self.config["base_price"])
        self.open_24h = self.price
        self.day_anchor = time.time()
        self.vol_ref = self.price             # rolling reference for vol spikes
        self.ema = self.price
        self.momentum_hist = []
        self.trade_seq = 0
        self.version = 0
        self._frame = 0                 # SSE frame counter (drives candle cadence)
        self._last_housekeeping = 0.0   # economy safety-net timer
        self._wake = threading.Condition(self.lock)
        self._thread = None
        self._stop = threading.Event()
        self.subscribers = []                 # SSE push targets

        # bot identities (in-memory inventory, independent of chain balances)
        self.roster = []                      # [{id,type,name,cash,inv,seed}]
        self._build_roster()
        # 24h anchor starts slightly off spot so the day-change stat is alive
        # from the first second (labelled simulation; becomes real after 24h)
        self.open_24h = self.price * (1 + random.uniform(-0.035, 0.055))
        self.day_anchor = time.time()
        self.venue_a.seed(self.price)
        self.venue_b.seed(self.price * (1 + random.uniform(-0.004, 0.004)))

        self._regime_state = {"ticks_left": 0}

    # ------------------------------------------------------------- config ----
    def _load_config(self):
        try:
            with open(self.config_file, "r", encoding="utf-8") as f:
                raw = json.load(f)
            clean, _err = clamp_config(raw)
            self.config.update(clean)
        except (OSError, ValueError):
            pass

    def _save_config(self):
        tmp = self.config_file + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.config, f, indent=1)
            os.replace(tmp, self.config_file)
        except OSError:
            pass

    def update_config(self, partial):
        clean, errors = clamp_config(partial)
        with self.lock:
            restart_tick = any(k in clean for k in ("tick_ms",)) and clean.get("tick_ms") != self.config.get("tick_ms")
            reseed = any(k in clean and clean[k] != self.config.get(k)
                         for k in ("base_price", "bot_count", "miners", "buyers", "sellers",
                                   "arbitrageurs", "makers"))
            self.config.update(clean)
            self._save_config()
            if "regime" in clean:
                self._regime_state = {"ticks_left": 0}
            if reseed and clean.get("bot_count") is not None:
                self._build_roster()
            if "base_price" in clean:
                self.price = float(clean["base_price"])
                self.ema = self.price
                self.vol_ref = self.price
                self.open_24h = self.price
                self.venue_a.seed(self.price)
                self.venue_b.seed(self.price)
            self._wake.notify_all()
        self.events("market", "Bot engine config updated: " +
                    ", ".join(f"{k}={v}" for k, v in clean.items()))
        if restart_tick:
            self._ensure_thread()
        return {"ok": True, "config": self.view_config(), "errors": errors}

    def view_config(self):
        with self.lock:
            return dict(self.config)

    # -------------------------------------------------------------- roster ---
    def _build_roster(self):
        cfg = self.config
        total = int(cfg["bot_count"])
        weights = [("miner", int(cfg["miners"])), ("buyer", int(cfg["buyers"])),
                   ("seller", int(cfg["sellers"])), ("arb", int(cfg["arbitrageurs"])),
                   ("maker", int(cfg["makers"]))]
        wsum = sum(w for _t, w in weights)
        if total <= 0:
            self.roster = []
            return
        if total <= wsum:
            # user asked for fewer bots than the mix specifies — keep the
            # requested types in priority order (miner first, then book shape)
            want, left = {}, total
            for t, w in weights:
                want[t] = min(w, left)
                left -= want[t]
        else:
            # largest-remainder apportionment: the roster ALWAYS sums to
            # exactly bot_count (naive rounding silently loses bots, e.g.
            # 12 requested -> 11 active)
            raw = [(t, total * w / wsum) for t, w in weights]
            want = {t: int(v) for t, v in raw}
            short = total - sum(want.values())
            fracs = sorted(raw, key=lambda tv: tv[1] - int(tv[1]), reverse=True)
            for i in range(short):
                want[fracs[i % len(fracs)][0]] += 1
        roster, n = [], 0
        for t, _w in weights:
            for i in range(want.get(t, 0)):
                n += 1
                roster.append({
                    "id": f"bot-{n:02d}", "type": t, "name": f"BOT-{t.upper()}-{i + 1:02d}",
                    "cash": 25000.0 * random.uniform(0.6, 1.6),
                    "inv": 30000.0 * random.uniform(0.6, 1.6),
                    "eff": random.uniform(0.55, 1.45),   # per-bot efficiency
                })
        # wealth reference for the re-capitalisation loop: without it, directional
        # flow slowly transfers every bot's cash to whoever holds inventory and
        # the market dies mid-exhibition (verified: price once drifted to $0.01)
        for b in roster:
            b["seed_wealth"] = b["cash"] + b["inv"] * max(1e-9, self.price)
        self.roster = roster

    def bot_counts(self):
        with self.lock:
            counts = {"miner": 0, "buyer": 0, "seller": 0, "arb": 0, "maker": 0}
            for b in self.roster:
                counts[b["type"]] = counts.get(b["type"], 0) + 1
            counts["active"] = sum(counts.values()) if self.config.get("enabled") else 0
            return counts

    # --------------------------------------------------------------- trades --
    def _print_trade(self, venue, side, price, size, ts=None):
        ts = ts or time.time()
        self.trade_seq += 1
        self.trades.insert(0, {"id": self.trade_seq, "t": round(ts, 3), "venue": venue,
                               "side": side, "price": round(price, 6), "size": round(size, 2)})
        del self.trades[60:]
        self.candles.update(ts, price, size)
        self.price = price

    # ---------------------------------------------------------------- tick ---
    def _ensure_thread(self):
        with self.lock:
            if self._thread and self._thread.is_alive():
                return
            self._stop.clear()
            self._thread = threading.Thread(target=self._loop, name="MarketEngine", daemon=True)
            self._thread.start()

    def start(self):
        self._ensure_thread()

    def stop(self):
        self._stop.set()
        with self.lock:
            self._wake.notify_all()

    def _loop(self):
        while not self._stop.is_set():
            with self.lock:
                interval = max(0.05, float(self.config.get("tick_ms", 250)) / 1000.0)
                self._wake.wait(timeout=interval)
            if self._stop.is_set():
                break
            try:
                self.tick()
            except Exception as exc:                      # never let a bot kill the market
                self.events("market", f"engine tick recovered from: {exc}")

    def tick(self):
        with self.lock:
            cfg = self.config
            if not cfg.get("enabled"):
                return
            ts = time.time()
            regime = cfg["regime"]
            vol = max(1.0, float(cfg["volatility"])) / 100.0
            aggression = float(cfg["aggression"])

            # ---- regime pressure -------------------------------------------
            drift, sigma, spread_mult = self._regime_params(regime, vol)
            self._regime_state["ticks_left"] = max(0, self._regime_state["ticks_left"] - 1)
            if regime in ("crash", "pump") and self._regime_state["ticks_left"] == 0:
                cfg["regime"] = "sideways"
                self.events("market", f"{regime.capitalize()} event exhausted — regime returned to sideways")

            # ---- reference series ------------------------------------------
            mid = self.venue_a.mid() or self.price
            self.price = mid
            self.ema += (mid - self.ema) * 0.08
            self.momentum_hist.append(mid)
            if len(self.momentum_hist) > 24:
                self.momentum_hist.pop(0)
            rets = (mid - self.vol_ref) / max(1e-9, self.vol_ref)
            if abs(rets) > 0.004:
                self.vol_ref = self.vol_ref + (mid - self.vol_ref) * 0.25

            # ---- bots act ---------------------------------------------------
            for bot in self.roster:
                try:
                    if bot["type"] == "buyer":
                        self._bot_directional(bot, +1, drift, sigma, aggression, ts)
                    elif bot["type"] == "seller":
                        self._bot_directional(bot, -1, drift, sigma, aggression, ts)
                    elif bot["type"] == "maker":
                        self._bot_maker(bot, sigma, spread_mult, ts)
                    elif bot["type"] == "arb":
                        self._bot_arb(bot, ts)
                except Exception:
                    continue

            # ---- background liquidity ----------------------------------------
            # takers consume resting orders; passive providers constantly put
            # new size back — otherwise one aggressive burst empties the book
            self._top_up_books()

            # ---- economy housekeeping ----------------------------------------
            self._housekeeping(ts, mid)

            # ---- close-out ---------------------------------------------------
            mid = self.venue_a.mid() or self.price
            self.candles.update(ts, mid, 0.0)
            if ts - self.day_anchor > 86400:
                self.day_anchor = ts
                self.open_24h = mid
            self.version += 1
            self._frame += 1
            subs = list(self.subscribers)
            # candle arrays are ~85% of the snapshot payload but barely change
            # between ticks — ship them ~1x/second, not at the raw tick rate,
            # so 30 phones on the school Wi-Fi each pull ~4 KB/frame instead
            # of ~24 KB (the client caches candles between full frames)
            every = max(1, int(round(1000.0 / max(50.0, float(self.config.get("tick_ms", 250))))))
            with_candles = (self._frame % every == 0)
        snap = None
        for fn in subs:
            try:
                snap = snap or self.public_view(with_candles=with_candles)
                fn(snap)
            except Exception:
                continue

    def _housekeeping(self, ts, mid):
        """Two safety nets that keep a hours-long exhibition session alive:
        1) re-capitalise drained bots — read as 'new participants enter the
           market', which is exactly what real venues experience;
        2) re-anchor the books if the price ever escapes its sanity band
           (defensive; should be unreachable with (1) in place)."""
        if ts - self._last_housekeeping < 30.0:
            return
        self._last_housekeeping = ts
        base = float(self.config.get("base_price", 0.85)) or 0.85
        recap = 0
        for b in self.roster:
            wealth = b["cash"] + b["inv"] * max(1e-9, mid)
            seed = b.get("seed_wealth") or 1.0
            if wealth < seed * 0.35:
                target = seed * 0.65
                if mid > 1e-9 and (target - wealth) / mid > 0:
                    # split the top-up: half fresh cash, half fresh inventory
                    b["cash"] += (target - wealth) * 0.5
                    b["inv"] += (target - wealth) * 0.5 / mid
                else:
                    b["cash"] += target - wealth
                recap += 1
        if recap:
            self.events("market", f"{recap} bot(s) re-capitalised — new participants entered the market")
        if not (base * 0.05 <= mid <= base * 20.0):
            self.price = self.ema = self.vol_ref = base
            self.venue_a.bids.clear(); self.venue_a.asks.clear()
            self.venue_b.bids.clear(); self.venue_b.asks.clear()
            self.venue_a.seed(base); self.venue_b.seed(base)
            self.events("market", "Order books re-anchored to base price — liquidity restored")

    def _top_up_books(self):
        """Keep both books deep: probabilistically re-add passive size at the
        standard ladder levels around the current mid."""
        for venue in (self.venue_a, self.venue_b):
            mid = venue.mid() or self.price
            step = max(TICK, mid * BOOK_DEPTH_USD / 18)
            for i in range(1, 14):
                bp = round(mid - step * i, 6)
                ap = round(mid + step * i, 6)
                if bp not in venue.bids and random.random() < 0.6:
                    venue.bids[bp] = random.uniform(30, 240)
                if ap not in venue.asks and random.random() < 0.6:
                    venue.asks[ap] = random.uniform(30, 240)

    def _regime_params(self, regime, vol):
        if regime == "bullish":
            return 0.00035, 0.0009 * vol, 1.0
        if regime == "bearish":
            return -0.00035, 0.0011 * vol, 1.1
        if regime == "volatile":
            return 0.0, 0.0042 * vol, 1.8
        if regime == "crash":
            if self._regime_state["ticks_left"] == 0:
                self._regime_state["ticks_left"] = int(48 / max(0.1, self.config["tick_ms"] / 1000.0))
                self.events("market", "CRASH event started — sell pressure flooding both venues")
            return -0.0022, 0.0038 * vol, 2.2
        if regime == "pump":
            if self._regime_state["ticks_left"] == 0:
                self._regime_state["ticks_left"] = int(48 / max(0.1, self.config["tick_ms"] / 1000.0))
                self.events("market", "PUMP event started — buy pressure flooding both venues")
            return 0.0024, 0.0032 * vol, 1.9
        return 0.0, 0.0006 * vol, 1.0          # sideways

    # ---- strategy: mean-reversion + momentum directional bots ---------------
    def _bot_directional(self, bot, direction, drift, sigma, aggression, ts):
        hist = self.momentum_hist
        mid = self.venue_a.mid() or self.price
        if len(hist) < 6:
            return
        deviation = (mid - self.ema) / max(1e-9, self.ema)          # mean reversion signal
        momentum = (mid - hist[-8]) / max(1e-9, hist[-8])           # trend signal
        theta = 0.004 / max(0.15, aggression)
        score = 0.0
        if direction > 0:      # buyer
            score += -deviation / theta if deviation < 0 else momentum * 18 * aggression
        else:                  # seller
            score += deviation / theta if deviation > 0 else -momentum * 18 * aggression
        score += (drift / max(1e-6, sigma)) * 0.6                    # regime alignment
        # idiosyncratic flow: real order flow is never purely signal-driven —
        # random impulses keep the book alive and give the signals something
        # to mean-revert FROM (this is what bootstraps price discovery)
        noise_scale = 0.35 + 6.0 * sigma
        score += random.gauss(0.0, noise_scale)
        if random.random() < 0.05 + 0.10 * aggression:
            score += 0.35                       # occasional impatient order
        if score <= 0.12:
            return                                                   # no edge — stay flat
        # order size = f(deviation, momentum, aggression, bot efficiency)
        size = min(bot["inv"] if direction < 0 else bot["cash"] / mid,
                   120.0 * bot["eff"] * (0.5 + aggression) * min(3.0, score))
        if size < 1.0:
            return
        slip = 3 + int(aggression * 10)
        venue = self.venue_a if random.random() < 0.78 else self.venue_b
        filled, px, _notional = venue.execute("bid" if direction > 0 else "ask", size, slip)
        if filled > 0 and px:
            if direction > 0:
                bot["cash"] -= filled * px
                bot["inv"] += filled
            else:
                bot["inv"] -= filled
                bot["cash"] += filled * px
            self._print_trade(venue.name, "buy" if direction > 0 else "sell", px, filled, ts)

    # ---- strategy: market maker ---------------------------------------------
    def _bot_maker(self, bot, sigma, spread_mult, ts):
        fair = self.ema
        vol_spike = abs((self.venue_a.mid() or fair) - self.vol_ref) / max(1e-9, self.vol_ref)
        spread = max(2 * TICK, fair * (MM_BASE_SPREAD + 2.2 * vol_spike) * spread_mult)
        quote = min(90.0, 45.0 * bot["eff"]) * (1 + 2.0 * sigma)
        # refresh: cancel (rebuild side) then requote — keeps quotes near fair
        a, b = self.venue_a, self.venue_b
        for venue in (a, b):
            best_b, best_a = venue.best_bid(), venue.best_ask()
            # market makers own the closest levels; clearing them re-anchors the book
            if best_b is not None and abs(best_b - (fair - spread)) < spread:
                venue.bids.pop(best_b, None)
            if best_a is not None and abs(best_a - (fair + spread)) < spread:
                venue.asks.pop(best_a, None)
            venue.add("bid", fair - spread, quote)
            venue.add("ask", fair + spread, quote * random.uniform(0.8, 1.2))

    # ---- strategy: arbitrage between venue A and venue B ---------------------
    def _bot_arb(self, bot, ts):
        ma, mb = self.venue_a.mid(), self.venue_b.mid()
        if ma is None or mb is None:
            return
        spread = (mb - ma) / ma
        if abs(spread) < FEE * 3:
            return
        size = min(140.0 * bot["eff"], 60.0 + abs(spread) * 6000.0)
        if spread > 0:      # B richer: buy A, sell B
            f1, p1, _ = self.venue_a.execute("bid", size, 12)
            f2, p2, _ = self.venue_b.execute("ask", f1, 12)
        else:               # A richer: buy B, sell A
            f1, p1, _ = self.venue_b.execute("bid", size, 12)
            f2, p2, _ = self.venue_a.execute("ask", f1, 12)
        if f2 > 0 and p2:
            self._print_trade("PATH Secondary" if spread > 0 else "PATHchain DEX", "sell", p2, f2, ts)
            bot["cash"] += (p2 - p1) * f2

    # -------------------------------------------------------------- public ---
    def public_view(self, chain_stats=None, with_candles=True):
        with self.lock:
            mid = self.venue_a.mid() or self.price
            c300 = self.candles.buckets[300]
            vol24 = sum(c["v"] for c in c300[-288:])
            hi24 = max((c["h"] for c in c300[-288:]), default=mid)
            lo24 = min((c["l"] for c in c300[-288:]), default=mid)
            ref = c300[-288]["c"] if len(c300) >= 289 else self.open_24h
            chg = (mid / ref - 1.0) * 100.0 if ref else 0.0
            regime = self.config["regime"]
            counts = self.bot_counts()
            out = {
                "ts": round(time.time(), 3),
                "version": self.version,
                "engine": "bots",
                "enabled": bool(self.config.get("enabled")),
                "price": round(mid, 6),
                "chg24h": round(chg, 2),
                "high24": round(hi24, 6),
                "low24": round(lo24, 6),
                "vol24": round(vol24, 2),
                "regime": regime,
                "bots": counts,
                "venues": {
                    "a": {"name": self.venue_a.name, "mid": _r(self.venue_a.mid()),
                          "best_bid": _r(self.venue_a.best_bid()), "best_ask": _r(self.venue_a.best_ask()),
                          "depth": self.venue_a.depth(14)},
                    "b": {"name": self.venue_b.name, "mid": _r(self.venue_b.mid()),
                          "best_bid": _r(self.venue_b.best_bid()), "best_ask": _r(self.venue_b.best_ask()),
                          "depth": self.venue_b.depth(10)},
                },
                "spread_ab": _pct(self.venue_a.mid(), self.venue_b.mid()),
                "trades": self.trades[:24],
                "supply": (chain_stats or {}).get("supply"),
            }
            if with_candles:
                out["candles"] = {str(s): self.candles.series(s, 240) for s in BUCKET_SIZES}
            return out

    def candle_tail(self, bucket):
        bucket = int(bucket) if int(bucket) in BUCKET_SIZES else 10
        with self.lock:
            return self.candles.series(bucket, 240)

    def stats_view(self):
        with self.lock:
            return {
                "price": round(self.venue_a.mid() or self.price, 6),
                "regime": self.config["regime"],
                "bots": self.bot_counts(),
                "tick_ms": self.config.get("tick_ms"),
                "version": self.version,
            }


def _r(v):
    return round(v, 6) if v is not None else None


def _pct(a, b):
    if not a or not b:
        return None
    return round((b - a) / a * 100.0, 4)


# ----------------------------------------------------------- bot miners ------
class BotMinerPool:
    """Runs REAL SHA-256 proof-of-work on the live chain under rotating bot
    wallets. Mining rate scales with the number of miner bots and the user
    throttle — it genuinely changes how often blocks are produced."""

    BATCH = 1200            # hash attempts per pass (Python-speed friendly)

    def __init__(self, chain, engine, node, events=None):
        self.chain = chain
        self.engine = engine
        self.node = node
        self.events = events or (lambda kind, text: None)
        self.lock = threading.RLock()
        self.template = None
        self.prefix = None
        self.stop_event = threading.Event()
        self.thread = None
        self.blocks_found = 0
        self.last_tip = None
        self._bot_seq = 0

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._run, name="BotMiners", daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()

    def _pick_miner(self):
        with self.engine.lock:
            names = [b["name"] for b in self.engine.roster if b["type"] == "miner"]
        if not names:
            return None
        return random.choice(names)

    def _bot_wallet(self, name):
        """Get-or-create the on-chain wallet a bot miner mines into."""
        with self.chain.lock:
            w = self.chain.wallets.get(name)
            if w is None:
                w, _msg = self.chain.add_wallet(name)
                if w is None:
                    return None
                self.chain.wallets[name].is_bot = True
            return w

    def _new_template(self, name):
        wallet = self._bot_wallet(name)
        if wallet is None:
            return False
        with self.chain.lock:
            self.template = self.chain.build_template(wallet.name, wallet.address)
            self.prefix = bcmod.header_prefix(self.template)
        self.last_tip = self.chain.chain[-1]["hash"]
        return True

    def _run(self):
        while not self.stop_event.is_set():
            try:
                self._run_once()
            except Exception as exc:
                with self.lock:
                    self.template = None
                self.events("market", f"bot miner recovered from: {exc}")
                self.stop_event.wait(0.5)

    def _run_once(self):
        cfg = self.engine.view_config()
        if not cfg.get("enabled"):
            self.stop_event.wait(0.5)
            return
        counts = self.engine.bot_counts()
        n_miners = counts.get("miner", 0)
        if n_miners <= 0:
            self.stop_event.wait(0.5)
            return
        if self.chain.first_bad_index() is not None:
            self.stop_event.wait(1.0)                # a real miner stops on a tampered chain
            return
        tip = self.chain.chain[-1]
        if self.template is None or self.last_tip != tip["hash"]:
            name = self._pick_miner()
            if not name or not self._new_template(name):
                self.stop_event.wait(0.5)
                return
        # throttle: batch per pass scales with miner count and user hashrate %
        batch = max(50, int(self.BATCH * n_miners * float(cfg.get("bot_hashrate", 60)) / 100.0))
        template, prefix = self.template, self.prefix
        start_nonce = template.get("nonce", 0)
        bits = template["bits"]
        found = None
        for offset in range(batch):
            if self.template is not template:
                return                                # tip changed mid-pass
            nonce = start_nonce + offset
            h = bcmod.hash_with_nonce(prefix, nonce)
            if bcmod.meets_target(h, bits):
                found = (nonce, h)
                break
        if found:
            self._win(template, *found)
            return
        with self.lock:
            if self.template is template:
                template["nonce"] = start_nonce + batch
        self.stop_event.wait(0.02)

    def _win(self, template, nonce, hash_value):
        block = self.chain.finalize_block(template, nonce, hash_value)
        ok, reason = self.chain.validate_block(block, self.chain.chain[-1])
        if not ok:
            with self.lock:
                self.template = None
            return
        self.chain.apply_block(block)
        with self.lock:
            self.template = None
            self.blocks_found += 1
        self.node.broadcast({"type": "NEW_BLOCK", "block": block,
                             "node_id": self.node.node_id, "name": self.node.name})
        self.events("mine", f"BOT MINER block #{block['index']} — {block.get('miner')} solved "
                            f"{block['bits']} zeros at nonce {nonce:,} (+{bcmod.MINING_REWARD} PATH)")
