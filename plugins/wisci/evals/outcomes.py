# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Outcome checks that native `claude plugin eval` graders can't express:
git objects, byte equality, wisci.py evidence after a real session, and the
uv/sandbox/permission plumbing.

Each case builds the fixture (_fixture/make_fixture.py), applies its own setup,
runs headless Claude Code (`claude -p`, stream-json, user settings excluded),
then asserts the resulting repository state. Every ordinary run must also end
without error or permission denial, and the wisci or git calls the case relies
on must have run successfully: a case never passes on silence.

Behavioral cases run on every model; infra cases (plumbing, model-independent)
run only for INFRA_MODEL.

Usage:  uv run --no-config --no-cache --script outcomes.py --model MODEL [--case GLOB] [-j N] [--out FILE]
        uv run --no-config --no-cache --script outcomes.py --model MODEL --list
Env:    CLAUDE_BIN (default "claude")
Exit 1 if any check fails.
"""

import argparse
import fnmatch
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
WISCI = os.path.join(PLUGIN, "scripts", "wisci.py")
FIXTURE = os.path.join(HERE, "_fixture", "make_fixture.py")
CLAUDE = os.environ.get("CLAUDE_BIN", "claude")
UV_SCRIPT = ["uv", "run", "--no-config", "--no-cache", "--script"]
INFRA_MODEL = "claude-sonnet-5-5"
SANDBOX = {"sandbox": {"enabled": True, "allowUnsandboxedCommands": False, "failIfUnavailable": True}}
SKILLS = ("select", "write", "compress", "isolate", "commit")
SKILL_COMMANDS = r"scripts/wisci\.py|\bgit\s+(?:add|commit|push)\b"


def sh(args, cwd, check=True):
    return subprocess.run(args, cwd=cwd, check=check, capture_output=True, text=True).stdout


def write(root, rel, text):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def sha(root, rel):
    with open(os.path.join(root, rel), "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def tree_hashes(root, sub):
    out = {}
    for d, _, files in os.walk(os.path.join(root, sub)):
        for name in files:
            rel = os.path.relpath(os.path.join(d, name), root)
            out[rel] = sha(root, rel)
    return out


def evidence(root, rel):
    """[failed, quotes] for one store file, from `scan`."""
    out = json.loads(sh([*UV_SCRIPT, WISCI, "--root", root, "scan"], root))
    key = rel[len(".wisci/"):-3]
    return next(([failed, quotes] for k, failed, quotes in out["health"] if k == key), None)


def failing(root, rel):
    """Headings of the sections `check` reports as failing."""
    out = sh([*UV_SCRIPT, WISCI, "--root", root, "check", rel], root)
    return [line.split(":", 1)[0] for line in out.splitlines()[:-1]]


def head(root):
    return sh(["git", "rev-parse", "HEAD"], root).strip()


def trailer(root, key):
    out = sh(["git", "log", "-1", f"--format=%(trailers:key={key},valueonly,unfold,separator=%x0A)"], root)
    return [line for line in out.splitlines() if line.strip()]


def committed(root):
    return sh(["git", "show", "--name-only", "--format=", "HEAD"], root).split()


def new_files(root, kind, before):
    return sorted(set(os.listdir(os.path.join(root, ".wisci", kind))) - set(before))


def install_npx_layout(root):
    """Copy the skills into the project, symlinks dereferenced, as `npx skills add` does."""
    for name in SKILLS:
        shutil.copytree(os.path.join(PLUGIN, "skills", name), os.path.join(root, ".claude", "skills", name),
                        symlinks=False)


def make_hostile(root):
    """Project uv config and venv that must not reach wisci (E19 in the release plan)."""
    write(root, "pyproject.toml", '[project]\nname = "hostile"\nversion = "0"\nrequires-python = "<3.10"\n'
                                  'dependencies = ["this-package-does-not-exist-xyz==9.9"]\n\n'
                                  '[tool.uv]\npython-preference = "only-system"\n')
    write(root, "uv.toml", 'required-version = "==0.11.*"\nindex-url = "http://127.0.0.1:9/simple"\n')
    os.makedirs(os.path.join(root, ".venv"), exist_ok=True)


def _content(event):
    message = event.get("message")
    return message.get("content") if isinstance(message, dict) else None


class Run:
    """One `claude -p` session: its stream-json events, paired tool calls and final result."""

    def __init__(self, events, exit_code, stderr):
        self.events, self.exit_code, self.stderr = events, exit_code, stderr
        uses, results = {}, {}
        for e in events:
            content = _content(e)
            for c in content if isinstance(content, list) else []:
                if isinstance(c, dict) and c.get("type") == "tool_use":
                    uses[c["id"]] = c
                elif isinstance(c, dict) and c.get("type") == "tool_result":
                    results[c["tool_use_id"]] = c
        self.calls = [(u, results.get(i)) for i, u in uses.items()]
        found = [e for e in events if e.get("type") == "result"]
        self.result = found[-1] if found else {}

    def ok_bash(self, pattern):
        """Bash calls matching pattern whose tool_result exists and is not an error."""
        return [u["input"].get("command", "") for u, r in self.calls
                if u["name"] == "Bash" and re.search(pattern, u["input"].get("command", ""))
                and r is not None and r.get("is_error") is not True]

    def read_file(self, rel):
        """A successful Read of rel, or a successful Bash command naming it."""
        return any(r is not None and r.get("is_error") is not True and (
            (u["name"] == "Read" and str(u["input"].get("file_path", "")).endswith(rel))
            or (u["name"] == "Bash" and rel in u["input"].get("command", ""))) for u, r in self.calls)

    def any_bash(self, pattern):
        return [u["input"].get("command", "") for u, _ in self.calls
                if u["name"] == "Bash" and re.search(pattern, u["input"].get("command", ""))]

    def hook_responses(self, event):
        return [e for e in self.events if e.get("type") == "system" and e.get("subtype") == "hook_response"
                and e.get("hook_event") == event]

    def local_stderr(self):
        return [c for e in self.events if e.get("type") == "user"
                for c in [_content(e)] if isinstance(c, str) and "<local-command-stderr>" in c]

    def summary(self):
        return {"exit": self.exit_code, "is_error": self.result.get("is_error"),
                "turns": self.result.get("num_turns"), "denials": self.result.get("permission_denials"),
                "result": (self.result.get("result") or "")[-1500:], "stderr": self.stderr[-800:],
                "bash": [u["input"].get("command", "")[:200] for u, _ in self.calls if u["name"] == "Bash"]}


def wisci_cmd(sub):
    return rf'scripts/wisci\.py"?\s+(?:--root\s+\S+\s+)?{sub}\b'


class Case:
    def __init__(self, root, model, log):
        self.root, self.model, self.log, self.checks = root, model, log, []

    def claude(self, prompt, settings=None, layout="plugin", mode="default", env=None):
        cmd = [CLAUDE, "-p", prompt, "--setting-sources", "project", "--permission-mode", mode,
               "--model", self.model, "--max-turns", "40", "--output-format", "stream-json", "--verbose"]
        if layout == "plugin":
            cmd += ["--plugin-dir", PLUGIN]
        if settings is not None:
            cmd += ["--settings", json.dumps(settings)]
        r = subprocess.run(cmd, cwd=self.root, capture_output=True, text=True, timeout=900, env=env, check=False)
        events = [json.loads(line) for line in r.stdout.splitlines() if line.startswith("{")]
        run = Run(events, r.returncode, r.stderr)
        self.log.append({"prompt": prompt, "settings": settings, "layout": layout, **run.summary()})
        return run

    def no_denials(self, run):
        self.check("no permission denials at all", run.result.get("permission_denials") == [],
                   run.result.get("permission_denials"))

    def check(self, label, ok, detail: object = ""):
        self.checks.append({"check": label, "pass": bool(ok), "detail": str(detail)[:300]})

    def ran_clean(self, run, *needed):
        """The session finished without error, none of the skill's own commands was denied,
        and each needed call succeeded. Denials of the model's ad-hoc exploration (say,
        `grep … | head; echo $?`) are kept in the report but don't fail the case."""
        self.check("session ended without error", run.result and run.result.get("is_error") is False
                   and run.result.get("num_turns", 0) > 0, run.summary())
        denied = [d.get("tool_input", {}).get("command", "") for d in run.result.get("permission_denials") or []]
        self.check("no denials of the skill's own commands",
                   not [c for c in denied if re.search(SKILL_COMMANDS, c)], denied)
        for label, pattern in needed:
            self.check(f"{label} ran successfully", run.ok_bash(pattern), run.any_bash(pattern))


# ---------- commit ----------

GIT_COMMIT = ("git commit", r"\bgit\s+commit\b")


def _ai_and_app_change(root):
    with open(os.path.join(root, ".wisci/context/auth-research.md"), "a", encoding="utf-8") as f:
        f.write("\n## Refresh Plan\nA refresh hook is planned in `src/auth/middleware.ts`.\n")
    write(root, "src/auth/session.ts", "export const SESSION_TTL = 900 // seconds\n")


def case_commit_default_attribution(c):
    _ai_and_app_change(c.root)
    before = head(c.root)
    run = c.claude("/wisci:commit")
    c.ran_clean(run, GIT_COMMIT)
    c.check("HEAD advanced", head(c.root) != before)
    files = committed(c.root)
    c.check("both files committed", {".wisci/context/auth-research.md", "src/auth/session.ts"} <= set(files), files)
    ai = trailer(c.root, "AI-Context")
    c.check("one AI-Context trailer naming the note",
            len(ai) == 1 and ".wisci/context/auth-research.md" in ai[0], ai)
    c.check("default Co-Authored-By kept in the trailer block", trailer(c.root, "Co-Authored-By"))


def case_commit_custom_attribution(c):
    _ai_and_app_change(c.root)
    before = head(c.root)
    run = c.claude("/wisci:commit", settings={"attribution": {"commit": "Assisted-by: wisci-eval <eval@example.com>"}})
    c.ran_clean(run, GIT_COMMIT)
    c.check("HEAD advanced", head(c.root) != before)
    c.check("custom attribution parsed as trailer", trailer(c.root, "Assisted-by"))
    c.check("no default Co-Authored-By", not trailer(c.root, "Co-Authored-By"))
    c.check("AI-Context trailer parsed", trailer(c.root, "AI-Context"))


def case_commit_no_attribution(c):
    _ai_and_app_change(c.root)
    before = head(c.root)
    run = c.claude("/wisci:commit", settings={"attribution": {"commit": ""}})
    c.ran_clean(run, GIT_COMMIT)
    c.check("HEAD advanced", head(c.root) != before)
    c.check("no attribution invented", not trailer(c.root, "Co-Authored-By"))
    c.check("AI-Context trailer parsed", trailer(c.root, "AI-Context"))


def case_commit_app_only(c):
    write(c.root, "src/auth/session.ts", "export const SESSION_TTL = 900 // seconds\n")
    before = head(c.root)
    run = c.claude("/wisci:commit")
    c.ran_clean(run, GIT_COMMIT)
    c.check("HEAD advanced", head(c.root) != before)
    c.check("no AI-Context trailer", not trailer(c.root, "AI-Context"))


def case_commit_staged_secret(c):
    write(c.root, ".env.production", "API_KEY=do-not-commit\n")
    sh(["git", "add", ".env.production"], c.root)
    write(c.root, "src/auth/session.ts", "export const SESSION_TTL = 900 // seconds\n")
    before = head(c.root)
    run = c.claude("/wisci:commit")
    c.ran_clean(run)
    c.check("no git commit attempted", not run.any_bash(GIT_COMMIT[1]), run.any_bash(GIT_COMMIT[1]))
    c.check("result names the staged secret", ".env.production" in (run.result.get("result") or ""))
    c.check("no commit made", head(c.root) == before)
    staged = sh(["git", "diff", "--cached", "--name-only"], c.root).split()
    c.check("user's index untouched", ".env.production" in staged, staged)


def case_commit_nested_plugin(c):
    write(c.root, "plugins/foo/.claude-plugin/plugin.json", '{"name": "foo"}\n')
    write(c.root, "plugins/foo/skills/bar/SKILL.md", "---\nname: bar\ndescription: Bar.\n---\nDo bar.\n")
    sh(["git", "add", "-A"], c.root)
    sh(["git", "commit", "-qm", "add foo plugin"], c.root)
    write(c.root, "plugins/foo/skills/bar/SKILL.md", "---\nname: bar\ndescription: Bar, better.\n---\nDo bar well.\n")
    before = head(c.root)
    run = c.claude("/wisci:commit")
    c.ran_clean(run, GIT_COMMIT)
    c.check("HEAD advanced", head(c.root) != before)
    ai = trailer(c.root, "AI-Context")
    c.check("nested plugin skill gets a trailer", any("plugins/foo/skills/bar/SKILL.md" in t for t in ai), ai)


# ---------- compress ----------

COMPRESS_PROMPT = ("/wisci:compress rate-limiter — this session we designed a token bucket limiter for "
                   "src/api/limiter.ts (100 req/min per user). We tried nginx-level limiting first and dropped "
                   "it because we need per-user state. My constraint: no new runtime dependencies. "
                   "Next step: implement the bucket store.")


def case_compress_untouched_leaves(c):
    keep = [".wisci/handoff/auth-refactor.md", ".wisci/handoff/ci-migration.md"]
    before = {rel: sha(c.root, rel) for rel in keep}
    leaves = os.listdir(os.path.join(c.root, ".wisci/handoff"))
    run = c.claude(COMPRESS_PROMPT)
    c.ran_clean(run, ("wisci new", wisci_cmd("new")), ("wisci check", wisci_cmd("check")))
    c.check("other streams byte-identical", all(sha(c.root, r) == h for r, h in before.items()))
    added = new_files(c.root, "handoff", leaves)
    c.check("one new leaf", len(added) == 1, added)
    if added:
        ev = evidence(c.root, f".wisci/handoff/{added[0]}")
        c.check("new leaf has no failing quote", ev is not None and ev[0] == 0, ev)


def case_compress_stale_stays(c):
    leaf = ".wisci/handoff/auth-refactor.md"
    before = sha(c.root, leaf)
    write(c.root, "src/auth/middleware.ts", "export function authMiddleware(req, res, next) {\n  refresh(req)\n  next()\n}\n")
    run = c.claude("/wisci:compress auth-refactor — progress on this stream: I added setup notes to README.md. "
                   "Do not inspect any code; just record that progress.")
    c.ran_clean(run, ("wisci check", wisci_cmd("check")))
    with open(os.path.join(c.root, leaf), encoding="utf-8") as f:
        text = f.read()
    c.check("leaf updated with the progress", sha(c.root, leaf) != before and "README.md" in text)
    ev, rechecked = evidence(c.root, leaf), run.read_file("src/auth/middleware.ts")
    c.check("the failing quote stays unless its file was re-read",
            (ev is not None and ev[0] >= 1) or rechecked, {"evidence": ev, "read middleware.ts": rechecked})


# ---------- write ----------

WRITE_LOGGING = ("write logging conventions — the app logs to stdout only, as JSON; we decided never "
                 "to write log files from src/, because the platform collects stdout.")


def _assert_new_note_passes(c, notes):
    added = new_files(c.root, "context", notes)
    c.check("one new note", len(added) == 1, added)
    if added:
        ev = evidence(c.root, f".wisci/context/{added[0]}")
        c.check("no failing quote", ev is not None and ev[0] == 0, ev)


def case_write_create_fresh(c):
    notes = os.listdir(os.path.join(c.root, ".wisci/context"))
    run = c.claude(f"/wisci:{WRITE_LOGGING}")
    c.ran_clean(run, ("wisci new", wisci_cmd("new")), ("wisci check", wisci_cmd("check")))
    _assert_new_note_passes(c, notes)


def case_write_merge_keeps_stale(c):
    rel = ".wisci/context/payment-integration.md"
    run = c.claude("/wisci:write payment integration — add a section on refunds: refunds are handled manually by "
                   "support and nothing in the code handles them yet.")
    c.ran_clean(run, ("wisci check", wisci_cmd("check")))
    ev, fails, rechecked = evidence(c.root, rel), failing(c.root, rel), run.read_file("src/payments/webhook.ts")
    c.check("the failing Webhook Flow quote passes only if webhook.ts was re-read",
            "Webhook Flow" in fails or rechecked, {"failing": fails, "read webhook.ts": rechecked})
    c.check("no quote was deleted to pass", ev is not None and ev[1] >= 1, ev)
    with open(os.path.join(c.root, rel), encoding="utf-8") as f:
        c.check("a refunds section was added", "refund" in f.read().lower())


# ---------- isolate ----------

def _section(root, rel, heading):
    """The body of one `## heading` section, or None."""
    with open(os.path.join(root, rel), encoding="utf-8") as f:
        m = re.search(rf"^## {re.escape(heading)}\n(.*?)(?=^## |\Z)", f.read(), re.MULTILINE | re.DOTALL)
    return m.group(1).strip() if m else None


def case_isolate_heals_note(c):
    rel = ".wisci/context/auth-research.md"
    middleware = _section(c.root, rel, "Middleware")
    others = {r: h for r, h in tree_hashes(c.root, ".wisci").items() if r != rel}
    write(c.root, "src/auth/session.ts", "export const SESSION_TTL = 60 // seconds\n")
    sh(["git", "commit", "-qam", "fix: shorter sessions"], c.root)
    run = c.claude("/wisci:isolate what is the session TTL in seconds?")
    c.ran_clean(run, ("wisci check", wisci_cmd("check")))
    prose = re.sub(r"```.*?```", "", _section(c.root, rel, "Session") or "", flags=re.DOTALL)
    c.check("the Session prose now says 60", re.search(r"\b60\b", prose), prose)
    ev = evidence(c.root, rel)
    c.check("every quote matches and none was deleted", ev is not None and ev[0] == 0 and ev[1] >= 2, ev)
    c.check("Middleware section unchanged", _section(c.root, rel, "Middleware") == middleware)
    c.check("other store files byte-identical",
            {r: h for r, h in tree_hashes(c.root, ".wisci").items() if r != rel} == others)


# ---------- infra (model-independent) ----------

def infra_uv_missing(c):
    bin_dir = os.path.join(os.path.dirname(c.root), "bin")
    os.makedirs(bin_dir)
    for tool in ("git", CLAUDE):
        found = shutil.which(tool)
        if not found:
            raise RuntimeError(f"{tool} not on PATH")
        os.symlink(os.path.realpath(found), os.path.join(bin_dir, os.path.basename(tool)))
    path = os.pathsep.join([bin_dir, "/usr/bin", "/bin"])
    if shutil.which("uv", path=path):
        raise RuntimeError(f"uv is installed in a system directory on {path}; cannot simulate its absence")
    before = tree_hashes(c.root, ".wisci")
    run = c.claude("/wisci:select", env={**os.environ, "PATH": path})
    hooks = run.hook_responses("SessionStart")
    c.check("SessionStart hook exits 2 with the install hint",
            any(h.get("exit_code") == 2 and "uv is required" in (h.get("stderr") or "") for h in hooks), hooks)
    stderr = run.local_stderr()
    c.check("skill aborts at injection naming uv",
            any("Shell command failed for pattern" in s and "uv" in s for s in stderr), stderr)
    c.check("no wisci call ran", not run.any_bash(r"scripts/wisci\.py"))
    c.check("store byte-identical", tree_hashes(c.root, ".wisci") == before)


def infra_sandbox_write(c):
    notes = os.listdir(os.path.join(c.root, ".wisci/context"))
    run = c.claude(f"/wisci:{WRITE_LOGGING}", settings=SANDBOX)
    c.ran_clean(run, ("wisci new", wisci_cmd("new")), ("wisci check", wisci_cmd("check")))
    _assert_new_note_passes(c, notes)


def _hostile_select(c, layout):
    make_hostile(c.root)
    if layout == "npx":
        install_npx_layout(c.root)
    env = {**os.environ, "VIRTUAL_ENV": os.path.join(c.root, ".venv")}
    prompt = "/wisci:select payment integration" if layout == "plugin" else "/select payment integration"
    run = c.claude(prompt, layout=layout, env=env)
    c.ran_clean(run, ("wisci load", wisci_cmd("load")))
    if layout == "npx":
        c.check("the project-installed skill ran", run.ok_bash(r"/\.claude/skills/select/scripts/wisci\.py"),
                run.any_bash(r"wisci\.py"))
    c.check("note loaded through the script",
            "retr" in (run.result.get("result") or "").lower(), run.result.get("result", "")[:300])


def infra_hostile_project_plugin(c):
    _hostile_select(c, "plugin")


def infra_hostile_project_npx(c):
    _hostile_select(c, "npx")


def _permissions_default(c, layout):
    if layout == "npx":
        install_npx_layout(c.root)
    notes = os.listdir(os.path.join(c.root, ".wisci/context"))
    prompt = f"/wisci:{WRITE_LOGGING}" if layout == "plugin" else f"/{WRITE_LOGGING}"
    run = c.claude(prompt, layout=layout)
    c.ran_clean(run, ("wisci new", wisci_cmd("new")), ("wisci check", wisci_cmd("check")))
    c.no_denials(run)
    _assert_new_note_passes(c, notes)


def infra_permissions_default_plugin(c):
    _permissions_default(c, "plugin")


def infra_permissions_default_npx(c):
    _permissions_default(c, "npx")


def _named(prefix):
    return {name[len(prefix):].replace("_", "-"): fn for name, fn in sorted(globals().items())
            if name.startswith(prefix)}


BEHAVIOR = _named("case_")
INFRA = _named("infra_")


def cases_for(model):
    return {**BEHAVIOR, **(INFRA if model == INFRA_MODEL else {})}


def run_case(name, fn, model):
    """Build a fresh fixture, run one case in it, print its verdict, return its report entry."""
    root = os.path.join(tempfile.mkdtemp(prefix="wisci-outcome-"), "repo")
    subprocess.run([*UV_SCRIPT, FIXTURE, root], check=True, capture_output=True, text=True)
    case, error = Case(root, model, []), None
    t0 = time.time()
    try:
        fn(case)
    except Exception as e:  # noqa: BLE001 — a crashed case is reported as an invalid run
        frame = traceback.extract_tb(e.__traceback__)[-1]
        error = f"{type(e).__name__}: {e} (outcomes.py:{frame.lineno})"
    ok = error is None and all(ch["pass"] for ch in case.checks)
    lines = [f"[{'PASS' if ok else 'ERROR' if error else 'FAIL'}] {name} ({round(time.time() - t0)}s)"]
    lines += [f"    failed: {ch['check']} — {ch['detail']}" for ch in case.checks if not ch["pass"]]
    lines += [f"    error: {error}"] if error else []
    print("\n".join(lines), flush=True)
    shutil.rmtree(os.path.dirname(root), ignore_errors=True)
    return {"case": name, "pass": ok, "error": error, "checks": case.checks, "runs": case.log}


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--model", required=True)
    p.add_argument("--case", default="*", help="glob over case names")
    p.add_argument("-j", "--jobs", type=int, default=1, help="cases run at once (each is its own claude session)")
    p.add_argument("--out", help="report path (default evals/results/outcomes-<model>-<time>.json)")
    p.add_argument("--list", action="store_true", help="print the case names for --model and exit")
    args = p.parse_args()
    selected = {n: fn for n, fn in cases_for(args.model).items() if fnmatch.fnmatch(n, args.case)}
    if args.list:
        print("\n".join(selected))
        return 0
    version = sh([CLAUDE, "--version"], HERE).split()[0]
    with ThreadPoolExecutor(args.jobs) as pool:  # each case owns its temp repo; results keep case order
        report = list(pool.map(run_case, selected, selected.values(), [args.model] * len(selected)))
    failed = sum(not entry["pass"] for entry in report)
    out = args.out or os.path.join(HERE, "results", f"outcomes-{args.model}-{time.strftime('%Y%m%d-%H%M%S')}.json")
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"schemaVersion": 1, "model": args.model, "claudeVersion": version, "partial": args.case != "*",
                   "cases": report}, f, indent=1)
    print(f"{len(report) - failed}/{len(report)} cases passed → {out}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
