"""
PATHchain node — application entry point and wiring.

    python run.py                 # default ports 9573/9574/9575
    python run.py --name LAB-01 --blocktime 10
    python run.py --http 8080     # all ports shift automatically
"""

import argparse
import os
import sys
import time

# allow running as a plain folder copy: python run.py
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pathchain.blockchain import Blockchain, TARGET_BLOCK_TIME  # noqa: E402
from pathchain.miner import Miner                              # noqa: E402
from pathchain.node import Node, local_interface_details       # noqa: E402
from pathchain.server import App, start_http                   # noqa: E402
from pathchain.bots import MarketEngine, BotMinerPool          # noqa: E402


def banner(app, args):
    lan_ip = next((ip for _n, ip in local_interface_details() if not ip.startswith("127.")), "127.0.0.1")
    line = "=" * 62
    print(f"""
{line}
  PATHchain node  —  the PATH currency network (school demo)
{line}
  Web explorer : http://localhost:{args.http}
  On your LAN  : http://{lan_ip}:{args.http}   <- open this from other computers
  Peer port    : TCP {args.tcp}   Discovery: UDP {args.udp}
  Node name    : {args.name}
  Data folder  : {os.path.abspath(args.datadir)}

  Currency     : PATH   Block reward: 10 PATH
  Block target : every {args.blocktime}s (difficulty auto-retargets)
  Bot engine   : markets + bot miners ON (configure in the explorer Settings)

  Share this on other machines:  python run.py --connect {lan_ip}:{args.tcp}
  (or just start it — LAN discovery connects everyone automatically)
{line}
""")


def main():
    parser = argparse.ArgumentParser(description="PATHchain — school exhibition blockchain node")
    parser.add_argument("--name", default=None, help="node name shown across the LAN")
    parser.add_argument("--http", type=int, default=9573, help="web/API port")
    parser.add_argument("--tcp", type=int, default=9574, help="peer port")
    parser.add_argument("--udp", type=int, default=9575, help="discovery port")
    parser.add_argument("--blocktime", type=float, default=TARGET_BLOCK_TIME, help="target seconds per block")
    parser.add_argument("--maxbits", type=int, default=6, help="max difficulty (leading zeros). Use 5 on 1-2 computers, 6 for 3+")
    parser.add_argument("--datadir", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))
    parser.add_argument("--connect", default=None, help="connect to a peer IP:port at startup")
    parser.add_argument("--fresh", action="store_true", help="start a brand-new chain (ignores saved data)")
    args = parser.parse_args()

    if not args.name:
        host = os.uname().nodename if hasattr(os, "uname") else os.environ.get("COMPUTERNAME", "PC")
        args.name = f"NODE-{host}"[:20]

    if args.fresh and os.path.isdir(args.datadir):
        import shutil
        shutil.rmtree(args.datadir, ignore_errors=True)

    import pathchain.blockchain as bc
    bc.set_limits(max_bits=args.maxbits, target_time=max(4.0, float(args.blocktime)))

    chain = Blockchain(args.datadir, args.name)
    app_holder = {}

    def log_event(kind, text):
        app_holder.get("app").log(kind, text) if "app" in app_holder else print(f"[{kind}] {text}")

    miner = Miner(chain, events=log_event)
    node = Node(chain, miner, args.name, args.tcp, args.udp, args.http, events=log_event)
    market = MarketEngine(args.datadir, events=log_event)
    bot_miners = BotMinerPool(chain, market, node, events=log_event)
    app = App(chain, miner, node, market=market, bot_miners=bot_miners)
    app_holder["app"] = app

    node.start()
    miner.start_thread()
    market.start()
    market_cfg = market.view_config()
    if market_cfg.get("enabled") and int(market_cfg.get("miners", 0)) > 0:
        bot_miners.start()
    start_http(app, args.http)
    banner(app, args)

    if args.connect:
        import threading
        threading.Thread(target=lambda: (time.sleep(1.0), node.connect_to(args.connect)), daemon=True).start()

    try:
        while True:
            time.sleep(30)
            chain.save()  # periodic checkpoint
    except KeyboardInterrupt:
        print("\nShutting down PATHchain node…")
        market.stop()
        bot_miners.stop()
        node.stop()
        chain.save()


if __name__ == "__main__":
    main()
