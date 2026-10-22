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
import os
import queue
import socket
import threading
import time
import uuid
from collections import deque

from . import crypto

MAX_LINE_BYTES = 8 * 1024 * 1024
SYNC_INTERVAL = 4.0
SYNC_HEARTBEAT = 20.0     # even when nothing changed, prove liveness this often
DISCOVERY_INTERVAL = 6.0
DISCOVERY_PROBE = 25.0    # periodic UDP re-probe (single boot probe gets lost on Wi-Fi)
DISCOVERY_TTL = 30.0
PEER_STALE_SECS = 45.0    # no message for this long -> the link is dead, drop it
PEERBOOK_INTERVAL = 20.0  # retry remembered peers (survives blocked UDP broadcast)
POLL_TIMEOUT = 45.0  # consensus vote must resolve — silent voters cannot hang it forever
PING_INTERVAL = 5.0  # latency probe cadence for the peer list


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
        self.peer_nid = {}           # node_id -> conn (duplicate-link dedup)
        self.peer_book_file = os.path.join(getattr(chain, "data_dir", "."), "peers.json")
        self._last_sync_fingerprint = None
        self._last_sync_broadcast = 0.0
        self._last_probe = 0.0
        self._last_peerbook = 0.0
        self._last_sweep = 0.0
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

    def _add_peer(self, conn, addr, direction="in"):
        with self.lock:
            if conn not in self.peers:
                self.peers[conn] = {"ip": addr[0], "port": addr[1], "name": "?", "direction": direction,
                                    "node_id": None, "height": 0, "last_seen": time.time()}
                self.send_locks[conn] = threading.Lock()

    def _remove_peer(self, conn):
        with self.lock:
            info = self.peers.pop(conn, None)
            self.send_locks.pop(conn, None)
            nid = info.get("node_id") if info else None
            if nid and self.peer_nid.get(nid) is conn:
                self.peer_nid.pop(nid, None)
        if info:
            self.log_event("peer", f"Peer disconnected: {info.get('name')} ({info.get('ip')})")
        try:
            conn.close()
        except OSError:
            pass

    # ------------------------------------------------------ peer memory ----
    def _remember_peer(self, ip, port, name):
        """Persist successful peers so future boots reconnect even if UDP
        broadcast is blocked by the network (a common school-WiFi quirk)."""
        try:
            book = {"peers": []}
            try:
                with open(self.peer_book_file, "r", encoding="utf-8") as f:
                    book = json.load(f)
            except (OSError, ValueError):
                pass
            entries = [p for p in book.get("peers", [])
                       if isinstance(p, dict) and p.get("ip")]
            entries = [p for p in entries
                       if not (p["ip"] == ip and int(p.get("port", 0)) == int(port))]
            entries.insert(0, {"ip": ip, "port": int(port), "name": name or "",
                               "ts": time.time()})
            book["peers"] = entries[:40]
            tmp = self.peer_book_file + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(book, f, indent=1)
            os.replace(tmp, self.peer_book_file)
        except OSError:
            pass

    def _load_peer_book(self):
        try:
            with open(self.peer_book_file, "r", encoding="utf-8") as f:
                book = json.load(f)
            return [(str(p["ip"]), int(p.get("port", self.tcp_port)))
                    for p in book.get("peers", []) if p.get("ip")][:40]
        except (OSError, ValueError, TypeError):
            return []

    def _dedup_link(self, conn, nid):
        """Two sockets to the same node can exist (both sides dial at once).
        Keep exactly one, deterministically: prefer our OUTBOUND socket when
        our node_id is lower, else the INBOUND one — both sides agree without
        negotiating. Duplicates double every message and confuse the peer list."""
        drop = None
        with self.lock:
            other = self.peer_nid.get(nid)
            if other is None or other is conn:
                self.peer_nid[nid] = conn
                return
            if other not in self.peers:          # stale mapping — replace it
                self.peer_nid[nid] = conn
                return
            mine_less = self.node_id < nid
            new_info = self.peers.get(conn)
            other_info = self.peers.get(other)
            keep = other
            if new_info and other_info:
                want_out = mine_less
                if (new_info.get("direction") == "out") == want_out:
                    keep = conn
            drop = conn if keep is other else other
        if drop is conn:
            self.log_event("peer", "Duplicate link — this socket is redundant, closing")
            self._remove_peer(conn)
        else:
            self.log_event("peer", "Duplicate link to the same node — dropping the extra socket")
            self._remove_peer(drop)
            with self.lock:
                if conn in self.peers:
                    self.peer_nid[nid] = conn

    def peer_view(self):
        with self.lock:
            now = time.time()
            out = []
            for info in self.peers.values():
                item = dict(info)
                item["lag"] = round(now - info.get("last_seen", now), 1)
                rtt = info.get("rtt_ms")
                item["rtt_ms"] = int(rtt) if rtt is not None else None
                item["status"] = "connected" if item["lag"] < 8 else "stale"
                out.append(item)
            return out

    # ------------------------------------------------------------ latency ----
    def _ping_loop(self):
        """Measure true TCP round-trip time to every peer (PING/PONG wire msgs)
        so the peer list can show live latency — and reap links that went
        silent (half-open TCP after a phone sleeps / Wi-Fi blip would otherwise
        linger forever and block reconnection)."""
        while not self.shutdown.is_set():
            now = time.time()
            stale = []
            with self.lock:
                conns = [(conn, info.get("name")) for conn, info in self.peers.items()
                         if info.get("node_id")]
                for conn, _name in conns:
                    info = self.peers.get(conn)
                    if info is not None:
                        if now - info.get("last_seen", now) > PEER_STALE_SECS:
                            stale.append((conn, info.get("name", "?")))
                            continue
                        info["ping_sent"] = now
                # dead links that never completed HELLO get the same treatment
                for conn, info in list(self.peers.items()):
                    if not info.get("node_id") and now - info.get("last_seen", now) > PEER_STALE_SECS:
                        stale.append((conn, info.get("name", "?")))
            for conn, name in stale:
                self.log_event("peer", f"Link to {name} went quiet "
                                       f"({PEER_STALE_SECS:.0f}s) — dropping, will auto-retry")
                self._remove_peer(conn)
            for conn, _name in conns:
                if conn in stale:
                    continue
                self._send(conn, {"type": "PING", "ts": time.time(),
                                  "node_id": self.node_id, "name": self.name})
            self.shutdown.wait(PING_INTERVAL)

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
        own = {n for _l, n in local_interface_details()}
        if ip in own and int(port) == self.tcp_port:
            return False, "That is this node — connect to ANOTHER computer's address"
        with self.lock:
            for info in self.peers.values():
                if info.get("ip") == ip and info.get("node_id"):
                    return False, f"Already connected to {info.get('name')} (duplicate peers are ignored)"
            if time.time() - self.failed_connects.get(f"{ip}:{port}", 0) < 5:
                return False, f"Retrying {ip} too quickly — wait a moment"
        try:
            conn = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            conn.settimeout(4.0)
            conn.connect((ip, int(port)))
            conn.settimeout(1.0)
            self._add_peer(conn, (ip, int(port)), direction="out")
            threading.Thread(target=self._peer_loop, args=(conn, (ip, int(port))), daemon=True).start()
            self.log_event("peer", f"Connecting to {ip}:{port} — handshake + initial sync…")
            return True, f"Connecting to {ip}:{port}"
        except OSError as exc:
            with self.lock:
                self.failed_connects[f"{ip}:{port}"] = time.time()
            reason = str(exc)
            if "refused" in reason.lower():
                hint = (f"nothing answered on {ip}:{port} — is PATHchain running there, "
                        f"and is {port} the peer (TCP) port?")
            elif "timed out" in reason.lower() or "unreachable" in reason.lower():
                hint = (f"{ip}:{port} did not answer in time — a firewall is probably blocking "
                        f"TCP port {port}. Allow port {port} (and UDP {self.udp_port} for discovery) "
                        f"in that computer's firewall, then retry.")
            elif "network" in reason.lower():
                hint = "that network is unreachable — check both computers are on the same LAN"
            else:
                hint = reason
            return False, f"Connection to {ip}:{port} failed: {hint}"

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
        new_peer = False
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
                new_peer = (msg.get("type") == "HELLO")
            if msg.get("type") == "HELLO" and msg.get("tcp_port"):
                info["port"] = int(msg["tcp_port"])
        if msg.get("type") == "HELLO":
            # both sides dial each other on the LAN all the time — make sure
            # only ONE socket survives, or every message arrives twice
            self._dedup_link(conn, nid)
            if new_peer:
                self._remember_peer(info.get("ip"), info.get("port"), info.get("name"))
                # greet the newcomer with a full snapshot immediately — do not
                # make it wait for the next periodic sync
                threading.Thread(target=self._send_snapshot_to, args=(conn,),
                                 daemon=True).start()

    def _send_snapshot_to(self, conn):
        snap = self.chain.state_snapshot("FULL_SYNC")
        snap["node_id"], snap["name"] = self.node_id, self.name
        snap["active_poll"] = self._poll_summary()
        self._send(conn, snap)

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

        elif mtype == "PING":
            self._send(conn, {"type": "PONG", "ts": msg.get("ts"),
                              "node_id": self.node_id, "name": self.name})

        elif mtype == "PONG":
            sent = msg.get("ts")
            try:
                rtt = (time.time() - float(sent)) * 1000.0
            except (TypeError, ValueError):
                return
            with self.lock:
                info = self.peers.get(conn)
                if info is not None:
                    prev = info.get("rtt_ms")
                    info["rtt_ms"] = rtt if prev is None else prev * 0.6 + rtt * 0.4

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
            self._adopt_remote_poll(msg)
            return False

        self.chain.load_snapshot(snap)
        self.chain.merge_wallet_dir(snap["wallet_dir"])
        if remote_bad:
            self.log_event("alert", f"TAMPERED CHAIN RECEIVED from {msg.get('name', 'peer')} — "
                                    f"validation fails at block #{self.chain.first_bad_index()}")
        self._post_adopt(remote_chain)
        self._adopt_remote_poll(msg)
        return True

    def _adopt_remote_poll(self, msg):
        """Poll persistence across reconnects: if a snapshot carries an open
        consensus vote we know nothing about, reconstruct the vote UI locally."""
        rp = msg.get("active_poll")
        if not isinstance(rp, dict) or not rp.get("hack_id"):
            return
        with self.lock:
            if self.poll and (self.poll.get("hack_id") == rp.get("hack_id")
                              or not self.poll.get("closed")):
                return                      # already tracking it / local vote wins
            votes = {str(k): bool(v) for k, v in (rp.get("votes") or {}).items()}
            self.poll = {
                "hack_id": rp["hack_id"], "hacker": rp.get("hacker", "?"),
                "compromised_from": rp.get("compromised_from"), "note": rp.get("note", ""),
                "eligible_voters": list(rp.get("eligible_voters", [])),
                "votes": votes,
                "yes": sum(1 for v in votes.values() if v),
                "no": sum(1 for v in votes.values() if not v),
                "required": rp.get("required") or (len(rp.get("eligible_voters", [])) // 2 + 1),
                "is_coordinator": False, "hidden": False,
                "has_voted": self.node_id in votes, "closed": bool(rp.get("closed")),
                "approved": bool(rp.get("approved")), "created": rp.get("created", time.time()),
            }
        self.log_event("consensus", f"Rebuilt open consensus vote from peer snapshot "
                                    f"(tamper by {rp.get('hacker', '?')})")

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
    def tamper_tip(self, note="manual tamper simulation", index=None):
        """Demo mode: corrupt a block's data locally and alert the network.
        `index` defaults to the tip; any non-genesis block can be chosen so the
        chain view can show downstream damage."""
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
            if index is None or not isinstance(index, int):
                index = len(chain) - 1
            index = int(index)
            if index < 1:
                return False, ("The genesis block is the root of trust — every other block "
                               "chains back to it. Pick block #1 or later for the demo.")
            index = max(1, min(len(chain) - 1, index))
            block = chain[index]
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

    def rollback_to_valid(self):
        """Manual 'Reset chain' (no vote): truncate at the first invalid block,
        bump the epoch and broadcast RECOVERY so every peer adopts the fix."""
        with self.chain.lock:
            bad = self.chain.first_bad_index()
            if bad is None:
                return False, "Chain is already fully valid — nothing to reset."
            if bad < 1:
                return False, "Genesis block is damaged — delete the data folder to start over."
            removed = len(self.chain.chain) - bad
            self.chain.chain = json.loads(json.dumps(self.chain.chain[:bad]))
            self.chain.chain_epoch += 1
            self.chain.valid_cache = {}
            self.chain.sig_cache = {}
            # mempool: drop anything no longer affordable on the truncated chain
            balances = self.chain.compute_balances()
            kept = {}
            for txid, tx in self.chain.mempool.items():
                amt = int(tx.get("amount", 0))
                if tx.get("from_addr") and 0 < amt <= balances.get(tx.get("from_addr"), 0):
                    kept[txid] = tx
            self.chain.mempool = kept
            self.chain.save()
            msg = self.chain.state_snapshot("RECOVERY")
            msg.update({"node_id": self.node_id, "name": self.name,
                        "first_removed_index": bad, "removed_count": removed,
                        "retained_count": bad, "hacker": "manual reset"})
        with self.lock:
            if self.poll:
                self.poll["approved"], self.poll["closed"] = True, True
        self.miner.template = None
        self.log_event("consensus", f"MANUAL RESET — removed {removed} invalid block(s) from #{bad}, "
                                    f"chain height now {bad - 1}, epoch now {self.chain.chain_epoch}")
        self.broadcast(msg)
        return True, f"Chain restored to block #{bad - 1} — {removed} tampered block(s) removed."

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
                superseded = self.poll and not self.poll.get("closed") and \
                    self.poll.get("hack_id") != hack_id
                if superseded:
                    self.log_event("consensus", "A newer tamper alert superseded the open vote (latest wins)")
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
            if not poll or poll.get("hidden") or poll.get("closed"):
                return False, "No open vote for this node."
            if self.node_id not in poll.get("eligible_voters", []):
                return False, "This node is not an eligible voter."
            replacing = poll.get("has_voted", False)
            poll["has_voted"] = True
            hack_id, hacker = poll["hack_id"], poll["hacker"]
        msg = {"type": "VOTE", "node_id": self.node_id, "name": self.name,
               "voter_id": self.node_id, "voter_name": self.name,
               "hack_id": hack_id, "hacker": hacker, "vote": bool(vote_yes)}
        with self.lock:
            self.seen_votes.discard((str(hack_id), self.node_id))   # a changed vote re-broadcasts
            self.seen_votes.add((str(hack_id), self.node_id))
        self.broadcast(msg)
        self._tally_vote(msg)
        return True, (("Vote UPDATED to " if replacing else "YES vote broadcast — ")
                      if vote_yes else ("Vote UPDATED to " if replacing else "NO vote broadcast — ")) + \
            ("ROLLBACK (YES)." if vote_yes else "KEEP (NO) — waiting for the network result.")

    def _tally_vote(self, msg):
        with self.lock:
            poll = self.poll
            if not poll or poll.get("hack_id") != msg.get("hack_id"):
                return
            voter = str(msg.get("voter_id"))
            # re-vote replaces the previous choice (spec: one vote per peer, changeable)
            poll["votes"][voter] = bool(msg.get("vote"))
            poll["yes"] = sum(1 for v in poll["votes"].values() if v)
            poll["no"] = sum(1 for v in poll["votes"].values() if not v)
            poll["has_voted"] = poll.get("has_voted") or voter == self.node_id
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

    def _poll_summary(self):
        """Public view of the active consensus vote — travels inside FULL_SYNC
        snapshots so a peer that reconnects rebuilds the vote UI instead of
        silently missing an open poll."""
        with self.lock:
            if not self.poll:
                return None
            p = self.poll
            return {"hack_id": p.get("hack_id"), "hacker": p.get("hacker"),
                    "compromised_from": p.get("compromised_from"), "note": p.get("note"),
                    "eligible_voters": list(p.get("eligible_voters", [])),
                    "votes": dict(p.get("votes", {})), "yes": p.get("yes", 0),
                    "no": p.get("no", 0), "required": p.get("required"),
                    "closed": bool(p.get("closed")), "approved": bool(p.get("approved")),
                    "created": p.get("created")}

    def _periodic_sync_loop(self):
        """Chain sync + housekeeping. The snapshot contains the WHOLE chain, so
        it is broadcast only when something actually changed (tip / epoch /
        mempool / open vote) — with a 20s liveness heartbeat. Broadcasting a
        2000-block chain every 4s would melt the school Wi-Fi by the afternoon."""
        while not self.shutdown.is_set():
            self._check_poll_timeout()
            if self.peers:
                fp = self._sync_fingerprint()
                now = time.time()
                unchanged = (fp == self._last_sync_fingerprint)
                if not unchanged or now - self._last_sync_broadcast > SYNC_HEARTBEAT:
                    self._last_sync_fingerprint = fp
                    self._last_sync_broadcast = now
                    snap = self.chain.state_snapshot("FULL_SYNC")
                    snap["node_id"], snap["name"] = self.node_id, self.name
                    snap["active_poll"] = self._poll_summary()
                    self.broadcast(snap)
            self._probe_tick()
            self._peerbook_tick()
            self.shutdown.wait(SYNC_INTERVAL)

    def _sync_fingerprint(self):
        with self.chain.lock:
            tip = self.chain.chain[-1]
            fp = (tip["index"], tip["hash"], self.chain.chain_epoch,
                  len(self.chain.mempool))
        poll_id = None
        with self.lock:
            if self.poll and not self.poll.get("closed"):
                poll_id = self.poll.get("hack_id")
        return fp + (poll_id,)

    def _probe_tick(self):
        """UDP discovery re-probe. A single broadcast at boot is one lost
        packet away from 'my app can't find anyone' — school Wi-Fi drops
        broadcast frames all the time, so keep announcing ourselves."""
        now = time.time()
        if now - self._last_probe < DISCOVERY_PROBE:
            return
        self._last_probe = now
        try:
            self._discovery_probe()
        except Exception:
            pass

    def _peerbook_tick(self):
        """Auto-heal: reconnect remembered peers (covers blocked UDP broadcast
        and one side rebooting). Backoff via failed_connects keeps it polite."""
        now = time.time()
        if now - self._last_peerbook < PEERBOOK_INTERVAL:
            return
        self._last_peerbook = now
        with self.lock:
            connected_ips = {i.get("ip") for i in self.peers.values()}
        for ip, port in self._load_peer_book():
            if self.shutdown.is_set():
                return
            if ip in connected_ips:
                continue
            if now - self.failed_connects.get(f"{ip}:{port}", 0) < 60:
                continue
            ok, _m = self.connect_to(f"{ip}:{port}")
            if ok:
                self.log_event("peer", f"Re-connected to remembered peer {ip}:{port}")
                return  # one per cycle — stay gentle on flaky links
        # last resort: many school networks isolate clients (UDP broadcast never
        # arrives). If we still have NO peers and NO book, sweep the subnet's
        # peer port once in a while — two nodes on one LAN will find each other.
        if not self.peers and not self._load_peer_book():
            self._subnet_sweep()

    SUBNET_SWEEP_INTERVAL = 45.0

    def _subnet_sweep(self):
        """Probe our own peer port on every host of our /24 (batched threads,
        0.3s timeouts) and connect to whatever answers. Runs ONLY while the
        node is peerless, so a healthy mesh never scans."""
        now = time.time()
        if now - self._last_sweep < self.SUBNET_SWEEP_INTERVAL:
            return
        self._last_sweep = now
        my_ip = next((ip for _n, ip in local_interface_details() if not ip.startswith("127.")), None)
        if not my_ip or "." not in my_ip:
            return
        prefix = my_ip.rsplit(".", 1)[0]
        candidates = [f"{prefix}.{i}" for i in range(1, 255)
                      if f"{prefix}.{i}" != my_ip]
        found = []
        sem = threading.Semaphore(48)

        def probe(ip):
            with sem:
                if self.shutdown.is_set():
                    return
                s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s.settimeout(0.3)
                try:
                    if s.connect_ex((ip, self.tcp_port)) == 0:
                        found.append(ip)
                finally:
                    try:
                        s.close()
                    except OSError:
                        pass

        threads = [threading.Thread(target=probe, args=(ip,), daemon=True) for ip in candidates]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=2.0)
        for ip in found[:4]:          # cap: a classroom rarely needs more per sweep
            if self.shutdown.is_set():
                return
            with self.lock:
                if any(i.get("ip") == ip for i in self.peers.values()):
                    continue
            ok, _m = self.connect_to(f"{ip}:{self.tcp_port}")
            if ok:
                self.log_event("peer", f"Subnet sweep found a PATHchain node at {ip}:{self.tcp_port} — connected")

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
        threading.Thread(target=self._ping_loop, name="Latency-Ping", daemon=True).start()
        # probe three times in quick succession — any single broadcast frame can
        # be dropped by the access point, and the first minute of a demo is
        # exactly when the room is watching
        for delay in (0.0, 1.5, 3.0):
            threading.Thread(target=self._delayed_probe, args=(delay,), daemon=True).start()

    def _delayed_probe(self, delay):
        self.shutdown.wait(delay)
        if not self.shutdown.is_set():
            try:
                self._discovery_probe()
            except Exception:
                pass

    def stop(self):
        self.shutdown.set()
        self.hosting = False
        try:
            if self.server_sock:
                self.server_sock.close()
        except OSError:
            pass
