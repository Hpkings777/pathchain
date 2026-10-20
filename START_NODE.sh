#!/usr/bin/env bash
# PATHchain node launcher (macOS / Linux)
# Run me on every exhibition computer:  bash START_NODE.sh
cd "$(dirname "$0")"

if command -v python3 >/dev/null 2>&1; then
  exec python3 run.py "$@"
elif command -v python >/dev/null 2>&1; then
  exec python run.py "$@"
else
  echo ""
  echo " Python 3 was not found. Install it and run this script again:"
  echo "   macOS:  brew install python3   (or python.org/downloads)"
  echo "   Linux:  sudo apt install python3"
  echo ""
fi
