"""
PATHchain web server — serves the explorer UI (vanilla static files) and the
JSON API that powers it. Every number on the site comes from these endpoints —
there is no mock data anywhere in the project.
"""

import json
import mimetypes
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

from . import crypto
from . import blockchain as bcmod
from .blockchain import COIN_NAME, MINING_REWARD, TARGET_BLOCK_TIME
from .node import local_interface_details

MAX_SSE_CLIENTS = 32

STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")


def make_handler(app):
    class Handler(BaseHTTPRequestHandler):
        server_version = "PATHchain/1.0"

        # ------------------------------------------------------------ helpers ----
        def log_message(self, fmt, *args):
            pass  # keep the console clean

        def _json(self, obj, status=200):
            body = json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _ok(self, data=None):
            self._json({"ok": True, "data": data})

        def _err(self, message, status=400):
            self._json({"ok": False, "error": str(message)}, status)

        def _body(self):
            length = int(self.headers.get("Content-Length", 0) or 0)
            if not length:
                return {}
            if length > 1024 * 1024:          # sanity cap — no client needs more
                self.rfile.read(length)
                return {}
            try:
                return json.loads(self.rfile.read(length).decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                return {}

        def _static(self, path):
            if path in ("/", ""):
                path = "/index.html"
            clean = os.path.normpath(unquote(path)).lstrip("/\\")
            full = os.path.join(STATIC_DIR, clean)
            if not os.path.abspath(full).startswith(os.path.abspath(STATIC_DIR)) or not os.path.isfile(full):
                full = os.path.join(STATIC_DIR, "index.html")  # SPA fallback
                if not os.path.isfile(full):
                    return self._err("Not found", 404)
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
                ctype += "; charset=utf-8"
            with open(full, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            # always fresh: a PC may have an old tab open from yesterday
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _sse(self):
            """Server-Sent Events: the market snapshot streams at the bot tick
            rate (100ms–1s). Plain HTTP that EventSource understands — zero
            dependencies. The client falls back to polling if this fails."""
            engine = app.market
            if engine is None:
                return self._err("Market engine not wired", 503)
            with engine.lock:
                if len(engine.subscribers) >= MAX_SSE_CLIENTS:
                    return self._err("Too many live streams on this node", 503)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            wlock = threading.Lock()
            supply_cache = {"v": None, "t": 0.0}

            def push(snap):
                # the market page derives market cap from supply — the engine
                # doesn't know chain balances, so enrich frames here (cheap:
                # balances are per-tip cached, refreshed every 5s)
                now = time.time()
                if now - supply_cache["t"] > 5.0:
                    supply_cache["t"] = now
                    try:
                        bal, _txs = app._cached_chain_totals()
                        supply_cache["v"] = sum(bal.values())
                    except Exception:
                        pass
                if supply_cache["v"] is not None:
                    snap = dict(snap)
                    snap["supply"] = supply_cache["v"]
                data = json.dumps(snap, separators=(",", ":"))
                with wlock:
                    self.wfile.write(f"event: market\ndata: {data}\n\n".encode("utf-8"))
                    self.wfile.flush()

            try:
                self.wfile.write(b"retry: 2000\n\n")
                engine.subscribers.append(push)
                push(engine.public_view())            # first frame immediately
                while True:
                    time.sleep(5.0)
                    with wlock:
                        self.wfile.write(b": heartbeat\n\n")
                        self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError, ValueError):
                pass
            finally:
                try:
                    engine.subscribers.remove(push)
                except (ValueError, AttributeError):
                    pass

        # ------------------------------------------------------------ routing ----
        def do_GET(self):
            try:
                self._route_get()
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as exc:
                try:
                    self._err(f"Server error: {exc}", 500)
                except Exception:
                    pass

        def do_POST(self):
            try:
                self._route_post()
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as exc:
                try:
                    self._err(f"Server error: {exc}", 500)
                except Exception:
                    pass

        def _route_get(self):
            url = urlparse(self.path)
            path, q = url.path, parse_qs(url.query)
            chain, node, miner = app.chain, app.node, app.miner

            if not path.startswith("/api/"):
                return self._static(path)

            route = path[len("/api/"):]

            if route == "state":
                return self._ok(app.full_state())

            if route == "blocks":
                limit = min(50, max(1, int(q.get("limit", [20])[0])))
                offset = max(0, int(q.get("offset", [0])[0]))
                return self._ok(app.blocks_page(offset, limit))

            if route.startswith("block/"):
                ref = unquote(route[len("block/"):])
                detail = app.block_detail(ref)
                if isinstance(detail, dict) and detail.get("error"):
                    return self._err(detail["error"])     # proper 400, not ok:true
                return self._ok(detail)

            if route.startswith("tx/"):
                detail = app.tx_detail(unquote(route[len("tx/"):]))
                if isinstance(detail, dict) and detail.get("error"):
                    return self._err(detail["error"])
                return self._ok(detail)

            if route.startswith("address/"):
                return self._ok(app.address_detail(unquote(route[len("address/"):])), )

            if route == "wallets":
                return self._ok(app.wallets_view())

            if route.startswith("wallet/") and route.endswith("/keys"):
                name = unquote(route[len("wallet/"):-len("/keys")])
                keys = app.wallet_keys(name)
                if isinstance(keys, dict) and keys.get("error"):
                    return self._err(keys["error"])
                return self._ok(keys)

            if route == "mine/status":
                return self._ok(miner.status())

            if route == "stats_series":
                return self._ok(app.stats_series())

            if route == "peers":
                return self._ok({"connected": node.peer_view(),
                                 "discovered": node.discovered_view(),
                                 "self": app.self_view()})

            if route == "events":
                with node.lock:
                    return self._ok({"events": list(node.event_log)[:40]})

            if route == "search":
                query = (q.get("q", [""])[0] or "").strip()
                return self._ok(app.search(query))

            if route == "poll":
                with node.lock:
                    return self._ok({"poll": dict(node.poll) if node.poll else None,
                                     "node_id": node.node_id})

            if route == "market":
                if app.market is None:
                    return self._err("Market engine not wired", 503)
                stats = app._stats(app.chain.compute_balances(), 0, len(node.peers))
                return self._ok(app.market.public_view(chain_stats=stats))

            if route.startswith("market/candles"):
                bucket = q.get("bucket", ["10"])[0]
                return self._ok({"bucket": bucket, "candles": app.market.candle_tail(bucket)})

            if route == "bots":
                if app.market is None:
                    return self._err("Market engine not wired", 503)
                return self._ok({
                    "config": app.market.view_config(),
                    "counts": app.market.bot_counts(),
                    "miner": {"blocks_found": app.bot_miners.blocks_found if app.bot_miners else 0,
                              "running": bool(app.bot_miners and app.bot_miners.thread and app.bot_miners.thread.is_alive())},
                })

            if route == "ping":
                return self._ok({"ts": time.time(), "name": node.name})

            if route == "stream":
                return self._sse()

            return self._err("Unknown endpoint", 404)

        def _route_post(self):
            url = urlparse(self.path)
            route = url.path[len("/api/"):]
            body = self._body()
            chain, node, miner = app.chain, app.node, app.miner

            if route == "wallet":
                name = str(body.get("name", "")).strip()
                wallet, message = chain.add_wallet(name)
                if wallet:
                    node.log_event("wallet", f"Wallet '{name}' created — address {wallet.address}")
                    app.broadcast_state()
                    return self._ok({"name": wallet.name, "address": wallet.address, "message": message})
                return self._err(message)

            if route == "send":
                result = app.send_path(body)
                if result.get("ok"):
                    return self._ok(result)
                return self._err(result.get("error", "could not send"))

            if route == "mine":
                action = body.get("action", "")
                if action == "start":
                    if miner.mode == "auto":
                        return self._ok({"mode": "auto"})
                    miner.set_mode("auto")
                elif action == "stop":
                    miner.set_mode("idle")
                elif action == "step":
                    if miner.mode == "auto":
                        return self._err("Manual step is locked while AUTO-MINING is on.")
                    res = miner.step(int(body.get("attempts", 1) or 1))
                    return self._ok(res)
                return self._ok({"mode": miner.mode})

            if route == "peer/connect":
                ok, message = node.connect_to(body.get("target", ""))
                return (self._ok({"message": message}) if ok else self._err(message))

            if route == "demo/tamper":
                idx = body.get("index")
                try:
                    idx = int(idx) if idx is not None else None
                except (TypeError, ValueError):
                    idx = None
                ok, message = node.tamper_tip(str(body.get("note", "manual tamper simulation")), index=idx)
                return (self._ok({"message": message}) if ok else self._err(message))

            if route == "demo/rollback":
                ok, message = node.rollback_to_valid()
                return (self._ok({"message": message}) if ok else self._err(message))

            if route == "bots/config":
                if app.market is None:
                    return self._err("Market engine not wired", 503)
                result = app.market.update_config(body.get("config", body))
                cfg = app.market.view_config()
                if app.bot_miners:
                    if cfg.get("enabled") and int(cfg.get("miners", 0)) > 0:
                        app.bot_miners.start()
                    else:
                        app.bot_miners.stop()
                return self._ok(result)

            if route == "bots/toggle":
                if app.market is None:
                    return self._err("Market engine not wired", 503)
                result = app.market.update_config({"enabled": bool(body.get("enabled", True))})
                cfg = app.market.view_config()
                if app.bot_miners:
                    if cfg.get("enabled") and int(cfg.get("miners", 0)) > 0:
                        app.bot_miners.start()
                    else:
                        app.bot_miners.stop()
                return self._ok(result)

            if route == "poll/vote":
                ok, message = node.cast_vote(bool(body.get("vote", True)))
                return (self._ok({"message": message}) if ok else self._err(message))

            if route == "reset_vote_ui":
                with node.lock:
                    if node.poll and node.poll.get("closed"):
                        node.poll = None
                return self._ok()

            return self._err("Unknown endpoint", 404)

    return Handler


class App:
    """Wires blockchain + miner + node + market engine and builds every API payload."""

    def __init__(self, chain, miner, node, market=None, bot_miners=None):
        self.chain = chain
        self.miner = miner
        self.node = node
        self.market = market
        self.bot_miners = bot_miners
        self._stats_cache_key = None
        self._stats_cache = None        # ((balances, total_txs), expires_at)

    def _cached_chain_totals(self):
        """compute_balances() replays the whole chain — with 30 visitors polling
        /api/state every second this MUST not run per request. Cache keyed by
        (tip hash, epoch, mempool size) with a 2s TTL for safety."""
        with self.chain.lock:
            key = (self.chain.chain[-1]["hash"], self.chain.chain_epoch, len(self.chain.mempool))
        now = time.time()
        if self._stats_cache_key == key and self._stats_cache and self._stats_cache[1] > now:
            return self._stats_cache[0]
        with self.chain.lock:
            balances = self.chain.compute_balances()
            total_txs = sum(len(b.get("txs", [])) - 1 for b in self.chain.chain) + len(self.chain.mempool)
        self._stats_cache_key = key
        self._stats_cache = ((balances, total_txs), now + 2.0)
        return self._stats_cache[0]

    _print_lock = threading.Lock()

    def log(self, kind, text):
        with self._print_lock:
            print(f"[{time.strftime('%H:%M:%S')}] [{kind}] {text}", flush=True)

    def broadcast_state(self):
        snap = self.chain.state_snapshot("FULL_SYNC")
        snap["node_id"], snap["name"] = self.node.node_id, self.node.name
        self.node.broadcast(snap)

    # ------------------------------------------------------------- payloads ----
    def self_view(self):
        c = self.chain
        with c.lock:
            bad = c.first_bad_index()
            tip = c.chain[-1]
            return {
                "name": self.node.name, "node_id": self.node.node_id,
                "ips": [ip for _n, ip in local_interface_details()],
                "http_port": self.node.http_port, "tcp_port": self.node.tcp_port,
                "udp_port": self.node.udp_port, "epoch": c.chain_epoch,
                "height": tip["index"], "tip_hash": tip["hash"],
                "bits": tip.get("bits", 3), "target_block_time": TARGET_BLOCK_TIME,
                "mining_reward": MINING_REWARD, "currency": COIN_NAME,
                "compromised": bad is not None, "bad_index": bad,
                "mempool_size": len(c.mempool), "wallet_count": len(c.wallets),
            }

    def _tx_brief(self, tx, height=None, confirmations=None):
        return {
            "txid": tx.get("txid"), "type": tx.get("type"),
            "from_name": tx.get("from_name"), "from_addr": tx.get("from_addr"),
            "to_name": tx.get("to_name"), "to_addr": tx.get("to_addr"),
            "amount": tx.get("amount"), "timestamp": tx.get("timestamp"),
            "height": height, "confirmations": confirmations,
        }

    def full_state(self):
        c = self.chain
        selfv = self.self_view()
        with c.lock:
            chain = c.chain
            tip = chain[-1]
            latest_blocks = []
            for b in reversed(chain[-8:]):
                latest_blocks.append({
                    "height": b["index"], "hash": b["hash"], "ts": b["timestamp"],
                    "txs": len(b.get("txs", [])), "miner": b.get("miner"),
                    "bits": b.get("bits"), "nonce": b.get("nonce"),
                    "size": len(crypto.canonical_json(b)),
                    "confirmations": tip["index"] - b["index"] + 1,
                })
            latest_txs = []
            for b in reversed(chain[-6:]):
                for tx in reversed(b.get("txs", [])):
                    latest_txs.append(self._tx_brief(tx, b["index"], tip["index"] - b["index"] + 1))
                    if len(latest_txs) >= 9:
                        break
                if len(latest_txs) >= 9:
                    break
            mempool_txs = [self._tx_brief(t) for t in list(c.mempool.values())[:6]]
        balances, total_txs = self._cached_chain_totals()
        with self.node.lock:
            poll = dict(self.node.poll) if self.node.poll else None
            if poll:
                poll["is_eligible"] = self.node.node_id in poll.get("eligible_voters", [])
            peers_n = len(self.node.peers)
        stats = self._stats(balances, total_txs, peers_n)
        market_brief = None
        if self.market is not None:
            try:
                market_brief = self.market.stats_view()
            except Exception:
                market_brief = None
        return {
            "self": selfv, "stats": stats,
            "latest_blocks": latest_blocks, "latest_txs": latest_txs,
            "mempool_preview": mempool_txs, "poll": poll, "node_id": self.node.node_id,
            "market": market_brief,
        }

    def _stats(self, balances, total_txs, peers_n):
        c = self.chain
        chain = c.chain
        recent = chain[-11:]
        intervals = [max(0.0, recent[i]["timestamp"] - recent[i - 1]["timestamp"])
                     for i in range(1, len(recent))
                     if recent[i]["timestamp"] > 0 and recent[i - 1]["timestamp"] > 0]
        avg_interval = round(sum(intervals) / len(intervals), 2) if intervals else None
        supply = sum(balances.values())
        bits = chain[-1].get("bits", 3)
        est_hashrate = (16 ** bits) / max(1.0, avg_interval or TARGET_BLOCK_TIME)
        return {
            "height": chain[-1]["index"], "supply": supply,
            "wallets_known": len(balances), "total_txs": max(0, total_txs),
            "mempool": len(c.mempool), "peers": peers_n,
            "bits": bits, "difficulty": 16 ** bits,
            "avg_block_time": avg_interval,
            "network_hashrate_est": round(est_hashrate, 1),
            "next_bits": c.next_difficulty(),
            "currency": COIN_NAME, "mining_reward": MINING_REWARD,
        }

    def blocks_page(self, offset, limit):
        with self.chain.lock:
            chain = self.chain.chain
            tip = chain[-1]["index"]
            end = tip - offset + 1
            start = max(0, end - limit)
            blocks = []
            for b in reversed(chain[start:max(0, end)]):
                blocks.append({
                    "height": b["index"], "hash": b["hash"], "prev_hash": b.get("prev_hash"),
                    "ts": b["timestamp"], "txs": len(b.get("txs", [])),
                    "miner": b.get("miner"), "miner_address": b.get("miner_address"),
                    "bits": b.get("bits"), "nonce": b.get("nonce"),
                    "size": len(crypto.canonical_json(b)),
                    "reward": sum(int(t.get("amount", 0)) for t in b.get("txs", [])
                                  if t.get("type") == "COINBASE"),
                    "confirmations": tip - b["index"] + 1,
                })
            return {"blocks": blocks, "tip": tip, "count": len(blocks)}

    def block_detail(self, ref):
        with self.chain.lock:
            chain = self.chain.chain
            tip = chain[-1]["index"]
            block = None
            if ref.isdigit():
                h = int(ref)
                if 0 <= h < len(chain):
                    block = chain[h]
            else:
                for b in chain:
                    if b.get("hash") == ref:
                        block = b
                        break
            if block is None:
                return {"error": "Block not found on this node's chain"}
            out = json.loads(json.dumps(block))
            out["confirmations"] = tip - block["index"] + 1
            out["size"] = len(crypto.canonical_json(block))
            out["header_hash_input"] = crypto.canonical_json({
                "index": block["index"], "prev_hash": block["prev_hash"],
                "merkle_root": block["merkle_root"], "timestamp": block["timestamp"],
                "bits": block["bits"], "miner_address": block["miner_address"],
            })
            # tamper forensics: re-hash the header exactly like validation does —
            # a mismatch proves the stored data no longer hashes to its own hash.
            # tx-level edits (inflated amounts) leave the header untouched, so we
            # ALSO run the node's real validator (signature checks included) and
            # report its verdict + human reason — exactly what peers reject on.
            try:
                recomputed = bcmod.hash_with_nonce(
                    bcmod.header_prefix(block), int(block.get("nonce", 0) or 0))
                out["recomputed_hash"] = recomputed
                out["header_hash_valid"] = (recomputed == block.get("hash"))
                out["meets_target"] = bcmod.meets_target(
                    str(block.get("hash", "")), int(block.get("bits", 0) or 0))
            except (KeyError, TypeError, ValueError):
                out["header_hash_valid"] = False
            try:
                prev = chain[block["index"] - 1] if block["index"] > 0 else None
                ok, reason = self.chain.validate_block(json.loads(json.dumps(block)), prev)
            except Exception:
                ok, reason = False, "validation error"
            out["chain_valid"] = bool(ok)
            out["invalid_reason"] = None if ok else str(reason)
            out["txs"] = [self._tx_brief(t, block["index"], tip - block["index"] + 1) for t in block.get("txs", [])]
            return out

    def tx_detail(self, txid):
        with self.chain.lock:
            chain = self.chain.chain
            tip = chain[-1]["index"]
            for b in chain:
                for tx in b.get("txs", []):
                    if tx.get("txid") == txid:
                        out = json.loads(json.dumps(tx))
                        out["block_height"] = b["index"]
                        out["block_hash"] = b["hash"]
                        out["confirmations"] = tip - b["index"] + 1
                        out["signature_status"] = self._sig_status(tx)
                        return out
            tx = self.chain.mempool.get(txid)
            if tx:
                out = json.loads(json.dumps(tx))
                out["block_height"] = None
                out["confirmations"] = 0
                out["mempool"] = True
                out["signature_status"] = self._sig_status(tx)
                return out
            return {"error": "Transaction not found (wait for it to be mined)"}

    @staticmethod
    def _sig_status(tx):
        if tx.get("type") != "TRANSFER":
            return "SYSTEM — coinbase (newly issued PATH)"
        ok = crypto.verify_transaction(tx)
        return "ECDSA-secp256k1 VALID" if ok else "INVALID SIGNATURE"

    def address_detail(self, addr):
        with self.chain.lock:
            balances = self.chain.compute_balances()
            name = self.chain.wallet_dir.get(addr)
            chain = self.chain.chain
            tip = chain[-1]["index"]
            txs = []
            for b in chain:
                for tx in b.get("txs", []):
                    if tx.get("from_addr") == addr or tx.get("to_addr") == addr:
                        item = self._tx_brief(tx, b["index"], tip - b["index"] + 1)
                        item["direction"] = "in" if tx.get("to_addr") == addr and tx.get("type") == "COINBASE" else (
                            "out" if tx.get("from_addr") == addr else "in")
                        txs.append(item)
            for tx in self.chain.mempool.values():
                if tx.get("from_addr") == addr or tx.get("to_addr") == addr:
                    item = self._tx_brief(tx)
                    item["direction"] = "out" if tx.get("from_addr") == addr else "in"
                    item["mempool"] = True
                    txs.append(item)
            local = [w.name for w in self.chain.wallets.values() if w.address == addr]
            return {"address": addr, "name": name or (local[0] if local else None),
                    "balance": balances.get(addr, 0), "local": bool(local),
                    "txs": txs, "is_mempool_pending": any(t.get("mempool") for t in txs)}

    # -------------------------------------------------------------- wallets ----
    def wallets_view(self):
        with self.chain.lock:
            balances = self.chain.compute_balances()
            reserved = {}
            for tx in self.chain.mempool.values():
                sender = tx.get("from_addr")
                reserved[sender] = reserved.get(sender, 0) + int(tx.get("amount", 0))
            return [{"name": w.name, "address": w.address, "public_key": w.public_key_hex,
                     "balance": balances.get(w.address, 0),
                     "pending_out": reserved.get(w.address, 0),
                     "spendable": balances.get(w.address, 0) - reserved.get(w.address, 0),
                     "local": True, "is_bot": bool(getattr(w, "is_bot", False))}
                    for w in self.chain.wallets.values()]

    def wallet_keys(self, name):
        w = self.chain.wallets.get(name)
        if not w:
            return {"error": "No such wallet on this node"}
        return w.export()

    def send_path(self, body):
        from_name = str(body.get("from_name", "")).strip()
        to_ref = str(body.get("to", "")).strip()
        try:
            amount = int(str(body.get("amount", "")).strip())
        except (TypeError, ValueError):
            return {"ok": False, "error": f"Amount must be a whole number of {COIN_NAME}"}
        wallet = self.chain.wallets.get(from_name)
        if not wallet:
            return {"ok": False, "error": f"Wallet '{from_name}' does not exist on this node"}
        # resolve recipient: wallet name OR raw address
        to_addr, to_name = None, None
        with self.chain.lock:
            if to_ref in self.chain.wallets:
                other = self.chain.wallets[to_ref]
                to_addr, to_name = other.address, other.name
            else:
                for addr, nm in self.chain.wallet_dir.items():
                    if nm == to_ref:
                        to_addr, to_name = addr, nm
                        break
        if to_addr is None and to_ref.startswith("1") and 25 <= len(to_ref) <= 35:
            try:
                crypto.base58check_decode(to_ref)
                to_addr, to_name = to_ref, to_ref[:10] + "…"
            except ValueError:
                return {"ok": False, "error": "That Base58 address has an invalid checksum"}
        if not to_addr:
            return {"ok": False, "error": f"Recipient '{to_ref}' not found — use a wallet name or a PATH address"}
        if to_addr == wallet.address:
            return {"ok": False, "error": "Sending PATH to yourself makes no sense :)"}
        if amount <= 0:
            return {"ok": False, "error": "Amount must be positive"}
        tx = bcmod.make_transfer_tx(wallet, to_addr, to_name, amount)
        ok, message = self.chain.add_to_mempool(tx, source="local")
        if not ok:
            return {"ok": False, "error": message}
        self.node.log_event("tx", f"Transfer {wallet.name} -> {to_name or to_addr[:12]}: {amount} {COIN_NAME} "
                                  f"signed + mempool accepted ({tx['txid'][:14]}…)")
        self.node.broadcast({"type": "NEW_TX", "tx": tx, "node_id": self.node.node_id, "name": self.node.name})
        return {"ok": True, "txid": tx["txid"], "message": message}

    # ---------------------------------------------------------------- search ----
    def search(self, query):
        if not query:
            return {"type": "none"}
        with self.chain.lock:
            chain = self.chain.chain
            if query.isdigit():
                h = int(query)
                if 0 <= h < len(chain):
                    return {"type": "block", "ref": query}
            for b in chain:
                if b.get("hash", "").startswith(query):
                    return {"type": "block", "ref": b["index"]}
            for b in chain:
                for tx in b.get("txs", []):
                    if tx.get("txid", "").startswith(query):
                        return {"type": "tx", "ref": tx["txid"]}
            for txid in self.chain.mempool:
                if txid.startswith(query):
                    return {"type": "tx", "ref": txid}
            for addr, name in self.chain.wallet_dir.items():
                if query.lower() == str(name).lower() or addr.startswith(query):
                    return {"type": "address", "ref": addr}
        return {"type": "none"}

    # ------------------------------------------------------------- charts ----
    def stats_series(self):
        with self.chain.lock:
            chain = self.chain.chain
            series, supply, prev_ts = [], 0, None
            for b in chain:
                interval = (b["timestamp"] - prev_ts) if (prev_ts and prev_ts > 0 and b["timestamp"] > 0) else None
                prev_ts = b["timestamp"]
                for tx in b.get("txs", []):
                    if tx.get("type") == "COINBASE":
                        supply += int(tx.get("amount", 0))
                est_hr = None
                if interval:
                    est_hr = round((16 ** b.get("bits", 3)) / max(0.5, interval), 1)
                series.append({
                    "height": b["index"], "txs": max(0, len(b.get("txs", [])) - 1),
                    "interval": round(interval, 2) if interval else None,
                    "bits": b.get("bits"), "difficulty": 16 ** b.get("bits", 3),
                    "supply": supply, "hashrate": est_hr,
                    "miner": b.get("miner"),
                })
            return {"series": series}


def start_http(app, port):
    handler = make_handler(app)
    server = ThreadingHTTPServer(("0.0.0.0", int(port)), handler)
    threading.Thread(target=server.serve_forever, name="HTTP", daemon=True).start()
    return server
