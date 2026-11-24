#!/usr/bin/env bash
# One-time setup for Mac/Linux: creates the venv folder and installs packages.
set -e
cd "$(dirname "$0")"
PY=$(command -v python3 || command -v python) || { echo "Python not found. Install it from https://www.python.org"; exit 1; }
if [ ! -d venv ]; then
  echo "Creating virtual environment in ./venv ..."
  "$PY" -m venv venv
fi
source venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt
[ -f .env ] || cp .env.example .env
echo
echo "Downloading the Whisper speech model (only once; needs internet)..."
python whisper_engine.py || true
echo
echo "Setup complete. Run ./run.sh to start the show."
