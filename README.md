# PATHchain — a real blockchain for your school exhibition

**PATH** is your school's own cryptocurrency, running on your own LAN, with a
blockchain.com-style explorer in the browser. Every block, transaction and
hash on this site is real — there is **no mock data anywhere in the chain**.
The single deliberate exception is the Markets page: PATH/USD pricing is a
transparent simulation (it has to be — PATH isn't traded anywhere), and it is
always labelled as such. Real-coin prices (BTC, ETH, …) come from a public
market API when the internet is available and are never invented.

> PATH is an educational demo. It has no monetary value and is not connected
> to Bitcoin or any real network.

---


## What's new in this build (v2)

- **Chain view** — the blockchain as a living flowchart: block cards linked by
  animated arrows, new blocks slide in with a glow pulse, clicking any card
  opens a slide-in panel with the full header, Merkle root and transactions.
- **Tamper theatre** — edit a block from the chain view: the card shakes, the
  hash flickers to its recomputed (mismatched) value, every downstream block
  flashes "Integrity broken", the arrows turn red and dash-animate, peers vote
  in a consensus overlay with animated rejection stamps, and **Reset chain**
  (or a majority vote) rolls everything back with a reverse animation.
- **Bot engine + live market** — up to 50 bots trade a transparently simulated
  PATH/USD market on two venues (DEX + Secondary): mean-reversion + momentum
  traders, market makers that widen spreads on volatility, arbitrageurs that
  close the inter-venue spread, and miner bots that mine REAL SHA-256 blocks.
  Configure everything in Settings (bot count, type mix, regime, tick rate,
  base price, volatility, aggression, mining power). Prices stream to the UI
  over SSE and are eased every animation frame — no jumpy updates.
- **Market page v2** — candlesticks with volume, live order-book ladder with
  animated level changes, depth chart, trade prints, and a site-wide ticker
  tape (price, 24 h change, volume, bot count, regime).
- **Networking upgrades** — peer latency (ping) in the Network page, one-click
  connect for discovered-but-not-connected peers, self-connection and duplicate
  guards, firewall-aware error messages, exponential backoff with a visible
  "Reconnecting…" chip, and a retry/discard queue for ops dropped mid-outage.
- **Consensus improvements** — votes are idempotent per peer and can be changed
  before the poll closes; open polls survive reconnects (they travel in sync
  snapshots); concurrent tamper alerts resolve latest-wins; destructive actions
  need a 3-second-delayed confirm.
- **Design system v2** — layered elevation shadows, purposeful micro-animations
  (press scale 0.96, hover glows, staggered entrances), visible focus rings,
  full `prefers-reduced-motion` fallbacks, dark theme default + light theme
  toggle, and 60 fps-only animations (transform/opacity).

### Polish round (merged & hardened)

- **Bandwidth**: SSE market frames now ship candles ~1×/second instead of at the
  raw tick rate (the client caches them) — a frame drops from ~24 KB to ~4 KB,
  which is the difference between 30 phones streaming fine and melting the AP.
  Chain snapshots broadcast only when something changed (20 s heartbeat).
- **LAN auto-heal**: duplicate links are deduped deterministically, silent links
  are reaped after 45 s and retried, peers are remembered across reboots
  (survives blocked UDP broadcast), UDP discovery re-probes periodically, and a
  peerless node sweeps its /24 peer port as a last resort — two machines find
  each other even on client-isolated school Wi-Fi.
- **Economy safety nets**: drained bots are re-capitalised ("new participants
  enter the market") and the books re-anchor if the price ever escapes its
  sanity band — an hours-long demo can no longer bankrupt the market.
- **True forensics**: the block page runs the node's real validator and shows
  its verdict + human reason (covers inflated-amount edits, which leave the
  header hash untouched); the genesis block refuses tampering outright.
- **Wallet realism**: private keys are masked behind a Reveal button with the
  warning a real wallet gives you; bot wallets are badged BOT.
- **Guided tour v2**: 10 steps covering the ticker tape, the living chain view,
  the tamper theatre, the bot market, the Settings studio and the consensus demo.
- Roster math now honours the exact bot count (largest-remainder apportionment),
  `/api/block` + `/api/tx` return proper 404-style errors, and log lines can no
  longer interleave into garbage.

Everything still runs on **Python 3.8+ stdlib only** — no pip installs, no
Node.js, no internet required. The market remains a clearly-labelled
simulation; bot miner blocks are real proof-of-work on the real chain.

---

## Quick start (60 seconds)

Requirements: **Python 3.8+ only. No pip installs, no internet, no Node.js.**

```
PATHchain/
├── run.py            ← the whole node (blockchain + P2P + web explorer)
├── pathchain/        ← Python source
├── static/           ← the explorer website (vanilla HTML/CSS/JS)
├── START_NODE.bat    ← Windows double-click launcher
└── START_NODE.sh     ← Mac / Linux launcher
```

### Computer 1 (the "host")
1. Copy the whole `PATHchain` folder to the computer.
2. Double-click `START_NODE.bat` (Windows) or run `bash START_NODE.sh`.
3. A console opens and prints something like:

   ```
   Web explorer : http://localhost:9573
   On your LAN  : http://192.168.1.27:9573   <- open this from other computers
   ```

4. Open the local URL in the browser.

### Computer 2, 3, 4 … (miners / wallets)
1. Copy the same folder to each computer (a USB stick is perfect).
2. Start it the same way — **that's it.** Nodes find each other automatically
   over UDP broadcast and connect within ~6 seconds.
3. If auto-discovery is blocked (some school Wi-Fis isolate devices), connect
   manually: on node 2 open **Network page → connect box** and type the
   first computer's `IP:9574`.

> Every node remembers its chain in `data/` and resumes after a restart.
> Delete the `data/` folder (or start with `--fresh`) for a brand-new chain.

---

## The 5-minute exhibition demo script

0. **Guided tour (for visitors exploring on their own)** — the **?** button in
   the top bar (or "Guided tour" in the mobile *More* sheet) walks through all
   eight highlights with a spotlight: markets, live stats, mining, wallets,
   the tamper demo and the price engine. First-time visitors also get a small
   "Take the 60-second tour" card. Use it when a crowd wants to self-explore.
1. **Explorer (home page)** — point at the live stats: blocks mined, supply,
   difficulty, hashrate. "Every number is computed from real blocks on this
   network — nothing is fake."
2. **Wallet** — create a wallet on two different computers. Use *Show keys*:
   "this is a real secp256k1 keypair — the same curve as Bitcoin; the address
   is a Bitcoin-style Base58Check address."
3. **Send PATH** — send 5 PATH from computer 1 to computer 2. It lands in the
   **mempool**: "the transaction is signed with ECDSA — but a signature alone
   doesn't confirm anything. It waits for a *miner*."
4. **Mining Lab (the star of the show)**
   - Press **TRY 1 NONCE** a few times (or the SPACE bar). The class sees:
     nonce 1 → hash `3f9a…` ✗, nonce 2 → hash `77bd…` ✗ …
   - "SHA-256 is a lottery. We need a hash starting with 4 zeros. Nobody can
     *calculate* the winning nonce — the only way is to try, on average,
     16×16×16×16 = 65,536 times. That wasted work IS the security."
   - Turn on **AUTO-MINING** on two computers at once → a real **block race**.
     Whichever block wins spreads through the network; the loser's work is
     discarded exactly like orphan blocks in Bitcoin.
   - Show the **difficulty chart**: when blocks come too fast, the network
     automatically raises the target (4 zeros → 5 zeros) — that is Bitcoin's
     difficulty retargeting, live.
5. **Markets (the hook)** — open the **Markets** page: a live PATH/USD chart
   like a real exchange. Be upfront: the price is a simulation, but an honest
   one — a deterministic hash-chain walk (identical on every device) plus a
   **live activity factor** computed from this chain's real supply,
   transactions, hashrate and mempool. Mine a block or send a transfer and
   watch the price react. Real coins (BTC, ETH, …) come from a public market
   API when the internet is reachable; offline they show their last known
   value, clearly labelled.
6. **Attack demo (the mic-drop)** — on the Network page press
   **Simulate tampering**. Every computer instantly turns RED because the
   edited transaction no longer matches its signature. The network votes;
   majority YES rolls the chain back to the last valid block and bumps the
   epoch — "to rewrite history you'd have to re-mine every block faster than
   the entire honest network combined. That's why blockchains are tamper-proof."

---

## What to say when someone asks "how does mining actually work?"

A block is committed by repeating exactly four steps thousands of times:

```
contents = header(previous hash, merkle root, timestamp, difficulty, miner) + nonce
hash     = SHA-256(contents)
if hash starts with "00000"  ->  YOU WIN, broadcast the block
else                         ->  nonce += 1, try again
```

* The **nonce** is the only number that changes — see the live header diagram
  on the Mining Lab page.
* The **target** (number of leading zeros) is adjusted by the network every 8
  blocks so that one block takes roughly the target time no matter how many
  computers are mining.
* The **coinbase** transaction inside the block pays 10 new PATH to the miner
  — this is the *only* way PATH is ever created (same as Bitcoin).
* Everyone who receives the block **re-hashes the header once** and rejects it
  unless the target is met and every transaction signature verifies — cheating
  is therefore pointless.
* If two miners find blocks at the same height, the network follows the
  **longest valid chain**; the shorter one's blocks become orphans (watch it
  happen live on a 2-computer race!).

## What's under the hood (for the tech-check at the stall)

| Piece | Implementation | Where |
|---|---|---|
| Hashing | SHA-256 (Python stdlib) | `pathchain/blockchain.py` |
| Signatures | ECDSA on secp256k1, RFC-6979 nonces — **pure Python, zero deps** | `pathchain/crypto.py` |
| Addresses | Bitcoin-style P2PKH: `Base58Check(0x00 + RIPEMD160(SHA256(pubkey)))` | `pathchain/crypto.py` |
| Transactions | signed transfers + coinbase, merkle-root committed | `pathchain/blockchain.py` |
| Consensus | proof-of-work + longest valid chain + epoch-tagged rollback votes | `pathchain/blockchain.py`, `pathchain/node.py` |
| Networking | TCP JSON-lines peers (port 9574) + UDP LAN discovery (port 9575) | `pathchain/node.py` |
| Web | Python stdlib HTTP server + vanilla JS SPA, live updates every 1.5 s | `pathchain/server.py`, `static/` |
| Markets | PATH/USD simulated by a deterministic SHA-256 hash-chain walk + live chain-activity factor; real coins via public CoinGecko API with offline fallback | `static/js/market.js` |
| Storage | atomic JSON snapshots in `data/` — survives restarts | `pathchain/blockchain.py` |

Private keys never leave the computer: they live only in
`data/wallet_keys.json` and are **never** included in any block or network
packet. (The file is not encrypted — one more thing that makes this a demo,
not a bank.)

## Command-line options

```
python run.py --name LAB-03         # node name shown across the LAN
python run.py --http 8080           # shift all ports (web 8080, peers 8081, discovery 8082)
python run.py --blocktime 8         # aim for a block every ~8 s (default 15)
python run.py --maxbits 5           # cap difficulty at 5 zeros — use 5 for 1-2 computers, 6 for 3+
python run.py --connect 192.168.1.27:9574   # skip discovery, connect directly
python run.py --fresh               # ignore saved chain, start over
```

## Troubleshooting

| Problem | Fix |
|---|---|
| Other computers don't appear | School Wi-Fi may block UDP broadcast. Connect manually by IP (Network page). Both PCs must be on the same network. |
| "Cannot host TCP 9574" | Another node is already running on that PC with the same ports — use `--http 8080` (shifts all ports) or close the other one. |
| Windows asks about the firewall | Tick **Allow** for Python on **Private networks** — this is required for peer connections. |
| Mining feels too slow / too fast | Adjust `--blocktime` (target seconds) or `--maxbits` (difficulty ceiling). Difficulty also auto-adjusts every 8 blocks. |
| Browser shows old content | Hard-refresh (Ctrl+Shift+R) — the explorer normally self-refreshes. |
| Want to restart the whole economy | Delete the `data/` folder on every computer (or run with `--fresh`), then start again. |

Have a great exhibition! ⛏
