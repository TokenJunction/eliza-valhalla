#!/bin/sh
# Unix entry for the same customer smoke. It does not install software, open a
# tunnel, or write a file.
set -eu

if [ "${1:-}" != "local-qwen" ] && [ "${1:-}" != "preview" ]; then
  echo "Usage: ./customer/install-smoke.sh local-qwen|preview" >&2
  echo "This script does not install software, open a tunnel, or write files." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22 or newer is required. This script does not install it." >&2
  exit 1
fi

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec node "$ROOT/customer/smoke.mjs" "$1"
