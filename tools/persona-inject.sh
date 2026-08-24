#!/bin/sh
# Install the live-signing persona wallet into an open playwright-cli session.
# Usage: tools/persona-inject.sh maker|taker
set -e
PERSONA="${1:?usage: $0 maker|taker}"
case "$PERSONA" in
  maker|taker) ;;
  *) echo "usage: $0 maker|taker" >&2; exit 1 ;;
esac
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
INJECTOR="$ROOT/tools/inject-persona.js"
# run-code's vm has no require/import. Bake the absolute installer path into
# the snippet; the CLI daemon process is reached via the page host object.
playwright-cli -s="$PERSONA" run-code "async page => { const nodeProcess = page.constructor.constructor('return process')(); const { createRequire } = nodeProcess.getBuiltinModule('module'); const require = createRequire('$INJECTOR'); return require('$INJECTOR').install(page, '$PERSONA'); }"
