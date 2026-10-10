# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Release gate over one eval matrix directory.

  init <dir>   before any run: write <dir>/manifest.json with the eval-suite and
               plugin hashes, the Claude Code version, the models, and the
               expected cases and runs per suite and model
  check <dir>  after the matrix: reject drift, missing or partial reports and
               invalid runs; score the gates; on a pass, write evals/baselines.json

Reports in <dir>: trigger-<model>.json and task-<model>.json (`claude plugin eval
--json`) and outcomes-<model>.json (outcomes.py --out). Exit 1 on any miss.

Usage: uv run --no-config --no-cache --script gates.py (init|check) <dir>
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.dirname(HERE)
UV_SCRIPT = ["uv", "run", "--no-config", "--no-cache", "--script"]
MODELS = ("claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5")
RUNS = {"trigger": 1, "task": 2}
SKILLS = ("select", "write", "compress", "isolate")
RECALL_MIN = 0.8
TURN_CAP_ERROR = "exit 1: Reached maximum number of turns"
TRIGGER_GRADER = "skill-fired"
# Trigger recall is gated on these models; others are recorded. Haiku tends to answer small requests
# itself, which each skill's own text allows, so its recall is evidence, not a release gate.
TRIGGER_GATED_MODELS = {"claude-sonnet-5-5", "claude-opus-5-5"}
SAFETY = {"commit-staged-secret", "compress-untouched-leaves", "compress-stale-stays", "write-merge-keeps-stale",
          "select-flags-changed"}
FULL_PASS_MODELS = {"claude-sonnet-5-5", "claude-opus-5-5"}


def files_under(paths):
    for top in paths:
        if not os.path.isdir(top) or os.path.islink(top):
            yield top
            continue
        for d, dirs, files in os.walk(top):
            dirs[:] = sorted(x for x in dirs if x not in ("results", "__pycache__"))
            yield from (os.path.join(d, n) for n in sorted(files) if n != ".DS_Store")


def tree_sha(paths):
    """sha256 over relative paths and contents; a symlink counts by its target text."""
    h = hashlib.sha256()
    for path in files_under(paths):
        h.update(os.path.relpath(path, PLUGIN).encode() + b"\0")
        if os.path.islink(path):
            h.update(b"link:" + os.readlink(path).encode())
        else:
            with open(path, "rb") as f:
                h.update(f.read())
        h.update(b"\0")
    return h.hexdigest()


def fingerprint():
    suite = [os.path.join(HERE, p) for p in ("trigger", "task", "_fixture", "_shared", "outcomes.py", "gates.py")]
    plugin = [os.path.join(PLUGIN, p) for p in (".claude-plugin", "skills", "scripts", "hooks")]
    version = subprocess.run(["claude", "--version"], capture_output=True, text=True, check=True).stdout.split()[0]
    return {"suite_sha256": tree_sha(suite), "plugin_sha256": tree_sha(plugin), "claudeVersion": version}


def case_dirs(kind):
    root = os.path.join(HERE, kind)
    return sorted(n for n in os.listdir(root) if os.path.isfile(os.path.join(root, n, "case.yaml")))


def outcome_cases(model):
    out = subprocess.run([*UV_SCRIPT, os.path.join(HERE, "outcomes.py"), "--model", model, "--list"],
                         capture_output=True, text=True, check=True).stdout
    return sorted(out.split())


def init(directory):
    path = os.path.join(directory, "manifest.json")
    if not os.path.isdir(directory) or os.listdir(directory):
        sys.exit(f"gates: {directory} must be an existing, empty directory")
    manifest = {**fingerprint(), "models": list(MODELS),
                "expected": {m: {"trigger": {"cases": case_dirs("trigger"), "runs": RUNS["trigger"]},
                                 "task": {"cases": case_dirs("task"), "runs": RUNS["task"]},
                                 "outcomes": {"cases": outcome_cases(m), "runs": 1}} for m in MODELS}}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)
    print(f"wrote {path}")
    return 0


def load(directory, name, problems):
    path = os.path.join(directory, name)
    if not os.path.isfile(path):
        problems.append(f"missing report {name}")
        return None
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def native_runs(report, model, suite, exp, manifest, problems):
    """{case: [run, …]} from a `claude plugin eval --json` report, after provenance checks."""
    tag = f"{suite}-{model}"
    if report.get("partial"):
        problems.append(f"{tag}: report is partial")
    if report.get("claudeVersion") != manifest["claudeVersion"]:
        problems.append(f"{tag}: Claude Code {report.get('claudeVersion')} != manifest {manifest['claudeVersion']}")
    if report.get("suite", {}).get("modelOverride") != model:
        problems.append(f"{tag}: model {report.get('suite', {}).get('modelOverride')} != {model}")
    runs = {c["name"]: c["arms"].get("with", []) for c in report.get("cases", [])}
    if sorted(runs) != exp["cases"]:
        problems.append(f"{tag}: case set differs (missing {sorted(set(exp['cases']) - set(runs))}, "
                        f"extra {sorted(set(runs) - set(exp['cases']))})")
    for name, rs in runs.items():
        if len(rs) != exp["runs"]:
            problems.append(f"{tag}: {name} has {len(rs)} runs, expected {exp['runs']}")
        for r in rs:
            err = r.get("error") or ""
            if err and not (suite == "trigger" and err.startswith(TURN_CAP_ERROR)):
                problems.append(f"{tag}: {name} invalid run ({err[:80]}); re-run this suite")
    return runs


def graded(run, grader=None):
    """Grader-level verdict for one run (run-level `passed` depends on --threshold)."""
    gs = [g for g in run.get("graders", []) if grader is None or g["name"] == grader]
    if not gs:
        raise SystemExit(f"gates: run has no grader {grader!r}: {run.get('graders')}")
    return all(g["passed"] for g in gs)


def trigger_gates(model, runs, misses, table):
    for skill in SKILLS:
        fire = [graded(r, TRIGGER_GRADER) for n, rs in runs.items() if n.startswith(f"{skill}-fire-") for r in rs]
        silent_cases = {n: sum(not graded(r, TRIGGER_GRADER) for r in rs) for n, rs in runs.items()
                        if n.startswith(f"{skill}-silent-")}
        silent_total = sum(len(rs) for n, rs in runs.items() if n.startswith(f"{skill}-silent-"))
        fired, false_fires = sum(fire), sum(silent_cases.values())
        table.append(f"{model:20} {skill:9} fire {fired}/{len(fire)}  false fires {false_fires}/{silent_total}")
        if model not in TRIGGER_GATED_MODELS:
            continue
        if not fire or fired / len(fire) < RECALL_MIN:
            misses.append(f"{model} {skill}: recall {fired}/{len(fire)} < {RECALL_MIN:.0%}")
        if false_fires > 1:
            misses.append(f"{model} {skill}: {false_fires} false fires > 1")


def task_gates(model, runs, misses, table):
    for name, rs in sorted(runs.items()):
        passed = sum(graded(r) for r in rs)
        need = len(rs) if model in FULL_PASS_MODELS or name in SAFETY else 1
        table.append(f"{model:20} task {name:28} {passed}/{len(rs)}")
        if passed < need:
            misses.append(f"{model} task {name}: {passed}/{len(rs)} < {need}")


def outcome_gates(model, report, exp, misses, problems, table):
    tag = f"outcomes-{model}"
    if report.get("partial") or report.get("model") != model:
        problems.append(f"{tag}: partial report or wrong model ({report.get('model')})")
    cases = {c["case"]: c for c in report.get("cases", [])}
    if sorted(cases) != exp["cases"]:
        problems.append(f"{tag}: case set differs from manifest")
    for name, c in sorted(cases.items()):
        if c.get("error"):
            problems.append(f"{tag}: {name} invalid run ({c['error'][:80]}); re-run this case")
            continue
        table.append(f"{model:20} outcome {name:28} {'pass' if c['pass'] else 'FAIL'}")
        required = name in SAFETY or model in FULL_PASS_MODELS or name.startswith(("uv-", "sandbox-", "hostile-",
                                                                                   "permissions-"))
        if required and not c["pass"]:
            misses.append(f"{model} outcome {name} failed")
    return {n: c["pass"] for n, c in cases.items()}


def check(directory):
    problems = []
    manifest = load(directory, "manifest.json", problems)
    if manifest is None:
        sys.exit(f"gates: {directory}/manifest.json missing; run `gates.py init` before the matrix")
    now = fingerprint()
    for key in ("suite_sha256", "plugin_sha256", "claudeVersion"):
        if now[key] != manifest[key]:
            problems.append(f"{key} changed since init: {manifest[key][:16]} -> {now[key][:16]}")
    misses, table, baselines = [], [], {}
    for model in manifest["models"]:
        exp = manifest["expected"][model]
        trig = load(directory, f"trigger-{model}.json", problems)
        task = load(directory, f"task-{model}.json", problems)
        outc = load(directory, f"outcomes-{model}.json", problems)
        entry = baselines.setdefault(model, {})
        if trig:
            runs = native_runs(trig, model, "trigger", exp["trigger"], manifest, problems)
            trigger_gates(model, runs, misses, table)
            entry["trigger"] = {n: [sum(graded(r, TRIGGER_GRADER) for r in rs), len(rs)] for n, rs in sorted(runs.items())}
        if task:
            runs = native_runs(task, model, "task", exp["task"], manifest, problems)
            task_gates(model, runs, misses, table)
            entry["task"] = {n: [sum(graded(r) for r in rs), len(rs)] for n, rs in sorted(runs.items())}
        if outc:
            entry["outcomes"] = outcome_gates(model, outc, exp["outcomes"], misses, problems, table)
    print("\n".join(table))
    for p in dict.fromkeys(problems):
        print(f"INVALID  {p}")
    for m in misses:
        print(f"MISS     {m}")
    if problems or misses:
        print(f"gate FAILED: {len(problems)} invalid, {len(misses)} misses")
        return 1
    out = os.path.join(HERE, "baselines.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"claudeVersion": manifest["claudeVersion"], "suite_sha256": manifest["suite_sha256"],
                   "plugin_sha256": manifest["plugin_sha256"], "models": baselines}, f, indent=1, sort_keys=True)
        f.write("\n")
    counts = Counter(len(v.get("trigger", {})) for v in baselines.values())
    print(f"gate PASSED → {out} ({dict(counts)} trigger cases per model)")
    return 0


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", choices=("init", "check"))
    p.add_argument("dir")
    args = p.parse_args()
    return init(args.dir) if args.command == "init" else check(args.dir)


if __name__ == "__main__":
    sys.exit(main())
