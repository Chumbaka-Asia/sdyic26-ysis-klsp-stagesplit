#!/usr/bin/env bash
cd "$(dirname "$0")"
[ -d venv ] || { echo "Run ./setup.sh first."; exit 1; }
source venv/bin/activate
( sleep 1.5; (command -v open >/dev/null && open http://localhost:8000) || (command -v xdg-open >/dev/null && xdg-open http://localhost:8000) ) >/dev/null 2>&1 &
python app.py
