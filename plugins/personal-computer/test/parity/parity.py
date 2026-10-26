"""Span parity of a detection backend against a recorded baseline, on the texts in texts.json (made-up data).

usage: python3 parity.py --model opf|pii-tracer --record <name> [-- <scan.py args>]    record baseline/<model>-<name>.json
       python3 parity.py --model opf|pii-tracer --against <name> [--texts a,b] [-- <scan.py args>]   compare; exit 1
                                                                                     on any difference
Runs scan.py --spans through uv, so it needs the models (as /personal-computer setup fetches them). A span is its
(type, start, end): scores are each backend's own. "long" is text c three times, past one OPF window (8192 tokens);
OPF on ONNX needs about 22 GB of memory for it, so --texts can leave it out where there is less.
"""
import argparse, json, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCAN = HERE.parents[1] / "scanner" / "scan.py"


def texts():
    t = json.loads((HERE / "texts.json").read_text())
    return {**t, "long": "\n\n".join([t["c"]] * 3)}


def spans(model, names, extra):
    run = subprocess.run(["uv", "run", "--script", str(SCAN), "--spans", "--models", model, *extra],
                         input=json.dumps([texts()[n] for n in names]), capture_output=True, text=True)
    if run.returncode != 0:
        sys.exit(f"scan.py failed ({run.returncode}):\n{run.stderr[-4000:]}")
    return {n: sorted({(s["type"], s["start"], s["end"]) for s in found}) for n, found in zip(names, json.loads(run.stdout))}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--model", required=True, choices=["opf", "pii-tracer"])
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--record")
    g.add_argument("--against")
    p.add_argument("--texts", help="only these, comma-separated (compare only)")
    p.add_argument("scan_args", nargs="*")
    a = p.parse_args()
    t = texts()
    if a.texts and a.record:
        p.error("--texts is for comparing: a baseline holds every text")
    got = spans(a.model, a.texts.split(",") if a.texts else list(t), a.scan_args)
    if a.record:
        out = HERE / "baseline" / f"{a.model}-{a.record}.json"
        out.write_text(json.dumps({n: [list(s) for s in v] for n, v in got.items()}, indent=0) + "\n")
        print(f"recorded {out.name}: " + ", ".join(f"{n} {len(v)}" for n, v in got.items()))
        return
    base = json.loads((HERE / "baseline" / f"{a.model}-{a.against}.json").read_text())
    differ = 0
    for n, v in got.items():
        want = {tuple(s) for s in base[n]}
        have = set(v)
        if want == have:
            print(f"{n}: {len(have)} spans, same")
            continue
        differ += 1
        print(f"{n}: {len(have & want)}/{len(want)} same, {len(want - have)} missing, {len(have - want)} extra")
        for label, group in (("missing", want - have), ("extra", have - want)):
            for typ, s, e in sorted(group, key=lambda x: x[1]):
                print(f"  {label} {typ} {s}-{e} {t[n][s:e]!r}")
    sys.exit(1 if differ else 0)


if __name__ == "__main__":
    main()
