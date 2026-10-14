#!/bin/sh
# Hook entry point: runs the wisci engine through uv, or says how to install uv (exit 2).
# Kept out of hooks.json because Claude Code can show a hook's command string to the model.
command -v uv >/dev/null 2>&1 || { echo 'wisci: uv is required — install: https://docs.astral.sh/uv/getting-started/installation/' >&2; exit 2; }
exec uv run --no-config --no-cache --script "$(dirname "$0")/../scripts/wisci.py" "$@"
