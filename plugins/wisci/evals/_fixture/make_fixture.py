# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Build a throwaway git repo with a wisci store whose notes quote their evidence, for native eval
cases and outcomes.py.

Usage: uv run --no-config --no-cache --script make_fixture.py <target-dir>

Resulting store, as [failed, quotes] (asserted before exit; non-zero exit on any mismatch):
  context/auth-research          [0, 2]
  context/old-notes              [1, 1]  (src/legacy.ts deleted after writing)
  context/payment-integration    [1, 1]  (the quoted `return evt.type` changed; Retry Policy has no quote)
  handoff/auth-refactor          [0, 1]  (active)
  handoff/ci-migration           [0, 0]  (blocked)
"""

import json
import os
import subprocess
import sys

WISCI = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "scripts", "wisci.py")
UV_SCRIPT = ["uv", "run", "--no-config", "--no-cache", "--script"]  # the invocation users run


def quote(path, line, lang="ts"):
    return f"```{lang} {path}\n{line}\n```\n"


FILES = {
    "package.json": '{"name": "fixture-app", "dependencies": {"express": "^4.0.0"}}\n',
    "src/auth/middleware.ts": "export function authMiddleware(req, res, next) {\n  // validates tokens\n  next()\n}\n",
    "src/auth/session.ts": "export const SESSION_TTL = 3600 // seconds\n",
    "src/payments/webhook.ts": "export function handleWebhook(evt) {\n  return evt.type\n}\n",
    "src/legacy.ts": "export const OLD = true\n",
    ".wisci/context/auth-research.md": (
        "# Auth Research\n\n## Middleware\nTokens are validated in `authMiddleware`. Today it is a stub: it checks "
        "nothing and calls `next()` for every request.\n"
        + quote("src/auth/middleware.ts", "export function authMiddleware(req, res, next) {\n  // validates tokens\n"
                "  next()\n}")
        + "\n## Session\nSessions expire after 3600 seconds.\n"
        + quote("src/auth/session.ts", "export const SESSION_TTL = 3600 // seconds")),
    ".wisci/context/payment-integration.md": (
        "# Payment Integration\n\n## Webhook Flow\nEvents are dispatched by their type.\n"
        + quote("src/payments/webhook.ts", "  return evt.type")
        + "\n## Retry Policy\nGeneral policy decision: retry 3 times with backoff.\n"),
    ".wisci/context/old-notes.md": (
        "# Old Notes\n\n## Legacy\nThe legacy module exports the `OLD` feature flag.\n"
        + quote("src/legacy.ts", "export const OLD = true")),
    ".wisci/handoff/auth-refactor.md": (
        "---\nstatus: active\nupdated: 2026-07-05 10:00\ngoal: refactor auth middleware to token refresh\n---\n\n"
        "# Handoff: auth refactor\n\n## Completed\n- Analyzed the auth middleware in src/auth/middleware.ts.\n\n"
        "## In Progress\nThe middleware still only validates tokens:\n"
        + quote("src/auth/middleware.ts", "  // validates tokens")
        + "\n## Next Steps\n1. Implement refresh in src/auth/middleware.ts.\n"),
    ".wisci/handoff/ci-migration.md": (
        "---\nstatus: blocked\nupdated: 2026-07-01 09:00\ngoal: migrate CI to new runners\n---\n\n"
        "# Handoff: CI migration\n\n## Blockers / Open Questions\n- Waiting on infra ticket INFRA-42.\n\n"
        "## Next Steps\n1. Re-check the scripts in package.json.\n"),
}

EXPECTED = {  # path: [failed, quotes]
    "context/auth-research": [0, 2],
    "context/old-notes": [1, 1],
    "context/payment-integration": [1, 1],
    "handoff/auth-refactor": [0, 1],
    "handoff/ci-migration": [0, 0],
}


def sh(args, cwd):
    subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True)


def main(target):
    os.makedirs(target, exist_ok=True)
    sh(["git", "init", "-q", "-b", "main"], target)
    sh(["git", "config", "user.email", "eval@wisci"], target)
    sh(["git", "config", "user.name", "wisci-eval"], target)
    for rel, text in FILES.items():
        path = os.path.join(target, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
    sh(["git", "add", "-A"], target)
    sh(["git", "commit", "-qm", "fixture: store with quoted evidence"], target)

    with open(os.path.join(target, "src/payments/webhook.ts"), "w", encoding="utf-8") as f:
        f.write("export function handleWebhook(evt) {\n  audit(evt)\n  return dispatch(evt.type)\n}\n")
    sh(["git", "commit", "-qam", "feat: audit and dispatch webhooks"], target)
    sh(["git", "rm", "-q", "src/legacy.ts"], target)
    sh(["git", "commit", "-qm", "chore: drop legacy module"], target)

    scan = json.loads(subprocess.run([*UV_SCRIPT, WISCI, "--root", target, "scan"], check=True,
                                     capture_output=True, text=True).stdout)
    got = {path: [failed, quotes] for path, failed, quotes in scan["health"]}
    if got != EXPECTED:
        sys.exit(f"fixture evidence {got} != expected {EXPECTED}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
