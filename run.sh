#!/usr/bin/env bash
# Génère le site statique (build.py) et le sert en local. Aucune dépendance, aucun
# venv : juste la lib standard de Python 3.
#
# Usage: ./run.sh [-p PORT] [-d DOSSIER_CSV]
set -euo pipefail
cd "$(dirname "$0")"

PORT=8000
DATA_DIR="data"

while getopts "p:d:h" opt; do
  case "$opt" in
    p) PORT=$OPTARG ;;
    d) DATA_DIR=$OPTARG ;;
    h) sed -n '2,7p' "$0"; exit 0 ;;
    *) exit 2 ;;
  esac
done

python3 build.py -d "$DATA_DIR" -o site
echo "http://127.0.0.1:${PORT}"
exec python3 -m http.server "$PORT" --directory site
