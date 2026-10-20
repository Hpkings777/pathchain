"""
PATHchain blockchain core — real Proof-of-Work, no simulation.

A block is committed by iterating a nonce and hashing the block header
(SHA-256) until the hash has a required number of leading zeros — the exact
process Bitcoin miners run, scaled to school-LAN speed. Difficulty
(leading zeros) auto-retargets so blocks arrive roughly every TARGET_BLOCK_TIME
seconds no matter how many computers are mining.
"""

import json
import threading
import time
import uuid

from . import crypto

COIN_NAME = "PATH"
MINING_REWARD = 10
MAX_BITS = 6          # max leading zero hex digits difficulty can grow to
MIN_BITS = 3          # minimum difficulty (a classroom can always mine)
TARGET_BLOCK_TIME = 15.0   # seconds — tuned so live mining races stay exciting
RETARGET_INTERVAL = 8       # adjust difficulty every N blocks
MAX_MEMPOOL = 200


def set_limits(max_bits=None, min_bits=None, target_time=None, retarget=None):
    global MAX_BITS, MIN_BITS, TARGET_BLOCK_TIME, RETARGET_INTERVAL
    if max_bits is not None:
        MAX_BITS = int(max_bits)
    if min_bits is not None:
        MIN_BITS = int(min_bits)
    if target_time is not None:
        TARGET_BLOCK_TIME = float(target_time)
    if retarget is not None:
        RETARGET_INTERVAL = int(retarget)

GENESIS_MESSAGE = "PATH genesis — the network starts here. A chain is only as strong as its weakest block."


def sha256_hex(text):
    return crypto.sha256_hex(text)


def canonical_json(obj):
    return crypto.canonical_json(obj)


def calculate_merkle_root(txids):
    """Merkle tree over transaction IDs (duplicate last when odd, like Bitcoin)."""
    if not txids:
        return sha256_hex("")
    level = list(txids)
    while len(level) > 1:
        if len(level) % 2:
            level.append(level[-1])
        level = [sha256_hex(level[i] + level[i + 1]) for i in range(0, len(level), 2)]
    return level[0]


def tx_signing_payload(tx):
    return {k: v for k, v in tx.items()
            if k not in ("signature", "script_sig", "txid", "to_name")}


def calculate_txid(tx):
    return sha256_hex(canonical_json(tx_signing_payload(tx)))


def make_transfer_tx(wallet, to_addr, to_name, amount):
    """Build a real ECDSA-secp256k1 signed transfer (Bitcoin-style P2PKH)."""
    tx = {
        "type": "TRANSFER",
        "from_name": wallet.name,
        "from_addr": wallet.address,
        "to_name": to_name,
        "to_addr": to_addr,
        "amount": int(amount),
        "fee": 0,
        "timestamp": round(time.time(), 3),
        "nonce": uuid.uuid4().hex,
        "public_key": wallet.public_key_hex,
        "signature_algorithm": "ECDSA-secp256k1-SHA256",
        "script_pub_key": crypto.signing_script(to_addr),
    }
    tx["txid"] = calculate_txid(tx)
    wallet.sign_transaction(tx)
    # txid must be recomputed after signing? No — txid covers only pre-signature
    # payload fields, exactly like Bitcoin's txid excludes scriptSig.
    tx["script_sig"] = f"PUSHDATA({tx['signature']}) PUSHDATA({wallet.public_key_hex})"
    return tx


def make_coinbase_tx(miner_name, miner_address, height):
    tx = {
        "type": "COINBASE",
        "from_name": "NETWORK",
        "from_addr": "NETWORK",
        "to_name": miner_name,
        "to_addr": miner_address,
        "amount": MINING_REWARD,
        "fee": 0,
        "height": height,
        "timestamp": round(time.time(), 3),
        "system_transaction": "coinbase — new PATH created by mining (the only issuance)",
    }
    tx["txid"] = calculate_txid(tx)
    return tx


def header_prefix(block):
    """The constant part of the header bytes — the mining loop only appends the nonce."""
    header = {
        "index": block["index"],
        "prev_hash": block["prev_hash"],
        "merkle_root": block["merkle_root"],
        "timestamp": block["timestamp"],
        "bits": block["bits"],
        "miner_address": block["miner_address"],
    }
    return canonical_json(header).encode("utf-8")


def hash_with_nonce(prefix_bytes, nonce):
    return crypto.sha256_bytes(prefix_bytes + str(nonce).encode("utf-8")).hex()


def meets_target(block_hash, bits):
    return block_hash.startswith("0" * bits)


def make_genesis_block():
    block = {
        "index": 0,
        "timestamp": 0.0,
        "prev_hash": "0" * 64,
        "merkle_root": calculate_merkle_root([]),
        "nonce": 0,
        "bits": 0,
        "miner": "SYSTEM",
        "miner_address": "0" * 34,
        "message": GENESIS_MESSAGE,
        "txs": [],
    }
    block["hash"] = hash_with_nonce(header_prefix(block), 0)
    return block


class Blockchain:
    """Chain + mempool + wallet directory. Balances are always re-derived by
    replaying the chain — there is no stored 'bank' state to go stale."""

    def __init__(self, data_dir, node_name):
        self.lock = threading.RLock()
        self.data_dir = data_dir
        self.node_name = node_name

        self.chain = [make_genesis_block()]
        self.chain_epoch = 1
        self.mempool = {}            # txid -> tx
        self.wallet_dir = {}         # address -> display name (broadcast network-wide)
        self.wallets = {}            # name -> Wallet (LOCAL ONLY, never synced)
        self.sig_cache = {}          # txid -> bool (verified signatures)
        self.valid_cache = {}        # (block_hash, prev_hash) -> (ok, reason)

        import os
        os.makedirs(data_dir, exist_ok=True)
        self.chain_file = os.path.join(data_dir, "pathchain_data.json")
        self.keys_file = os.path.join(data_dir, "wallet_keys.json")
        self._load()

    # ------------------------------------------------------------- storage ----
    def _load(self):
        try:
            with open(self.chain_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            self.chain = data.get("chain", self.chain)
            self.chain_epoch = int(data.get("chain_epoch", 1))
            self.mempool = data.get("mempool", {})
            self.wallet_dir = data.get("wallet_dir", {})
        except FileNotFoundError:
            self.save()
        except Exception:
            self.save()

        try:
            with open(self.keys_file, "r", encoding="utf-8") as f:
                stored = json.load(f)
            for name, entry in stored.items():
                try:
                    self.wallets[name] = crypto.Wallet(name, entry["private_key_hex"])
                except (ValueError, KeyError, TypeError):
                    continue
        except FileNotFoundError:
            pass
        except Exception:
            pass

    def save(self):
        with self.lock:
            snapshot = {
                "chain": self.chain,
                "chain_epoch": self.chain_epoch,
                "mempool": self.mempool,
                "wallet_dir": self.wallet_dir,
            }
        tmp = self.chain_file + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(snapshot, f, indent=1, ensure_ascii=False)
            f.flush()
            import os
            os.fsync(f.fileno())
        os.replace(tmp, self.chain_file)

        with self.lock:
            keys = {name: w.export() for name, w in self.wallets.items()}
        tmp = self.keys_file + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(keys, f, indent=1, ensure_ascii=False)
            os.replace(tmp, self.keys_file)
        except OSError:
            pass

    # ------------------------------------------------------------ balances ----
    def compute_balances(self, chain=None):
        """Replay every block: coinbase creates PATH, valid signed transfers move it.
        Any tx that fails its txid/signature tripwire is ignored (tamper-proof)."""
        if chain is None:
            with self.lock:
                chain = self.chain
        balances = {}
        for block in chain:
            for tx in block.get("txs", []):
                ttype = tx.get("type")
                if ttype not in ("COINBASE", "TRANSFER"):
                    continue
                if not self.tx_record_valid(tx):
                    continue
                to_addr = tx.get("to_addr")
                amount = int(tx.get("amount", 0))
                if not to_addr or amount <= 0:
                    continue
                if ttype == "COINBASE":
                    balances[to_addr] = balances.get(to_addr, 0) + amount
                else:
                    frm = tx.get("from_addr")
                    if not frm:
                        continue
                    balances[frm] = balances.get(frm, 0) - amount
                    balances[to_addr] = balances.get(to_addr, 0) + amount
        return {a: v for a, v in balances.items() if v >= 0}

    def balance_of(self, address):
        balances = self.compute_balances()
        return balances.get(address, 0)

    # --------------------------------------------------------- mempool ops ----
    def add_wallet(self, name):
        name = name.strip()
        if not name or not all(ch.isalnum() or ch in "_-" for ch in name):
            return None, "Wallet name: letters, numbers, _ and - only."
        with self.lock:
            if name in self.wallets:
                return None, f"Wallet '{name}' already exists on this node."
            wallet = crypto.Wallet.generate(name)
            self.wallets[name] = wallet
            self.wallet_dir[wallet.address] = name
            self.save()
        return wallet, f"Wallet created: {name} ({wallet.address})"

    def add_to_mempool(self, tx, source="local"):
        """Validate and accept a signed transfer into the mempool."""
        if not isinstance(tx, dict) or tx.get("type") != "TRANSFER":
            return False, "Only signed TRANSFER transactions are accepted."
        txid = tx.get("txid") or calculate_txid(tx)
        tx["txid"] = txid
        with self.lock:
            if txid in self.mempool:
                return False, "Already in mempool."
            ok = crypto.verify_transaction(tx)
            if not ok:
                return False, "INVALID SIGNATURE — transaction rejected."
            balances = self.compute_balances()
            sender = tx.get("from_addr")
            amount = int(tx.get("amount", 0))
            reserved = sum(int(t.get("amount", 0)) for t in self.mempool.values()
                           if t.get("from_addr") == sender)
            if balances.get(sender, 0) - reserved < amount:
                return False, f"Insufficient balance for {sender[:12]}… (needs {amount} {COIN_NAME})."
            if len(self.mempool) >= MAX_MEMPOOL:
                return False, "Mempool full."
            self.mempool[txid] = tx
            name = tx.get("from_name")
            if name and tx.get("public_key"):
                self.wallet_dir.setdefault(tx["from_addr"], name)
            to_name = tx.get("to_name")
            if to_name and tx.get("to_addr"):
                self.wallet_dir.setdefault(tx["to_addr"], to_name)
        return True, f"Transaction {txid[:16]}… accepted ({source})."

    def select_transactions(self):
        """Pick mempool txs that remain affordable when applied in order (miners do this)."""
        balances = self.compute_balances()
        chosen, skipped = [], []
        for tx in list(self.mempool.values()):
            if not self.tx_record_valid(tx):
                skipped.append(tx)
                continue
            sender, amt = tx.get("from_addr"), int(tx.get("amount", 0))
            if balances.get(sender, 0) >= amt and amt > 0:
                balances[sender] = balances.get(sender, 0) - amt
                balances[tx.get("to_addr")] = balances.get(tx.get("to_addr"), 0) + amt
                chosen.append(tx)
            else:
                skipped.append(tx)
        return chosen, skipped

    # ------------------------------------------------------------- mining ----
    def build_template(self, miner_name, miner_address):
        """Assemble a block template: valid mempool txs + coinbase reward."""
        with self.lock:
            tip = self.chain[-1]
            txs, _skipped = self.select_transactions()
            coinbase = make_coinbase_tx(miner_name, miner_address, len(self.chain))
            txs = [coinbase] + txs
            template = {
                "index": len(self.chain),
                "timestamp": round(time.time(), 3),
                "prev_hash": tip["hash"],
                "merkle_root": calculate_merkle_root([t["txid"] for t in txs]),
                "nonce": 0,
                "bits": self.next_difficulty(),
                "miner": miner_name,
                "miner_address": miner_address,
                "message": f"Mined by {miner_name} on {self.node_name}",
                "txs": txs,
            }
            template["txids"] = [t["txid"] for t in txs]
            return template

    def next_difficulty(self):
        with self.lock:
            chain = self.chain
            if len(chain) < RETARGET_INTERVAL + 1:
                return max(MIN_BITS, int(chain[-1].get("bits", 3) or 3))
            window = chain[-RETARGET_INTERVAL:]
            span = max(0.1, window[-1]["timestamp"] - window[0]["timestamp"])
            actual = span / (len(window) - 1)
            bits = int(window[-1].get("bits", 3))
            if actual < TARGET_BLOCK_TIME * 0.55:
                bits += 1      # too fast -> harder
            elif actual > TARGET_BLOCK_TIME * 1.7:
                bits -= 1      # too slow -> easier
            return max(MIN_BITS, min(MAX_BITS, bits))

    def finalize_block(self, template, nonce, hash_value):
        template = dict(template)
        template["nonce"] = nonce
        template["hash"] = hash_value
        return template

    def apply_block(self, block):
        """Append a block and clear its transactions from the mempool."""
        with self.lock:
            self.chain.append(block)
            mined_ids = {t["txid"] for t in block.get("txs", []) if t.get("txid")}
            self.mempool = {k: v for k, v in self.mempool.items() if k not in mined_ids}
            self.sig_cache = {k: v for k, v in self.sig_cache.items() if k not in mined_ids}
            self.save()

    # --------------------------------------------------------- validation ----
    @staticmethod
    def _content_key(obj):
        """Content-addressed cache key — ANY edit to a tx/block produces a new key,
        so a tampered record can never be validated from a stale cache entry."""
        return crypto.sha256_hex(crypto.canonical_json(obj))

    def tx_record_valid(self, tx):
        """A tx is only replayable if its content still hashes to its recorded txid
        and (for transfers) the signature verifies. This is the tamper tripwire."""
        if not isinstance(tx, dict) or not tx.get("txid"):
            return False
        if calculate_txid(tx) != tx.get("txid"):
            return False
        return self.tx_signature_valid(tx)

    def tx_signature_valid(self, tx):
        if not isinstance(tx, dict) or tx.get("type") != "TRANSFER":
            return True
        key = self._content_key(tx)
        cached = self.sig_cache.get(key)
        if cached is not None and len(self.sig_cache) < 20000:
            return cached
        result = crypto.verify_transaction(tx)
        self.sig_cache[key] = result
        return result

    def validate_block(self, block, prev_block):
        """Full validation — the exact checks every node runs before accepting a block.
        Each unique block is fully validated once, then cached (LAN sync stays fast)."""
        prev_hash = prev_block.get("hash") if isinstance(prev_block, dict) else None
        cache_key = (self._content_key(block), prev_hash)
        cached = self.valid_cache.get(cache_key)
        if cached is not None and len(self.valid_cache) < 10000:
            return cached
        result = self._validate_block_uncached(block, prev_block)
        self.valid_cache[cache_key] = result
        return result

    def _validate_block_uncached(self, block, prev_block):
        """Full validation — the exact checks every node runs before accepting a block."""
        if not isinstance(block, dict):
            return False, "not a block"
        try:
            if block.get("index") != prev_block.get("index") + 1:
                return False, "bad index"
            if block.get("prev_hash") != prev_block.get("hash"):
                return False, "does not link to previous block"
            if block.get("timestamp", 0) < prev_block.get("timestamp", 0) - 120:
                return False, "timestamp older than parent"
            if block.get("timestamp", 0) > time.time() + 300:
                return False, "timestamp in the future"
            txs = block.get("txs")
            if not isinstance(txs, list) or not txs:
                return False, "no transactions (no coinbase)"
            coinbase = [t for t in txs if t.get("type") == "COINBASE"]
            if len(coinbase) != 1:
                return False, "block must contain exactly one coinbase"
            if int(coinbase[0].get("amount", 0)) > MINING_REWARD:
                return False, "coinbase pays more than the block reward"
            if coinbase[0].get("to_addr") != block.get("miner_address"):
                return False, "coinbase is not payable to the recorded miner"
            txids = [t.get("txid") for t in txs]
            if any(not t for t in txids) or len(set(txids)) != len(txids):
                return False, "missing or duplicate txids"
            if block.get("merkle_root") != calculate_merkle_root(txids):
                return False, "merkle root mismatch — transactions were altered"
            # proof of work
            h = hash_with_nonce(header_prefix(block), block.get("nonce", 0))
            if h != block.get("hash"):
                return False, "stored hash does not match header (header was edited)"
            if not meets_target(block.get("hash", ""), int(block.get("bits", 0) or 0)):
                return False, f"hash does not meet target ({block.get('bits')} leading zeros required)"
            if block.get("index", 0) > 0 and int(block.get("bits", 0)) < MIN_BITS:
                return False, "difficulty below network minimum"
            if block.get("index", 0) > 0 and int(block.get("bits", 0)) > MAX_BITS:
                return False, "difficulty above network maximum"
            # every transfer must be validly signed and affordable in order
            balances = self.compute_balances([b for b in self.chain])
            for tx in txs:
                if tx.get("type") == "TRANSFER":
                    ok = self.tx_signature_valid(tx)
                    if not ok:
                        return False, f"invalid signature on tx {tx['txid'][:16]}…"
                    frm, amt = tx.get("from_addr"), int(tx.get("amount", 0))
                    if balances.get(frm, 0) < amt:
                        return False, f"overspend attempt by {frm[:12]}…"
                    balances[frm] -= amt
                    balances[tx.get("to_addr")] = balances.get(tx.get("to_addr"), 0) + amt
            return True, "ok"
        except (KeyError, ValueError, TypeError) as exc:
            return False, f"malformed block: {exc}"

    def chain_is_valid(self, chain=None):
        chain = chain if chain is not None else self.chain
        if not isinstance(chain, list) or not chain:
            return False, "empty"
        for i, block in enumerate(chain):
            if not isinstance(block, dict):
                return False, f"block {i} malformed"
            if i == 0:
                if block.get("prev_hash") != "0" * 64:
                    return False, "bad genesis"
                continue
            ok, reason = self.validate_block(block, chain[i - 1])
            if not ok:
                return False, reason
        return True, "ok"

    def first_bad_index(self, chain=None):
        """First block that fails validation, or None — used by rollback + tamper alerts.
        Light-weight structural + proof-of-work check (no balance replay)."""
        chain = chain if chain is not None else self.chain
        for i, block in enumerate(chain):
            if not isinstance(block, dict):
                return i
            if i == 0:
                if block.get("prev_hash") != "0" * 64:
                    return i
                if block.get("hash") != hash_with_nonce(header_prefix(block), block.get("nonce", 0)):
                    return i
                continue
            prev = chain[i - 1]
            if not isinstance(prev, dict) or block.get("index") != i:
                return i
            if block.get("prev_hash") != prev.get("hash"):
                return i
            if block.get("hash") != hash_with_nonce(header_prefix(block), block.get("nonce", 0)):
                return i
            if not meets_target(block.get("hash", ""), int(block.get("bits", 0) or 0)):
                return i
            if block.get("merkle_root") != calculate_merkle_root(
                    [t.get("txid") for t in block.get("txs", []) if isinstance(t, dict)]):
                return i
            # transactions must still hash to their recorded txid AND carry a valid
            # signature — this is what catches a tx whose amount was quietly edited
            for tx in block.get("txs", []):
                if not isinstance(tx, dict):
                    return i
                if calculate_txid(tx) != tx.get("txid"):
                    return i
                if not self.tx_signature_valid(tx):
                    return i
        return None

    # ------------------------------------------------------------ snapshot ----
    def state_snapshot(self, msg_type="FULL_SYNC"):
        with self.lock:
            return {
                "type": msg_type,
                "protocol": "PATHCHAIN/1",
                "epoch": self.chain_epoch,
                "chain": self.chain,
                "mempool": list(self.mempool.values()),
                "wallet_dir": dict(self.wallet_dir),
            }

    def load_snapshot(self, snap):
        with self.lock:
            self.chain = json.loads(json.dumps(snap["chain"]))
            self.chain_epoch = int(snap.get("epoch", 1))
            self.mempool = {t.get("txid"): t for t in snap.get("mempool", []) if t.get("txid")}
            self.wallet_dir = dict(snap.get("wallet_dir", {}))
            self.sig_cache = {}
            self.valid_cache = {}
            # prune mempool: on a new canonical chain some pending txs (e.g. from a
            # losing fork) can no longer be afforded — drop them like Bitcoin would
            balances = self.compute_balances()
            reserved = {}
            kept = {}
            for txid, tx in self.mempool.items():
                if not self.tx_record_valid(tx):
                    continue
                sender, amount = tx.get("from_addr"), int(tx.get("amount", 0))
                available = balances.get(sender, 0) - reserved.get(sender, 0)
                if amount > 0 and balances.get(sender, 0) > 0 and amount <= available:
                    reserved[sender] = reserved.get(sender, 0) + amount
                    kept[txid] = tx
            self.mempool = kept
            self.save()

    def merge_wallet_dir(self, remote_dir):
        changed = False
        with self.lock:
            for addr, name in (remote_dir or {}).items():
                if addr and name and addr not in self.wallet_dir:
                    self.wallet_dir[addr] = str(name)
                    changed = True
            if changed:
                self.save()
        return changed

    def mempool_union(self, remote_txs):
        added = 0
        for tx in remote_txs or []:
            if isinstance(tx, dict) and tx.get("txid") and tx["txid"] not in self.mempool:
                ok, _ = self.add_to_mempool(tx, source="sync")
                if ok:
                    added += 1
        return added
