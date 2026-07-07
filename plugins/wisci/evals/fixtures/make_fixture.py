#!/usr/bin/env python3
"""Generate a throwaway git repo with a .wisci store for WISCI evals.

Usage: python3 make_fixture.py <target-dir>

Produces:
  src/auth/{middleware.ts,session.ts}, src/payments/webhook.ts, package.json
  .wisci/context/auth-research.md       — FRESH (refs untouched)
  .wisci/context/payment-integration.md — STALE (webhook.ts modified after commit)
  .wisci/context/old-notes.md           — BROKEN (refs deleted src/legacy.ts)
  .wisci/handoff/{auth-refactor.md,ci-migration.md} + generated handoff.md index
  uncommitted change in src/auth/middleware.ts (dirty-tree case)
"""

import os
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "scripts"))
from wisci import build_index  # noqa: E402


def sh(args, cwd):
    subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True)


def write(root, rel, content):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


def main(target):
    os.makedirs(target, exist_ok=True)
    sh(["git", "init", "-q", "-b", "main"], target)
    sh(["git", "config", "user.email", "eval@wisci"], target)
    sh(["git", "config", "user.name", "wisci-eval"], target)

    write(target, "package.json", '{"name": "fixture-app", "dependencies": {"express": "^4.0.0"}}\n')
    write(target, "src/auth/middleware.ts",
          "export function authMiddleware(req, res, next) {\n  // validates tokens\n  next()\n}\n")
    write(target, "src/auth/session.ts",
          "export const SESSION_TTL = 3600 // seconds\n")
    write(target, "src/payments/webhook.ts",
          "export function handleWebhook(evt) {\n  return evt.type\n}\n")
    write(target, "src/legacy.ts", "export const OLD = true\n")

    write(target, ".wisci/context/auth-research.md", (
        "# Auth Research\n\n> Last updated by /write on 2026-07-01 10:00\n\n"
        "## Summary\nToken validation lives in the middleware; session TTL is 3600s.\n\n"
        "## Middleware\nValidation happens in `src/auth/middleware.ts`.\n\n"
        "## References\n- `src/auth/middleware.ts` — token validation\n"
        "- `src/auth/session.ts` — session TTL config\n"
    ))
    write(target, ".wisci/context/payment-integration.md", (
        "# Payment Integration\n\n> Last updated by /write on 2026-07-01 10:00\n\n"
        "## Summary\nWebhook handling notes.\n\n"
        "## Webhook Flow\nEvents enter through `src/payments/webhook.ts` and are dispatched by type.\n\n"
        "## Retry Policy\nGeneral policy decision: retry 3 times with backoff.\n\n"
        "## References\n- `src/payments/webhook.ts` — webhook entrypoint\n"
    ))
    write(target, ".wisci/context/old-notes.md", (
        "# Old Notes\n\n## Legacy\nBehavior of `src/legacy.ts` module.\n\n"
        "## References\n- `src/legacy.ts` — legacy module\n"
    ))
    write(target, ".wisci/handoff/auth-refactor.md", (
        "---\nstatus: active\nupdated: 2026-07-05\ngoal: refactor auth middleware to token refresh\n---\n\n"
        "# Handoff: auth refactor\n\n## Completed\n- analyzed middleware\n\n"
        "## In Progress\nToken refresh design.\n\n## Next Steps\n1. implement refresh\n\n"
        "## References\n- `src/auth/middleware.ts` — refactor target\n"
    ))
    write(target, ".wisci/handoff/ci-migration.md", (
        "---\nstatus: blocked\nupdated: 2026-07-01\ngoal: migrate CI to new runners\n---\n\n"
        "# Handoff: CI migration\n\n## In Progress\nWaiting on infra ticket.\n\n"
        "## Next Steps\n1. re-check ticket INFRA-42\n\n"
        "## References\n- `package.json` — scripts to migrate\n"
    ))
    build_index(target)

    sh(["git", "add", "-A"], target)
    sh(["git", "commit", "-qm", "fixture: initial state"], target)

    # Make payment-integration.md STALE: committed change to its reference.
    write(target, "src/payments/webhook.ts",
          "export function handleWebhook(evt) {\n  audit(evt)\n  return evt.type\n}\n")
    sh(["git", "commit", "-aqm", "feat: audit webhooks"], target)

    # Make old-notes.md BROKEN: delete its reference.
    sh(["git", "rm", "-q", "src/legacy.ts"], target)
    sh(["git", "commit", "-qm", "chore: drop legacy module"], target)

    # Dirty working tree (uncommitted, not staged) — on the already-stale payment ref,
    # so auth-research.md stays the clean FRESH case.
    with open(os.path.join(target, "src/payments/webhook.ts"), "a", encoding="utf-8") as f:
        f.write("// WIP: retry queue\n")

    print(target)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    main(sys.argv[1])
