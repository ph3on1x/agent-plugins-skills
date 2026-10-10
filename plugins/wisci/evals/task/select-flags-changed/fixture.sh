#!/usr/bin/env bash
# Shared fixture, then the session TTL changes after auth-research was verified (3600 -> 60).
set -euo pipefail
uv run --no-config --no-cache --script "$(dirname "$0")/../../_fixture/make_fixture.py" "$PWD"
printf 'export const SESSION_TTL = 60 // seconds\n' > src/auth/session.ts
git commit -qam "fix: shorter sessions"
