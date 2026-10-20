"""
PATHchain P2P node — LAN networking, ported from the HumanChain pygame demo.

  * TCP peers (JSON lines protocol) on --tcp port
  * UDP broadcast discovery on --udp port (auto-find every computer running PATHchain)
  * periodic FULL_SYNC push/pull (state converges across multiple hops)
  * NEW_TX / NEW_BLOCK relays with de-duplication
  * tamper demo: TAMPER_ALERT -> network-wide vote -> RECOVERY (epoch bump)
    so a delayed hacked snapshot can never resurrect after recovery

Adoption rules (deterministic on every node, same as the prototype):
  epoch higher wins; same epoch: a tampered chain becomes VISIBLE everywhere;
  clean chains adopt whichever is longest; ties break on chain fingerprint.
"""

import ipaddress
import json
import queue
import socket
import threading
import time
import uuid
from collections import deque

from . import crypto

MAX_LINE_BYTES = 8 * 1024 * 1024
SYNC_INTERVAL = 4.0
DISCOVERY_INTERVAL = 6.0
DISCOVERY_TTL = 30.0
POLL_TIMEOUT = 45.0  # consensus vote must resolve — silent voters cannot hang it forever


def local_interface_details():
    details, seen = [], set()
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("192.0.2.1", 80))  # RFC 5737 test address — nothing is sent
        details.append(("LAN interface", probe.getsockname()[0]))
        seen.add(probe.getsockname()[0])
        probe.close()
    except OSError:
        pass
    try:
        for item in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = item[4][0]
            if ip not in seen:
                details.append(("LAN interface", ip))
                seen.add(ip)
    except OSError:
        pass
    if "127.0.0.1" not in seen:
        details.append(("Loopback", "127.0.0.1"))
    return details or [("Loopback", "127.0.0.1")]


class Node:
    def __init__(self, chain, miner, name, tcp_port, udp_port, http_port, events=None):
        self.chain = chain
        self.miner = miner
        self.name = name
        self.tcp_port = int(tcp_port)
        self.udp_port = int(udp_port)
        self.http_port = int(http_port)
        self.node_id = uuid.uuid4().hex[:16]

        self.events = events or (lambda kind, text: None)
        self.event_log = deque(maxlen=120)

        self.lock = threading.RLock()
        self.peers = {}              # conn -> {ip, port, name, node_id, height, last_seen}
        self.send_locks = {}
        self.discovered = {}         # node_id -> info
        self.failed_connects = {}    # "ip:port" -> ts (retry backoff)
        self.seen_tx = set()
        self.seen_blocks = set()
        self.seen_hacks = set()
        self.seen_votes = set()
        self.seen_results = set()
        self.shutdown = threading.Event()

        self.server_sock = None
        self.hosting = False
        self.poll = None             # active tamper-consensus poll
        self.last_recovery_note = ""

    def log_event(self, kind, text):
        self.events(kind, text)
        with self.lock:
            self.event_log.appendleft({"ts": time.time(), "kind": kind, "text": text})

    # ------------------------------------------------------------ wire I/O ----
    def _send(self, conn, msg):
        lock = self.send_locks.get(conn)
        if lock is None:
            return False
        try:
            with lock:
                conn.sendall((json.dumps(msg, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
            return True
        except (OSError, ConnectionError):
            self._remove_peer(conn)
            return False

    def broadcast(self, msg, exclude=None):
        with self.lock:
            conns = list(self.peers.keys())
        for conn in conns:
            if conn is not exclude:
                self._send(conn, msg)

    def _add_peer(self, conn, addr):
        with self.lock:
            if conn not in self.peers:
                self.peers[conn] = {"ip": addr[0], "port": addr[1], "name": "?",
                                    "node_id": None, "height": 0, "last_seen": time.time()}
                self.send_locks[conn] = threading.Lock()

    def _remove_peer(self, conn):
        with self.lock:
            info = self.peers.pop(conn, None)
            self.send_locks.pop(conn, None)
        if info:
            self.log_event("peer", f"Peer disconnected: {info.get('name')} ({info.get('ip')})")
        try:
            conn.close()
        except OSError:
            pass

    def peer_view(self):
        with self.lock:
            now = time.time()
            out = []
            for info in self.peers.values():
                item = dict(info)
                item["lag"] = round(now - info.get("last_seen", now), 1)
                out.append(item)
            return out

    def connected_node_ids(self):
        with self.lock:
            return sorted({str(i.get("node_id")) for i in self.peers.values()
                           if i.get("node_id") and str(i.get("node_id")) != self.node_id})

    # -------------------------------------------------------- TCP handlers ----
    def start_server(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("0.0.0.0", self.tcp_port))
        except OSError as exc:
            self.log_event("error", f"Cannot host TCP {self.tcp_port}: {exc}")
            return
        sock.listen(24)
        sock.settimeout(1.0)
        self.server_sock = sock
        self.hosting = True
        threading.Thread(target=self._accept_loop, name="TCP-Accept", daemon=True).start()
        self.log_event("peer", f"Hosting node on TCP port {self.tcp_port}")

    def _accept_loop(self):
        while self.hosting and not self.shutdown.is_set():
            try:
                conn, addr = self.server_sock.accept()
                conn.settimeout(1.0)
                self._add_peer(conn, addr)
                threading.Thread(target=self._peer_loop, args=(conn, addr), daemon=True).start()
            except socket.timeout:
                continue
            except OSError:
                break

    def connect_to(self, target):
        target = str(target).strip()
        if not target:
            return False, "Enter an IP or IP:port"
        ip, port = target, self.tcp_port
        if ":" in target:
            ip, _, p = target.rpartition(":")
            if p.isdigit():
                ip, port = ip.strip(), int(p)
        try:
            if not (1 <= int(port) <= 65535):
                return False, "Port must be 1-65535"
        except (TypeError, ValueError):
            return False, "Port must be a number"
        with self.lock:
            for info in self.peers.values():
                if info.get("ip") == ip and info.get("node_id"):
                    return False, f"Already connected to {info.get('name')}"
            if time.time() - self.failed_connects.get(f"{ip}:{port}", 0) < 5:
                return False, f"Retrying {ip} too quickly — wait a moment"
        try:
            conn = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            conn.settimeout(4.0)
            conn.connect((ip, int(port)))
            conn.settimeout(1.0)
            self._add_peer(conn, (ip, int(port)))
            threading.Thread(target=self._peer_loop, args=(conn, (ip, int(port))), daemon=True).start()
            self.log_event("peer", f"Connecting to {ip}:{port} — handshake + initial sync…")
            return True, f"Connecting to {ip}:{port}"
        except OSError as exc:
            with self.lock:
                self.failed_connects[f"{ip}:{port}"] = time.time()
            return False, f"Connection to {ip}:{port} failed: {exc}"

    def _peer_loop(self, conn, addr):
        try:
            hello = {"type": "HELLO", "node_id": self.node_id, "name": self.name,
                     "tcp_port": self.tcp_port, "http_port": self.http_port,
                     "height": len(self.chain.chain) - 1}
            self._send(conn, hello)
            snap = self.chain.state_snapshot("FULL_SYNC")
            snap["node_id"], snap["name"] = self.node_id, self.name
            self._send(conn, snap)
            buffer = b""
            while not self.shutdown.is_set():
                try:
                    chunk = conn.recv(65536)
                except socket.timeout:
                    continue
                if not chunk:
                    break
                buffer += chunk
                if len(buffer) > MAX_LINE_BYTES and b"\n" not in buffer:
                    break
                while b"\n" in buffer:
                    raw, buffer = buffer.split(b"\n", 1)
                    if not raw.strip():
                        continue
                    try:
                        msg = json.loads(raw.decode("utf-8"))
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        continue
                    try:
                        self._handle(conn, addr, msg)
                    except Exception:
                        pass
        except Exception:
            pass
        finally:
            self._remove_peer(conn)

    def _touch(self, conn, msg):
        with self.lock:
            if conn not in self.peers:
                return
            info = self.peers[conn]
            info["last_seen"] = time.time()
            nid = str(msg.get("node_id") or "")
            if not nid:
                return
            claimed = info.get("node_id")
            if claimed and claimed != nid:
                # Relayed message — it carries the ORIGINAL sender's node_id, not this
                # connection's peer. Identity is claimed once (HELLO) and never
                # re-attributed, otherwise relays silently rewrite peer identities and
                # shrink the eligible-voter set (quorum corruption).
                return
            if not claimed:
                info["node_id"] = nid
                if msg.get("name"):
                    info["name"] = str(msg["name"])
            if msg.get("type") == "HELLO" and msg.get("tcp_port"):
                info["port"] = int(msg["tcp_port"])

    def _handle(self, conn, addr, msg):
        mtype = msg.get("type")
        self._touch(conn, msg)

        if mtype == "HELLO":
            with self.lock:
                if conn in self.peers:
                    self.peers[conn]["height"] = int(msg.get("height", 0) or 0)
            self.log_event("peer", f"Handshake from {msg.get('name', '?')} ({addr[0]})")

        elif mtype in ("FULL_SYNC", "CHAIN_DATA"):
            self._merge_snapshot(msg, sender=conn)

        elif mtype == "GET_SYNC":
            snap = self.chain.state_snapshot("FULL_SYNC")
            snap["node_id"], snap["name"] = self.node_id, self.name
            self._send(conn, snap)

        elif mtype == "NEW_TX":
            tx = msg.get("tx")
            if tx and tx.get("txid"):
                key = tx["txid"]
                if key in self.seen_tx:
                    return
                self.seen_tx.add(key)
                if len(self.seen_tx) > 5000:
                    self.seen_tx = set(list(self.seen_tx)[-2000:])
                ok, why = self.chain.add_to_mempool(tx, source="network")
                if ok:
                    self.log_event("tx", f"Received tx {key[:14]}… from {msg.get('name', 'peer')}")
                    self.broadcast({"type": "NEW_TX", "tx": tx, "node_id": self.node_id,
                                    "name": self.name}, exclude=conn)

        elif mtype == "NEW_BLOCK":
            block = msg.get("block")
            if not block or block.get("hash") in self.seen_blocks:
                return
            self.seen_blocks.add(block.get("hash"))
            self._accept_remote_block(block, sender=conn)

        elif mtype == "TAMPER_ALERT":
            self._handle_tamper_alert(msg, sender=conn)

        elif mtype == "VOTE":
            key = (str(msg.get("hack_id")), str(msg.get("voter_id")))
            if key in self.seen_votes:
                return
            self.seen_votes.add(key)
            self.broadcast(msg, exclude=conn)
            self._tally_vote(msg)

        elif mtype == "VOTE_RESULT":
            key = (str(msg.get("hack_id")), bool(msg.get("approved")))
            if key in self.seen_results:
                return
            self.seen_results.add(key)
            with self.lock:
                if self.poll and self.poll.get("hack_id") == msg.get("hack_id"):
                    self.poll["approved"] = bool(msg.get("approved"))
                    self.poll["closed"] = True
            self.log_event("consensus", "Consensus REJECTED the rollback — tampered chain stays flagged."
                           if not msg.get("approved") else
                           "Consensus approved — recovery snapshot incoming.")
            self.broadcast(msg, exclude=conn)

        elif mtype == "RECOVERY":
            self._handle_recovery(msg, sender=conn)

    # ---------------------------------------------------------- adoption ----
    def _merge_snapshot(self, msg, sender=None, force=False):
        remote_chain = msg.get("chain")
        if not isinstance(remote_chain, list) or not remote_chain:
            return False
        try:
            remote_epoch = int(msg.get("epoch", 1))
        except (TypeError, ValueError):
            return False
        remote_bad = self.chain.first_bad_index(remote_chain) is not None

        snap = {"chain": remote_chain, "epoch": remote_epoch,
                "mempool": msg.get("mempool", []), "wallet_dir": msg.get("wallet_dir", {})}

        with self.chain.lock:
            local_epoch = self.chain.chain_epoch
            if remote_epoch < local_epoch:
                return False
            if remote_epoch > local_epoch:
                self.chain.load_snapshot(snap)
                self.chain.merge_wallet_dir(snap["wallet_dir"])
                self.log_event("sync", f"Adopted newer state (epoch {remote_epoch}) — chain height {len(remote_chain)-1}")
                self._post_adopt(remote_chain)
                return True

        local_bad = self.chain.first_bad_index() is not None
        fp = lambda c: crypto.sha256_hex(crypto.canonical_json(c))

        if force:
            adopt = True
        elif remote_bad and not local_bad:
            adopt = True    # a tampered chain must become visible network-wide
        elif not remote_bad and local_bad:
            adopt = False   # local stays tampered until consensus recovery
        elif len(remote_chain) != len(self.chain.chain):
            adopt = len(remote_chain) > len(self.chain.chain)
        else:
            adopt = fp(remote_chain) > fp(self.chain.chain)  # deterministic tie-break

        if not adopt:
            with self.chain.lock:
                self.chain.merge_wallet_dir(snap["wallet_dir"])
                self.chain.mempool_union(snap["mempool"])
            return False

        self.chain.load_snapshot(snap)
        self.chain.merge_wallet_dir(snap["wallet_dir"])
        if remote_bad:
            self.log_event("alert", f"TAMPERED CHAIN RECEIVED from {msg.get('name', 'peer')} — "
                                    f"validation fails at block #{self.chain.first_bad_index()}")
        self._post_adopt(remote_chain)
        return True

    def _post_adopt(self, remote_chain):
        # tip changed — the miner must rebuild its template from the new tip
        self.miner.template = None

    def _accept_remote_block(self, block, sender=None):
        with self.chain.lock:
            tip = self.chain.chain[-1]
            if self.chain.first_bad_index() is not None:
                self.log_event("alert", "Received a block while chain is tampered — ignored until recovery.")
                return False
            if block.get("index") == tip["index"] + 1:
                ok, reason = self.chain.validate_block(block, tip)
                if not ok:
                    self.log_event("sync", f"Rejected block #{block.get('index')} from peer: {reason}")
                    return False
                self.chain.apply_block(block)
                self.miner.template = None
                self.log_event("block", f"Verified + accepted block #{block['index']} mined by "
                                        f"{block.get('miner', '?')} (nonce {block.get('nonce'):,})")
                self.broadcast({"type": "NEW_BLOCK", "block": block, "node_id": self.node_id,
                                "name": self.name}, exclude=sender)
                return True
            if block.get("index") > tip["index"] + 1:
                self.log_event("sync", f"Peer is ahead (block #{block.get('index')}) — requesting full sync")
                self._send(sender, {"type": "GET_SYNC", "node_id": self.node_id, "name": self.name})
                return False
            return False

    # ------------------------------------------------- tamper / vote / fix ----
    def tamper_tip(self, note="manual tamper simulation"):
        """Demo mode: corrupt the newest block locally and alert the network."""
        # Refuse BEFORE mutating: tampering with no peers would poison the chain
        # permanently (clean chains are never adopted over a flagged one by design).
        eligible = self.connected_node_ids()
        if not eligible:
            return False, ("No connected peers to vote — the tamper demo needs at least "
                           "one other node on the network (connect one first).")
        with self.chain.lock:
            chain = self.chain.chain
            if len(chain) < 2:
                return False, "Mine at least one block before the tamper demo."
            # choose a tx to edit (a TRANSFER if present, else the coinbase amount)
            block = chain[-1]
            edited = None
            for tx in block.get("txs", []):
                if tx.get("type") == "TRANSFER":
                    tx["amount"] = int(tx.get("amount", 0)) + 999999
                    edited = f"transfer amount inflated by 999999 PATH"
                    break
            if edited is None:
                block["txs"][0]["amount"] = int(block["txs"][0].get("amount", 0)) + 999999
                edited = "coinbase reward inflated by 999999 PATH"
            block["tamper_note"] = str(note)
            self.chain.save()
            eligible = self.connected_node_ids()
            hack_id = crypto.sha256_hex(f"{self.chain.chain_epoch}|{self.node_id}|{time.time_ns()}|{block['index']}")
            msg = self.chain.state_snapshot("TAMPER_ALERT")
            msg.update({"node_id": self.node_id, "name": self.name, "hacker": self.name,
                        "hacker_node_id": self.node_id, "hack_id": hack_id,
                        "eligible_voters": eligible, "compromised_from": block["index"],
                        "tamper_note": edited})
        self.seen_hacks.add(hack_id)
        with self.lock:
            self.poll = {
                "hack_id": hack_id, "hacker": self.name,
                "compromised_from": block["index"], "note": edited,
                "eligible_voters": eligible, "votes": {}, "yes": 0, "no": 0,
                "required": len(eligible) // 2 + 1 if eligible else 0,
                "is_coordinator": True, "hidden": True, "has_voted": True,
                "created": time.time(),
            } if eligible else None
        self.log_event("alert", f"BLOCK #{block['index']} TAMPERED ({edited}) — alert broadcast to {len(eligible)} peer(s)")
        self.broadcast(msg)
        if not eligible:
            return False, "No connected peers to vote — connect another computer first."
        return True, f"Block #{block['index']} tampered and broadcast — waiting for network votes."

    def _handle_tamper_alert(self, msg, sender=None):
        hack_id = str(msg.get("hack_id") or "")
        if not hack_id:
            return
        first = hack_id not in self.seen_hacks
        self.seen_hacks.add(hack_id)
        # install the tampered chain so the damage is visible here too
        self._merge_snapshot(msg, sender=sender)
        if first:
            # relay the alert so multi-hop topologies (A—B—C) also see the vote;
            # seen_hacks de-duplication prevents broadcast storms
            self.broadcast(msg, exclude=sender)
        eligible = sorted({str(v) for v in msg.get("eligible_voters", []) if v})
        hacker_node = str(msg.get("hacker_node_id", ""))
        if first and eligible:
            with self.lock:
                self.poll = {
                    "hack_id": hack_id, "hacker": str(msg.get("hacker", "?")),
                    "compromised_from": msg.get("compromised_from"),
                    "note": msg.get("tamper_note", ""), "eligible_voters": eligible,
                    "votes": {}, "yes": 0, "no": 0,
                    "required": len(eligible) // 2 + 1,
                    "is_coordinator": hacker_node == self.node_id,
                    "hidden": hacker_node == self.node_id, "has_voted": False,
                    "created": time.time(),
                }
        self.log_event("alert", f"SECURITY ALERT — tampering by {msg.get('hacker', '?')} "
                                f"(block #{msg.get('compromised_from')}); consensus vote started")

    def cast_vote(self, vote_yes):
        with self.lock:
            poll = self.poll
            if not poll or poll.get("hidden") or poll.get("has_voted") or poll.get("closed"):
                return False, "No open vote for this node."
            if self.node_id not in poll.get("eligible_voters", []):
                return False, "This node is not an eligible voter."
            poll["has_voted"] = True
            hack_id, hacker = poll["hack_id"], poll["hacker"]
        msg = {"type": "VOTE", "node_id": self.node_id, "name": self.name,
               "voter_id": self.node_id, "voter_name": self.name,
               "hack_id": hack_id, "hacker": hacker, "vote": bool(vote_yes)}
        with self.lock:
            self.seen_votes.add((str(hack_id), self.node_id))
        self.broadcast(msg)
        self._tally_vote(msg)
        return True, ("YES vote broadcast — waiting for the network result." if vote_yes
                      else "NO vote broadcast — waiting for the network result.")

    def _tally_vote(self, msg):
        with self.lock:
            poll = self.poll
            if not poll or poll.get("hack_id") != msg.get("hack_id"):
                return
            voter = str(msg.get("voter_id"))
            if voter in poll["votes"]:
                return
            poll["votes"][voter] = bool(msg.get("vote"))
            poll["yes"] = sum(1 for v in poll["votes"].values() if v)
            poll["no"] = sum(1 for v in poll["votes"].values() if not v)
            eligible = set(poll["eligible_voters"])
            quorum = len(eligible) // 2 + 1
            all_voted = eligible.issubset(poll["votes"].keys())
            coordinator = poll.get("is_coordinator")
            if poll["yes"] >= quorum and coordinator:
                recover = True
            elif all_voted and coordinator:
                recover = False
            else:
                self.log_event("consensus", f"Vote tallied — YES {poll['yes']}, NO {poll['no']}, "
                                            f"needs {quorum} YES from {len(eligible)} eligible node(s)")
                return
        if recover:
            self._recover_from_hack(poll["hacker"])
        else:
            with self.lock:
                if self.poll and self.poll.get("hack_id") == poll["hack_id"]:
                    self.poll["approved"] = False
                    self.poll["closed"] = True
            res = {"type": "VOTE_RESULT", "node_id": self.node_id, "name": self.name,
                   "hack_id": poll["hack_id"], "approved": False,
                   "yes": poll["yes"], "no": poll["no"]}
            self.broadcast(res)
            self.log_event("consensus", f"Consensus REJECTED rollback ({poll['yes']} YES / {poll['no']} NO) — "
                                        "tampered chain remains flagged on the network")

    def _recover_from_hack(self, hacker_name):
        """Majority voted YES: roll back to the valid prefix, bump epoch, broadcast."""
        with self.chain.lock:
            chain = self.chain.chain
            bad = self.chain.first_bad_index()
            if bad is None:
                return
            retained = json.loads(json.dumps(chain[:bad]))
            removed = len(chain) - len(retained)
            balances = self.chain.compute_balances(retained)
            pending = []
            for tx in self.chain.mempool.values():
                sender = tx.get("from_addr")
                amount = int(tx.get("amount", 0))
                if balances.get(sender, 0) >= amount > 0:
                    pending.append(tx)
            self.chain.chain = retained
            self.chain.mempool = {t["txid"]: t for t in pending if t.get("txid")}
            self.chain.chain_epoch += 1
            self.chain.valid_cache = {}
            self.chain.sig_cache = {}
            self.chain.save()
            msg = self.chain.state_snapshot("RECOVERY")
            msg.update({"node_id": self.node_id, "name": self.name,
                        "first_removed_index": bad, "removed_count": removed,
                        "retained_count": len(retained), "hacker": hacker_name})
        with self.lock:
            if self.poll:
                self.poll["approved"] = True
                self.poll["closed"] = True
        self.miner.template = None
        self.log_event("consensus", f"RECOVERY COMMITTED — removed {removed} tampered block(s) "
                                    f"from #{bad}, kept {len(retained)} valid, epoch now {self.chain.chain_epoch}")
        self.broadcast(msg)

    def _handle_recovery(self, msg, sender=None):
        try:
            remote_epoch = int(msg.get("epoch", 1))
        except (TypeError, ValueError):
            return
        with self.chain.lock:
            if remote_epoch <= self.chain.chain_epoch:
                return
        self._merge_snapshot(msg, sender=sender, force=True)
        self.miner.template = None
        with self.lock:
            if self.poll:
                self.poll["approved"] = True
                self.poll["closed"] = True
        self.log_event("consensus", f"Recovery accepted from {msg.get('name', 'peer')} — "
                                    f"{msg.get('removed_count', '?')} tampered block(s) removed network-wide")

    # ------------------------------------------------------- UDP discovery ----
    def _discovery_payload(self, ptype):
        return {"type": ptype, "node_id": self.node_id, "name": self.name,
                "tcp_port": self.tcp_port, "http_port": self.http_port,
                "hosting": self.hosting, "height": len(self.chain.chain) - 1,
                "ips": [ip for _n, ip in local_interface_details()], "ts": time.time()}

    def _discovery_probe(self):
        packet = json.dumps(self._discovery_payload("PC_DISCOVER")).encode("utf-8")
        targets = {"255.255.255.255"}
        for _n, ip in local_interface_details():
            try:
                net = ipaddress.ip_network(f"{ip}/24", strict=False)
                targets.add(str(net.broadcast_address))
            except ValueError:
                continue
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            sock.settimeout(0.2)
            for target in targets:
                try:
                    sock.sendto(packet, (target, self.udp_port))
                except OSError:
                    continue

    def _discovery_listener(self):
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            except OSError:
                pass
            sock.bind(("0.0.0.0", self.udp_port))
            sock.settimeout(1.0)
            self.log_event("peer", f"LAN discovery listening on UDP {self.udp_port}")
            while not self.shutdown.is_set():
                try:
                    packet, addr = sock.recvfrom(8192)
                except socket.timeout:
                    continue
                except OSError:
                    break
                try:
                    msg = json.loads(packet.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
                if msg.get("node_id") == self.node_id:
                    continue
                if msg.get("type") == "PC_DISCOVER" and self.hosting:
                    try:
                        sock.sendto(json.dumps(self._discovery_payload("PC_NODE")).encode("utf-8"), addr)
                    except OSError:
                        pass
                elif msg.get("type") == "PC_NODE":
                    try:
                        port = int(msg.get("tcp_port", self.tcp_port))
                    except (TypeError, ValueError):
                        port = self.tcp_port
                    nid = str(msg.get("node_id", ""))
                    if not nid:
                        continue
                    with self.lock:
                        known = self.discovered.get(nid, {})
                        self.discovered[nid] = {
                            "node_id": nid, "name": str(msg.get("name", "PATH node")),
                            "ip": addr[0], "port": port, "http_port": int(msg.get("http_port", 80)),
                            "height": int(msg.get("height", 0) or 0),
                            "last_seen": time.time(), "connected": known.get("connected", False),
                        }
        except OSError as exc:
            self.log_event("error", f"UDP discovery unavailable: {exc}")

    def _auto_connect_loop(self):
        while not self.shutdown.is_set():
            with self.lock:
                candidates = [v for v in self.discovered.values()
                              if not v.get("connected") and time.time() - v.get("last_seen", 0) < DISCOVERY_TTL]
            for node in candidates:
                with self.lock:
                    ips = {p.get("ip") for p in self.peers.values()}
                    already = node["ip"] in ips or node["ip"] in [ip for _n, ip in local_interface_details()]
                if already:
                    continue
                ok, _why = self.connect_to(f"{node['ip']}:{node['port']}")
                if ok:
                    with self.lock:
                        if node["node_id"] in self.discovered:
                            self.discovered[node["node_id"]]["connected"] = True
            self.shutdown.wait(DISCOVERY_INTERVAL)

    def _check_poll_timeout(self):
        """Coordinator safety valve: a vote whose voters went silent must resolve,
        not hang. Quorum already reached -> recover; otherwise close as rejected."""
        with self.lock:
            poll = self.poll
            if (not poll or poll.get("closed") or not poll.get("is_coordinator")
                    or time.time() - poll.get("created", time.time()) < POLL_TIMEOUT):
                return
            quorum = len(poll.get("eligible_voters", [])) // 2 + 1
            recover = poll["yes"] >= quorum
            if recover:
                if self.chain.first_bad_index() is None:
                    poll["approved"], poll["closed"] = True, True
                    return
            else:
                poll["approved"], poll["closed"] = False, True
            hacker, hack_id = poll["hacker"], poll["hack_id"]
            yes, no, total = poll["yes"], poll["no"], len(poll.get("eligible_voters", []))
        if recover:
            self._recover_from_hack(hacker)
        else:
            res = {"type": "VOTE_RESULT", "node_id": self.node_id, "name": self.name,
                   "hack_id": hack_id, "approved": False, "yes": yes, "no": no}
            self.broadcast(res)
            self.log_event("consensus", f"Vote timed out ({yes} YES / {no} NO of {total} eligible) "
                                        "— no rollback; tampered chain remains flagged")

    def _periodic_sync_loop(self):
        while not self.shutdown.is_set():
            self._check_poll_timeout()
            if self.peers:
                snap = self.chain.state_snapshot("FULL_SYNC")
                snap["node_id"], snap["name"] = self.node_id, self.name
                self.broadcast(snap)
            self.shutdown.wait(SYNC_INTERVAL)

    def discovered_view(self):
        with self.lock:
            now = time.time()
            out = []
            for info in self.discovered.values():
                item = dict(info)
                if now - info.get("last_seen", 0) > DISCOVERY_TTL:
                    continue
                item["connected"] = any(p.get("ip") == info["ip"] for p in self.peers.values())
                out.append(item)
            return out

    def start(self):
        self.start_server()
        threading.Thread(target=self._discovery_listener, name="UDP-Discovery", daemon=True).start()
        threading.Thread(target=self._periodic_sync_loop, name="Periodic-Sync", daemon=True).start()
        threading.Thread(target=self._auto_connect_loop, name="Auto-Connect", daemon=True).start()
        self._discovery_probe()

    def stop(self):
        self.shutdown.set()
        self.hosting = False
        try:
            if self.server_sock:
                self.server_sock.close()
        except OSError:
            pass
