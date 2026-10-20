"""
PATHchain miner — a real Proof-of-Work mining loop with live telemetry.

The loop does exactly what a Bitcoin miner does:
  1. take the block template (pending transactions + coinbase reward),
  2. serialise the block header,
  3. iterate a nonce, SHA-256 hashing the header each time,
  4. stop when the hash starts with the required number of zeros,
  5. broadcast the winning block; everyone re-hashes it to verify.

The telemetry (hashes per second, last attempts, nonce position) feeds the
Mining Lab page so students can SEE the lottery happening.
"""

import threading
import time
from collections import deque

from . import blockchain as bc

TELEMETRY_LINES = 14          # attempts kept for the live hash waterfall


class Miner:
    def __init__(self, chain, events=None):
        self.chain = chain
        self.events = events or (lambda kind, text: None)
        self.lock = threading.RLock()
        self.mode = "idle"                    # idle | auto | manual
        self.stop_event = threading.Event()
        self.template = None
        self.prefix = None
        self.attempts = 0                     # attempts on current template
        self.total_attempts = 0               # all-time
        self.hashrate = 0.0                   # EMA of H/s
        self.recent = deque(maxlen=TELEMETRY_LINES)
        self.found = deque(maxlen=12)         # blocks this node mined
        self.wasted = 0                       # attempts discarded when tip changed
        self.blocks_found = 0
        self._thread = None
        self._rate_last_count = None
        self._rate_last_ts = None
        self.last_tip = None

    # ------------------------------------------------------------ lifecycle ----
    def start_thread(self):
        if self._thread is None or not self._thread.is_alive():
            self._thread = threading.Thread(target=self._run, name="Miner", daemon=True)
            self._thread.start()

    def set_mode(self, mode):
        with self.lock:
            if mode not in ("idle", "auto", "manual"):
                return False
            self.mode = mode
        if mode == "auto":
            self.stop_event.clear()
            self.start_thread()
            self.events("mine", f"Mining started — hunting for {self.chain.next_difficulty()} leading zeros")
        elif mode == "idle":
            self.events("mine", "Mining stopped")
        return True

    def status(self):
        with self.lock:
            tip = self.chain.chain[-1]
            expected = 16 ** max(1, self.template["bits"]) if self.template else 16 ** tip.get("bits", 3)
            return {
                "mode": self.mode,
                "tip_height": tip["index"],
                "tip_hash": tip["hash"],
                "bits": self.template["bits"] if self.template else tip.get("bits", 3),
                "target_zeros": self.template["bits"] if self.template else tip.get("bits", 3),
                "template": ({
                    "index": self.template["index"],
                    "prev_hash": self.template["prev_hash"],
                    "merkle_root": self.template["merkle_root"],
                    "timestamp": self.template["timestamp"],
                    "bits": self.template["bits"],
                    "miner": self.template["miner"],
                    "tx_count": len(self.template.get("txs", [])),
                    "txids": [t["txid"] for t in self.template.get("txs", [])],
                } if self.template else None),
                "attempts": self.attempts,
                "total_attempts": self.total_attempts,
                "expected_attempts": expected,
                "hashrate": round(self.hashrate, 1),
                "recent": list(self.recent),
                "found": list(self.found),
                "blocks_found": self.blocks_found,
                "wasted": self.wasted,
            }

    # ------------------------------------------------------------ internals ----
    def _record(self, nonce, hash_value, ok):
        with self.lock:
            self.attempts += 1
            self.total_attempts += 1
            now = time.time()
            self.recent.appendleft({
                "nonce": nonce, "hash": hash_value,
                "target": self.template["bits"] if self.template else None, "ok": ok, "ts": now,
            })

    def _update_hashrate(self):
        now = time.time()
        with self.lock:
            count = self.total_attempts
            if self._rate_last_count is None:
                self._rate_last_count, self._rate_last_ts = count, now
                return
            dt = now - self._rate_last_ts
            if dt < 0.4:
                return
            rate = (count - self._rate_last_count) / dt
            self._rate_last_count, self._rate_last_ts = count, now
        self.hashrate = rate if not self.hashrate else self.hashrate * 0.6 + rate * 0.4

    def _tip_changed(self):
        tip = self.chain.chain[-1]
        with self.lock:
            if self.last_tip == tip["hash"]:
                return False
            self.last_tip = tip["hash"]
            return True

    def _new_template(self):
        with self.chain.lock:
            wallets = self.chain.wallets
            if not wallets:
                return False
            # mine under the first local wallet (or fall back to any)
            wallet = next(iter(wallets.values()))
            with self.lock:
                self.template = self.chain.build_template(wallet.name, wallet.address)
                self.prefix = bc.header_prefix(self.template)
                self.attempts = 0
        self.last_tip = self.chain.chain[-1]["hash"]
        return True

    def _try_nonce(self, nonce):
        hash_value = bc.hash_with_nonce(self.prefix, nonce)
        self._record(nonce, hash_value, ok=bc.meets_target(hash_value, self.template["bits"]))
        if bc.meets_target(hash_value, self.template["bits"]):
            return hash_value
        return None

    def _win(self, nonce, hash_value):
        block = self.chain.finalize_block(self.template, nonce, hash_value)
        ok, reason = self.chain.validate_block(block, self.chain.chain[-1])
        if not ok:
            with self.lock:
                self.template = None
            return False
        self.chain.apply_block(block)
        reward = sum(int(t.get("amount", 0)) for t in block["txs"] if t.get("type") == "COINBASE")
        with self.lock:
            self.blocks_found += 1
            self.found.appendleft({
                "height": block["index"], "hash": block["hash"], "nonce": nonce,
                "attempts": self.attempts, "hashrate": round(self.hashrate, 1),
                "reward": reward, "ts": time.time(), "bits": block["bits"],
            })
            self.template = None
        self.events("mine", f"BLOCK FOUND #{block['index']} — nonce {nonce:,} solved "
                            f"{block['bits']} zeros after {self.attempts:,} hashes (+{reward} PATH)")
        return True

    def _run(self):
        while not self.stop_event.is_set():
            try:
                self._run_once()
            except Exception as exc:
                # never let a transient race kill the miner thread
                with self.lock:
                    self.template = None
                self.events("mine", f"Miner recovered from: {exc}")
                time.sleep(0.3)

    def _run_once(self):
        if self.mode != "auto":
            self.stop_event.wait(0.3)
            return
        if self.chain.first_bad_index() is not None:
            # chain is tampered — a real miner would stop building on it
            time.sleep(0.5)
            return
        if self.template is None or self._tip_changed():
            with self.lock:
                if self.template is not None:
                    self.wasted += self.attempts
            if not self._new_template():
                time.sleep(0.5)
                return
            self.events("mine", f"New block template #{self.template['index']} — packing "
                                f"{len(self.template['txs'])} tx(s), target {self.template['bits']} zeros")
        batch = 1500
        with self.lock:
            template, prefix, start_nonce = self.template, self.prefix, self.template.get("nonce", 0)
        if template is None or prefix is None:
            return
        for offset in range(batch):
            if self.template is not template:      # tip changed mid-batch -> abandon
                return
            nonce = start_nonce + offset
            found = self._try_nonce(nonce)
            if found:
                self._win(nonce, found)
                break
        else:
            with self.lock:
                if self.template:
                    self.template["nonce"] = start_nonce + batch
            self._update_hashrate()

    # ------------------------------------------------------------- manual ----
    def step(self, attempts=1):
        """Manual mining: run N hash attempts on demand (the classroom 'press to hash' button)."""
        results = []
        if self.chain.first_bad_index() is not None:
            return {"blocked": "Chain is tampered — mining halted until consensus recovery."}
        if self.template is None or self._tip_changed():
            if not self._new_template():
                return {"blocked": "No wallet on this node — create a wallet first."}
            self.events("mine", f"Manual mining: template #{self.template['index']} prepared "
                                f"({len(self.template['txs'])} txs, target {self.template['bits']} zeros)")
        if self.mode == "idle":
            self.set_mode("manual")
        for _ in range(max(1, min(5000, int(attempts)))):
            nonce = self.attempts
            found = self._try_nonce(nonce)
            results.append({"nonce": nonce, "hash": self.recent[0]["hash"] if self.recent else None})
            if found:
                self._win(nonce, found)
                return {"found": True, "results": results[-TELEMETRY_LINES:], "found_block": self.found[0] if self.found else None}
        self._update_hashrate()
        return {"found": False, "results": results[-TELEMETRY_LINES:], "attempts": self.attempts}
