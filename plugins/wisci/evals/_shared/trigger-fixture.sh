#!/usr/bin/env bash
# Trigger fixture: a small git repo with a plain-markdown .wisci store.
# No wisci.py calls: trigger cases only test whether a skill fires.
set -euo pipefail

git init -q -b main
git config user.email eval@wisci
git config user.name wisci-eval

mkdir -p src/auth src/payments .wisci/context .wisci/handoff
printf '{"name": "fixture-app", "dependencies": {"express": "^4.0.0"}}\n' > package.json
printf 'export function authMiddleware(req, res, next) {\n  // validates tokens\n  next()\n}\n' > src/auth/middleware.ts
printf 'export const SESSION_TTL = 3600 // seconds\n' > src/auth/session.ts
printf 'export function handleWebhook(evt) {\n  return evt.type\n}\n' > src/payments/webhook.ts

cat > .wisci/context/auth-research.md <<'EOF'
# Auth Research

## Summary
Token validation lives in `src/auth/middleware.ts`; session TTL is 3600s in `src/auth/session.ts`.

## References
- `src/auth/middleware.ts` — token validation
- `src/auth/session.ts` — session TTL config
EOF

cat > .wisci/handoff/auth-refactor.md <<'EOF'
---
status: active
updated: 2026-07-05 10:00
goal: refactor auth middleware to token refresh
---

# Handoff: auth refactor

## Next Steps
1. implement refresh in `src/auth/middleware.ts`

## References
- `src/auth/middleware.ts` — refactor target
EOF

git add -A
git commit -qm "fixture: initial state"
