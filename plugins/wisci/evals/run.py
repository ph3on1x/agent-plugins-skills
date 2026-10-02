#!/usr/bin/env python3
"""WISCI eval runner — eval-driven iteration per agentskills.io methodology.

Modes:
  triggers [--skill S] [--split train|validation|all] [--runs N]
      Does the model invoke the right skill (and only then)? Grades via the
      session transcript. Requires the wisci plugin installed in this
      environment's Claude Code.
  tasks [--skill S] [--runs N]
      End-to-end skill behavior in a fresh fixture repo, graded by assertions.
  compare <outputs-dir-A> <outputs-dir-B>
      Blind LLM-judge comparison of two task-output sets (order randomized).

Defaults are cheap: --runs 1, all splits. Use --runs 3 for variance checks.
Results land in evals/outputs/<timestamp>/ (grading.json + benchmark.json).

Environment: CLAUDE_BIN (default "claude") to override the CLI binary.
"""

import argparse
import glob as globmod
import hashlib
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CLAUDE = os.environ.get("CLAUDE_BIN", "claude")
TRIGGER_TURNS = "3"
TASK_TURNS = "40"
TIMEOUT = 600


def claude_run(prompt, cwd, max_turns, bypass=False):
    """Run one headless claude session; return (transcript_text, result_text)."""
    cmd = [CLAUDE, "-p", prompt, "--output-format", "stream-json", "--verbose",
           "--max-turns", max_turns]
    if bypass:
        cmd += ["--permission-mode", "bypassPermissions"]
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=TIMEOUT)
    transcript = r.stdout
    result_text = ""
    for line in transcript.splitlines():
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("type") == "result":
            result_text = obj.get("result", "") or ""
    return transcript, result_text


def skill_invoked(transcript, skill):
    """True if the transcript shows a Skill tool call for this wisci skill."""
    for line in transcript.splitlines():
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        for block in (obj.get("message") or {}).get("content", []) or []:
            if isinstance(block, dict) and block.get("type") == "tool_use" \
                    and block.get("name") == "Skill":
                name = str((block.get("input") or {}).get("skill", ""))
                if name == skill or name.endswith(f":{skill}"):
                    return True
    return False


def make_fixture():
    target = tempfile.mkdtemp(prefix="wisci-eval-")
    subprocess.run(
        [sys.executable, os.path.join(HERE, "fixtures", "make_fixture.py"), target],
        check=True, capture_output=True, text=True)
    return target


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def check_assertion(a, cwd, result_text):
    t = a["type"]
    path = os.path.join(cwd, a.get("path", ""))
    if t == "output_contains":
        return a["needle"].lower() in result_text.lower()
    if t == "output_not_contains":
        return a["needle"].lower() not in result_text.lower()
    if t == "file_exists":
        return os.path.isfile(path)
    if t == "file_absent":
        return not os.path.exists(path)
    if t == "file_contains":
        return os.path.isfile(path) and a["needle"] in open(path, encoding="utf-8").read()
    if t == "glob_min":
        return len(globmod.glob(os.path.join(cwd, a["pattern"]))) >= a["min"]
    if t == "glob_contains":
        return any(a["needle"] in open(p, encoding="utf-8").read()
                   for p in globmod.glob(os.path.join(cwd, a["pattern"])))
    if t == "file_unchanged":
        return a.get("_pre_sha") is not None and os.path.isfile(path) \
            and sha(path) == a["_pre_sha"]
    if t in ("git_log_contains", "git_log_not_contains"):
        r = subprocess.run(["git", "log", "-1", "--format=%B"], cwd=cwd,
                           capture_output=True, text=True)
        found = a["needle"] in r.stdout
        return found if t == "git_log_contains" else not found
    raise ValueError(f"unknown assertion type: {t}")


def load_suites(directory, skill_filter):
    suites = []
    for f in sorted(os.listdir(os.path.join(HERE, directory))):
        if f.endswith(".json"):
            suite = json.load(open(os.path.join(HERE, directory, f), encoding="utf-8"))
            if not skill_filter or suite["skill"] == skill_filter:
                suites.append(suite)
    return suites


def out_dir():
    d = os.path.join(HERE, "outputs", time.strftime("%Y%m%d-%H%M%S"))
    os.makedirs(d, exist_ok=True)
    return d


def run_triggers(args):
    results, outputs = [], out_dir()
    for suite in load_suites("triggers", args.skill):
        skill = suite["skill"]
        for expected, key in ((True, "should_trigger"), (False, "should_not_trigger")):
            for case in suite[key]:
                if args.split != "all" and case["split"] != args.split:
                    continue
                for run_i in range(args.runs):
                    fixture = make_fixture()
                    try:
                        transcript, _ = claude_run(case["prompt"], fixture, TRIGGER_TURNS)
                    finally:
                        shutil.rmtree(fixture, ignore_errors=True)
                    invoked = skill_invoked(transcript, skill)
                    passed = invoked == expected
                    results.append({"skill": skill, "prompt": case["prompt"],
                                    "split": case["split"], "expected": expected,
                                    "invoked": invoked, "pass": passed, "run": run_i})
                    print(f"[{'PASS' if passed else 'FAIL'}] {skill} "
                          f"expect={'fire' if expected else 'silent'} :: {case['prompt']}")
    summarize(results, outputs, "triggers")


def run_tasks(args):
    results, outputs = [], out_dir()
    for suite in load_suites("tasks", args.skill):
        skill = suite["skill"]
        for task in suite["tasks"]:
            for run_i in range(args.runs):
                fixture = make_fixture()
                try:
                    for cmd in task.get("setup", []):
                        subprocess.run(cmd, shell=True, cwd=fixture, check=True,
                                       capture_output=True)
                    for a in task["assertions"]:
                        if a["type"] == "file_unchanged":
                            p = os.path.join(fixture, a["path"])
                            a["_pre_sha"] = sha(p) if os.path.isfile(p) else None
                    t0 = time.time()
                    _, result_text = claude_run(
                        task["prompt"], fixture, TASK_TURNS, bypass=True)
                    elapsed = round(time.time() - t0, 1)
                    checks = [{"assertion": {k: v for k, v in a.items() if k != "_pre_sha"},
                               "pass": check_assertion(a, fixture, result_text)}
                              for a in task["assertions"]]
                    passed = all(c["pass"] for c in checks)
                    name = f"{skill}.{task['name']}.run{run_i}"
                    with open(os.path.join(outputs, name + ".result.md"), "w",
                              encoding="utf-8") as f:
                        f.write(result_text)
                    results.append({"skill": skill, "task": task["name"], "run": run_i,
                                    "pass": passed, "seconds": elapsed, "checks": checks})
                    print(f"[{'PASS' if passed else 'FAIL'}] {skill}.{task['name']} "
                          f"({elapsed}s)")
                    for c in checks:
                        if not c["pass"]:
                            print(f"    failed: {c['assertion']}")
                finally:
                    shutil.rmtree(fixture, ignore_errors=True)
    summarize(results, outputs, "tasks")


def run_compare(args):
    a_files = {f: open(os.path.join(args.dir_a, f), encoding="utf-8").read()
               for f in os.listdir(args.dir_a) if f.endswith(".result.md")}
    verdicts = []
    for name, a_text in sorted(a_files.items()):
        b_path = os.path.join(args.dir_b, name)
        if not os.path.isfile(b_path):
            continue
        b_text = open(b_path, encoding="utf-8").read()
        flipped = random.random() < 0.5
        first, second = (b_text, a_text) if flipped else (a_text, b_text)
        prompt = (
            "You are judging two anonymous outputs for the same task. Score holistic "
            "quality: organization, specificity, formatting, usability. Reply with "
            "exactly ONE word: FIRST or SECOND.\n\n"
            f"<first>\n{first}\n</first>\n\n<second>\n{second}\n</second>"
        )
        _, verdict = claude_run(prompt, HERE, "1")
        winner = "A" if (("FIRST" in verdict.upper()) != flipped) else "B"
        verdicts.append({"case": name, "winner": winner})
        print(f"{name}: {winner}")
    tally = {"A": sum(1 for v in verdicts if v["winner"] == "A"),
             "B": sum(1 for v in verdicts if v["winner"] == "B")}
    print(json.dumps(tally))


def summarize(results, outputs, mode):
    passed = sum(1 for r in results if r["pass"])
    bench = {"mode": mode, "total": len(results), "passed": passed,
             "pass_rate": round(passed / len(results), 3) if results else None}
    with open(os.path.join(outputs, "grading.json"), "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)
    with open(os.path.join(outputs, "benchmark.json"), "w", encoding="utf-8") as f:
        json.dump(bench, f, indent=2)
    print(f"\n{passed}/{len(results)} passed → {outputs}")


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="mode", required=True)
    t = sub.add_parser("triggers")
    t.add_argument("--skill")
    t.add_argument("--split", choices=["train", "validation", "all"], default="all")
    t.add_argument("--runs", type=int, default=1)
    k = sub.add_parser("tasks")
    k.add_argument("--skill")
    k.add_argument("--runs", type=int, default=1)
    c = sub.add_parser("compare")
    c.add_argument("dir_a")
    c.add_argument("dir_b")
    args = p.parse_args()
    {"triggers": run_triggers, "tasks": run_tasks, "compare": run_compare}[args.mode](args)


if __name__ == "__main__":
    main()
