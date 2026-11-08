#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ ! -x .venv/bin/python ]]; then
  python3 -m venv .venv
  .venv/bin/python -m pip install -r requirements.txt
  .venv/bin/python -m playwright install chromium
fi
export COURSEX_LIBRARY="$(node --env-file-if-exists=.env -p 'process.env.COURSEX_LIBRARY || ""')"
exec .venv/bin/python scripts/download_course.py "$@"
