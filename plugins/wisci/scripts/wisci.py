# /// script
# requires-python = ">=3.11"
# dependencies = []
# [tool.uv]
# required-version = ">=0.12"
# ///
"""wisci.py — deterministic core for the WISCI context framework (3.x).

Store layout (under the project root):
  .wisci/context/<slug>.md    knowledge notes            (/write)
  .wisci/handoff/<slug>.md    per-stream work state      (/compress)

A note is split into `## ` sections. Evidence is a fenced block whose info string
names a source file:

  ```ts src/auth/session.ts
  export const SESSION_TTL = 3600
  ```

At every read the quoted lines must still occur exactly once, as whole lines with
the same relative indentation, in that file. A section whose evidence all matches
is `ok`; one with failing evidence is `check`; one without evidence has no status.
`ok` means the quoted code is still there, not that the claim is verified.
Nothing is stored: the note itself carries its evidence.

Commands (run anywhere in the project; --root overrides the git toplevel):
  scan                        compact JSON health of every store file + streams
  load <file>                 the note with failing sections marked (file: path or scan key, context/<slug>)
  check <file>                evidence problems per section, then `evidence ok N/M`
  new <context|handoff> <slug>  reserve a new store file, print its path
  session-status              store summary for the SessionStart hook
  test                        self-tests

Run: uv run --no-config --no-cache --script wisci.py <command>. Python 3.11+ stdlib only.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime

STORE = ".wisci"
KINDS = ("context", "handoff")
STREAM_STATUSES = ("active", "blocked", "done")
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
MAX_SLUG = 40
GOAL_BYTES = 48
MAX_SOURCE_BYTES = 1_000_000
PREAMBLE = "~preamble"


class WisciError(Exception):
    """User-facing failure: printed as `wisci: <message>`, exit code 2."""


def project_root(start):
    try:
        r = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=start, capture_output=True, check=False)
    except FileNotFoundError:
        return os.path.realpath(start)
    return os.path.realpath(r.stdout.decode().strip() if r.returncode == 0 else start)


# ---------- frontmatter ----------

FM_RE = re.compile(r"\A---[ \t]*\n(.*?)\n---[ \t]*(?:\n|\Z)", re.DOTALL)


def _scalar(value):
    if value[:1] in ("'", '"'):
        end = value.find(value[0], 1)
        return value[1:end] if end != -1 else value[1:]
    return re.split(r"\s+#", value, maxsplit=1)[0].strip()


def parse_frontmatter(text):
    """Top-level `key: value` pairs; YAML ` #` comments are stripped outside quotes."""
    m = FM_RE.match(text.replace("\r\n", "\n"))
    if not m:
        return {}
    fm = {}
    for line in m.group(1).splitlines():
        if ":" in line and line[:1] not in (" ", "\t", "#"):
            key, _, value = line.partition(":")
            fm[key.strip()] = _scalar(value.strip())
    return fm


# ---------- sections and evidence blocks ----------

HEADING_RE = re.compile(r"^## (.*)$")
FENCE_OPEN_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
SUFFIX_RE = re.compile(r"(?::\d+(?:-\d+)?|[:#]L\d+(?:-L?\d+)?)$")


def parse_doc(text):
    """Frontmatter and `## ` sections; each section keeps its raw lines and its fenced blocks."""
    text = text.replace("\r\n", "\n")
    m = FM_RE.match(text)
    frontmatter = m.group(0) if m else ""
    sections = [{"id": PREAMBLE, "heading": None, "lines": [], "blocks": []}]
    fence = None  # (marker, info, content lines) while inside a fenced block
    for line in text[len(frontmatter):].split("\n"):
        current = sections[-1]
        current["lines"].append(line)
        if fence:
            if re.match(rf"^ {{0,3}}{re.escape(fence[0][0])}{{{len(fence[0])},}}\s*$", line):
                current["blocks"].append({"info": fence[1], "lines": fence[2], "closed": True})
                fence = None
            else:
                fence[2].append(line)
            continue
        opened = FENCE_OPEN_RE.match(line)
        if opened:
            fence = (opened.group(1), opened.group(2).strip(), [])
            continue
        heading = HEADING_RE.match(line)
        if heading:
            current["lines"].pop()
            sid = re.sub(r"\s+#+\s*$", "", heading.group(1)).strip()
            sections.append({"id": sid, "heading": line, "lines": [], "blocks": []})
    if fence:
        sections[-1]["blocks"].append({"info": fence[1], "lines": fence[2], "closed": False})
    return {"frontmatter": frontmatter, "sections": sections}


def evidence_path(info, root):
    """The source path an info string names, or None for a plain code block.

    One token: a path if it contains `/`, ends in `.ext` or names an existing file.
    Two or more: the first is the language, the rest (spaces included) is the path.
    """
    tokens = info.split()
    if not tokens:
        return None
    if len(tokens) == 1:
        token = SUFFIX_RE.sub("", tokens[0])
        is_path = "/" in token or re.search(r"\.\w+$", token) or os.path.isfile(os.path.join(root, token))
        return token if is_path else None
    return SUFFIX_RE.sub("", info.split(None, 1)[1].strip())


# ---------- matching ----------

def _dedent(lines):
    margin = min((len(ln) - len(ln.lstrip()) for ln in lines if ln.strip()), default=0)
    return [ln[margin:].rstrip() if ln.strip() else "" for ln in lines]


def occurrences(excerpt, source_lines):
    """How many runs of whole source lines equal the excerpt, up to common indentation.

    Trailing whitespace (CR included) is ignored; the first-line test only narrows candidates.
    """
    want = _dedent(excerpt)
    first = want[0].strip()
    found = 0
    for i, line in enumerate(source_lines):
        if line.strip() == first and _dedent(source_lines[i:i + len(want)]) == want:
            found += 1
    return found


def _excerpt(block):
    lines = [ln.rstrip() for ln in block["lines"]]
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return lines


def read_source(root, path, cache):
    """(lines, None) for a readable text file inside the project, else (None, reason)."""
    if path in cache:
        return cache[path]
    real_root = os.path.realpath(root)
    target = os.path.realpath(os.path.join(root, path))
    rel = os.path.relpath(target, real_root)
    if os.path.isabs(path) or rel == ".." or rel.startswith(".." + os.sep):
        result = (None, "outside the project")
    elif not os.path.exists(target):
        result = (None, "file missing")
    elif not os.path.isfile(target) or rel == STORE or rel.startswith(STORE + os.sep):
        result = (None, "not a source file")
    elif os.path.getsize(target) > MAX_SOURCE_BYTES:
        result = (None, "file too large")
    else:
        with open(target, "rb") as f:
            data = f.read()
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            text = None
        result = (None, "not a text file") if text is None or "\0" in text else (text.split("\n"), None)
    cache[path] = result
    return result


def check_block(root, block, path, cache):
    """None when the evidence matches, else a failure {path, reason, quote}; path is None for an unclosed plain fence."""
    excerpt = _excerpt(block)
    quote = excerpt[0].strip() if excerpt else ""
    if not block["closed"]:
        reason = "unclosed fence"
    elif not excerpt:
        reason = "empty quote"
    else:
        lines, reason = read_source(root, path, cache)
        if lines is not None:
            n = occurrences(excerpt, lines)
            reason = None if n == 1 else "not found" if n == 0 else f"found {n} times"
    return None if reason is None else {"path": path, "reason": reason, "quote": quote}


# ---------- store files ----------

def store_rel(root, path):
    """Root-relative path of a store file, given as that path or as its scan key (`context/<slug>`);
    anything outside the store is rejected."""
    kind, _, name = path.partition("/")
    if kind in KINDS and name and "/" not in name:
        path = f"{STORE}/{kind}/{name.removesuffix('.md')}.md"
    rel = os.path.relpath(os.path.abspath(os.path.join(root, path)), root).replace(os.sep, "/")
    parts = rel.split("/")
    if len(parts) == 3 and parts[0] == STORE and parts[1] in KINDS and parts[2].endswith(".md") and len(parts[2]) > 3:
        return rel
    raise WisciError(f"{path}: not a store file (expected .wisci/context/*.md or .wisci/handoff/*.md)")


def store_key(rel):
    return rel[len(STORE) + 1:-3]


def store_files(root):
    files = []
    for kind in KINDS:
        d = os.path.join(root, STORE, kind)
        if os.path.isdir(d):
            files += [f"{STORE}/{kind}/{n}" for n in sorted(os.listdir(d)) if n.endswith(".md") and len(n) > 3]
    return files


def _read(root, rel):
    path = os.path.join(root, rel)
    if not os.path.isfile(path):
        raise WisciError(f"{rel}: no such store file")
    with open(path, encoding="utf-8") as f:
        return f.read().removeprefix("\ufeff")


# ---------- analyze, load, check ----------

def analyze(root, rel, cache=None):
    """Per-section evidence results: status `ok`, `check` or None (no evidence)."""
    cache = {} if cache is None else cache
    rel = store_rel(root, rel)
    doc = parse_doc(_read(root, rel))
    sections, quotes, failed = [], 0, 0
    for s in doc["sections"]:
        failures, count = [], 0
        for block in s["blocks"]:
            path = evidence_path(block["info"], root)
            if path is None and block["closed"]:
                continue
            count += 1
            failure = check_block(root, block, path, cache)
            if failure:
                failures.append(failure)
        quotes += count
        failed += len(failures)
        status = "check" if failures else "ok" if count else None
        sections.append({"id": s["id"], "status": status, "failures": failures, "quotes": count})
    return {"file": rel, "sections": sections, "quotes": quotes, "failed": failed, "doc": doc}


PHRASES = {"not found": "no longer contains `{quote}`", "file missing": "does not exist",
           "outside the project": "is outside the project", "not a source file": "is not a source file",
           "not a text file": "is not a text file", "file too large": "is too large to check",
           "empty quote": "has an empty quote"}


def describe(failure: dict) -> str:
    reason = failure["reason"]
    if reason == "unclosed fence":
        return "a code fence is not closed"
    phrase = PHRASES[reason] if reason in PHRASES else "contains the quoted code " + reason.removeprefix("found ")
    return f"`{failure['path']}` " + phrase.format(quote=failure["quote"])


def marker(failures):
    """The line a failing section loads under."""
    return "> check — " + "; ".join(map(describe, failures)) + ". Re-read it before relying on this section."


def render_load(root, rel):
    """The note as Claude should see it: every section, failing ones under a marker."""
    a = analyze(root, rel)
    head, out = [], []
    if a["doc"]["frontmatter"]:
        head.append(a["doc"]["frontmatter"].rstrip("\n"))
    for s, info in zip(a["doc"]["sections"], a["sections"]):
        lines = s["lines"]
        if s["id"] == PREAMBLE:
            head.extend(line for line in lines if line.startswith("# "))
            lines = [line for line in lines if not line.startswith("# ")]
        else:
            out.append(s["heading"])
        if info["status"] == "check":
            out.append(marker(info["failures"]))
        out.extend(lines)
    blocks = ["\n\n".join(head), "\n".join(out).strip("\n")]
    text = "\n\n".join(b for b in blocks if b) + "\n"
    size = len(text.encode("utf-8"))
    return text + f"> bytes={size} ~tokens={(size + 3) // 4} evidence ok {a['quotes'] - a['failed']}/{a['quotes']}\n"


def render_check(root, rel):
    """Only the problems, one line per failing section, then the evidence count."""
    a = analyze(root, rel)
    lines = [f"{'(top)' if s['id'] == PREAMBLE else s['id']}: " + "; ".join(map(describe, s["failures"]))
             for s in a["sections"] if s["failures"]]
    return "\n".join(lines + [f"evidence ok {a['quotes'] - a['failed']}/{a['quotes']}"]) + "\n"


# ---------- scan and streams ----------

def truncate_goal(goal):
    """Longest prefix whose JSON encoding (with `…`) fits GOAL_BYTES; escapes are never split."""
    def size(s):
        return len(json.dumps(s, ensure_ascii=False).encode("utf-8"))
    if size(goal) <= GOAL_BYTES:
        return goal
    for end in range(min(len(goal) - 1, GOAL_BYTES), -1, -1):
        if size(goal[:end] + "…") <= GOAL_BYTES:
            return goal[:end] + "…"
    return "…"


def stream_info(root, rel):
    fm = parse_frontmatter(_read(root, rel))
    lifecycle = fm.get("status") or "active"
    if lifecycle not in STREAM_STATUSES:
        raise WisciError(f"{rel}: status {lifecycle!r} not in {STREAM_STATUSES}; fix its frontmatter")
    return lifecycle, fm.get("updated", ""), fm.get("goal", "")


def scan(root):
    """[path, failed, quotes] for every store file, plus handoff streams."""
    if not os.path.isdir(os.path.join(root, STORE)):
        return {"v": 2, "store": False}
    cache, health, streams = {}, [], []
    for rel in store_files(root):
        a = analyze(root, rel, cache)
        key = store_key(rel)
        health.append([key, a["failed"], a["quotes"]])
        if rel.startswith(f"{STORE}/handoff/"):
            lifecycle, updated, goal = stream_info(root, rel)
            streams.append([key, lifecycle, updated, truncate_goal(goal)])
    return {"v": 2, "store": True, "health": health, "streams": streams}


def evidence_label(failed, quotes):
    return f"{failed}/{quotes} quotes failing" if failed else f"{quotes}/{quotes} quotes ok" if quotes else "no quotes"


def session_status(root):
    """Store summary for the SessionStart hook; empty when there is nothing stored."""
    result = scan(root)
    if not result["store"] or not result["health"]:
        return ""
    lifecycle = {s[0]: s[1] for s in result["streams"]}
    order = {"active": 0, "blocked": 1, "done": 2}
    rows = sorted(result["health"],
                  key=lambda h: (h[0] not in lifecycle, order.get(lifecycle.get(h[0], ""), 3), h[0]))
    lines = [f"  {key} — {lifecycle[key] + ', ' if key in lifecycle else ''}{evidence_label(failed, quotes)}"
             for key, failed, quotes in rows[:10]]
    if len(rows) > 10:
        lines.append(f"  +{len(rows) - 10} more")
    return ("WISCI store: load a note or handoff with /select <path>, not Read. "
            "The loader flags quotes the code no longer matches.\n" + "\n".join(lines))


# ---------- new ----------

def new_file(root, kind, slug):
    """Reserve a new store file atomically (O_EXCL) and return its root-relative path."""
    if kind not in KINDS:
        raise WisciError(f"kind must be one of {KINDS}")
    if not SLUG_RE.match(slug) or len(slug) > MAX_SLUG:
        raise WisciError(f"slug {slug!r} must match {SLUG_RE.pattern} and be at most {MAX_SLUG} chars")
    os.makedirs(os.path.join(root, STORE, kind), exist_ok=True)
    skeleton = (f"---\nstatus: active\nupdated: {datetime.now().astimezone().strftime('%Y-%m-%d %H:%M')}\n"
                "goal: \n---\n" if kind == "handoff" else f"# {slug}\n")
    name, n = slug, 1
    while True:
        rel = f"{STORE}/{kind}/{name}.md"
        try:
            fd = os.open(os.path.join(root, rel), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            n += 1
            suffix = f"-{n}"
            name = slug[:MAX_SLUG - len(suffix)].rstrip("-") + suffix
            continue
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(skeleton)
        return rel


# ---------- self-tests ----------

def _repo():
    import tempfile
    return os.path.realpath(tempfile.mkdtemp(prefix="wisci-test-"))


def _w(root, rel, content):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path) or root, exist_ok=True)
    with open(path, "wb") as f:
        f.write(content.encode("utf-8") if isinstance(content, str) else content)


def _note(root, slug, text):
    _w(root, f"{STORE}/context/{slug}.md", text)
    return f"{STORE}/context/{slug}.md"


def _st(root, rel):
    return {s["id"]: s["status"] for s in analyze(root, rel)["sections"] if s["id"] != PREAMBLE}


def _why(root, rel):
    return [f["reason"] for s in analyze(root, rel)["sections"] for f in s["failures"]]


def _raises(fn, *args, **kw):
    try:
        fn(*args, **kw)
    except WisciError as e:
        return str(e)
    raise AssertionError(f"{fn.__name__} did not raise WisciError")


def _quote(path, *lines, lang="ts"):
    return f"```{lang} {path}\n" + "\n".join(lines) + "\n```\n"


TTL = "export const SESSION_TTL = 3600 // seconds\n"


# evidence grammar

def t_info_string_grammar(root):
    _w(root, "Makefile", "x\n")
    _w(root, "docs/My File.md", "x\n")
    assert evidence_path("ts src/a.ts", root) == "src/a.ts"
    assert evidence_path("src/a.ts", root) == "src/a.ts"
    assert evidence_path("Makefile", root) == "Makefile"
    assert evidence_path("bash Makefile", root) == "Makefile"
    assert evidence_path("md docs/My File.md", root) == "docs/My File.md"
    assert evidence_path("ts src/a.ts:12", root) == "src/a.ts"
    assert evidence_path("ts src/a.ts#L3-L9", root) == "src/a.ts"
    assert evidence_path("python", root) is None and evidence_path("", root) is None


def t_plain_fences_and_spans_are_prose(root):
    rel = _note(root, "n", "## A\nUses `src/missing.ts`.\n```python\nprint(1)\n```\n")
    assert _st(root, rel) == {"A": None} and analyze(root, rel)["quotes"] == 0


def t_matching_quote_is_ok(root):
    _w(root, "src/auth/session.ts", "import x\n" + TTL)
    rel = _note(root, "n", "## Session\nTTL is 3600 s.\n" + _quote("src/auth/session.ts", TTL.strip()))
    assert _st(root, rel) == {"Session": "ok"}


def t_changed_value_fails_even_as_prefix(root):
    _w(root, "src/s.ts", "SESSION_TTL = 600\n")
    rel = _note(root, "n", "## S\n" + _quote("src/s.ts", "SESSION_TTL = 60"))
    assert _st(root, rel) == {"S": "check"} and _why(root, rel) == ["not found"]


def t_code_moved_within_file_still_matches(root):
    _w(root, "a.py", "def f():\n    return 1\n")
    rel = _note(root, "n", "## F\n" + _quote("a.py", "def f():", "    return 1", lang="py"))
    assert _st(root, rel) == {"F": "ok"}
    _w(root, "a.py", "import os\n\n\nclass K:\n    def f():\n        return 1\n")
    assert _st(root, rel) == {"F": "ok"}


def t_relative_indentation_counts(root):
    _w(root, "a.py", "delete_account()\nnext()\n")
    rel = _note(root, "n", "## D\n" + _quote("a.py", "delete_account()", "next()", lang="py"))
    assert _st(root, rel) == {"D": "ok"}
    _w(root, "a.py", "if admin:\n    delete_account()\nnext()\n")
    assert _st(root, rel) == {"D": "check"}


def t_lines_from_two_places_do_not_stitch(root):
    _w(root, "a.py", "def login():\n    check()\n\ndef other():\n    return True\n")
    rel = _note(root, "n", "## L\n" + _quote("a.py", "def login():", "    return True", lang="py"))
    assert _why(root, rel) == ["not found"]


def t_partial_line_does_not_match(root):
    _w(root, "a.ts", TTL)
    rel = _note(root, "n", "## P\n" + _quote("a.ts", "SESSION_TTL = 3600"))
    assert _why(root, rel) == ["not found"]


def t_crlf_and_trailing_space_are_ignored(root):
    _w(root, "a.ts", "const A = 1;   \r\nconst B = 2;\r\n")
    rel = _note(root, "n", "## C\n" + _quote("a.ts", "const A = 1;", "const B = 2;"))
    assert _st(root, rel) == {"C": "ok"}


def t_duplicate_code_is_ambiguous(root):
    _w(root, "a.js", "}\nx()\n}\n")
    rel = _note(root, "n", "## B\n" + _quote("a.js", "}", lang="js"))
    assert _why(root, rel) == ["found 2 times"]
    out = render_load(root, rel)
    assert "`a.js` contains the quoted code 2 times" in out, out


def t_bad_sources_fail_with_reasons(root):
    outside = _repo()
    _w(outside, "x.ts", "x\n")
    os.symlink(os.path.join(outside, "x.ts"), os.path.join(root, "link.ts"))
    os.makedirs(os.path.join(root, "dir.ts"))
    _w(root, "bin.ts", b"\x00\x01\x02")
    _w(root, "big.ts", "x\n" * (MAX_SOURCE_BYTES // 2 + 1))
    _note(root, "other", "## X\nquoted\n")
    cases = {"gone.ts": "file missing", "link.ts": "outside the project", "../x.ts": "outside the project",
             "dir.ts": "not a source file", f"{STORE}/context/other.md": "not a source file",
             "bin.ts": "not a text file", "big.ts": "file too large"}
    for path, reason in cases.items():
        rel = _note(root, "n", "## S\n" + _quote(path, "x"))
        assert _why(root, rel) == [reason], (path, _why(root, rel))


def t_empty_quote_and_unclosed_fence_fail(root):
    _w(root, "a.ts", "x\n")
    rel = _note(root, "n", "## E\n```ts a.ts\n\n```\n")
    assert _why(root, rel) == ["empty quote"]
    rel = _note(root, "n", "## E\n```ts a.ts\n\nx\n\n```\n")
    assert _st(root, rel) == {"E": "ok"}
    rel = _note(root, "n", "## U\n```ts a.ts\nx\n")
    assert _why(root, rel) == ["unclosed fence"]
    rel = _note(root, "n", "## U\n```python\nx\n")
    assert _why(root, rel) == ["unclosed fence"]
    assert render_check(root, rel) == "U: a code fence is not closed\nevidence ok 0/1\n"


def t_symlink_inside_project_is_followed(root):
    _w(root, "config/a.json", '{"debug": true}\n')
    os.symlink("config/a.json", os.path.join(root, "settings.json"))
    rel = _note(root, "n", "## D\n" + _quote("settings.json", '{"debug": true}', lang="json"))
    assert _st(root, rel) == {"D": "ok"}


# sections and counts

def t_section_statuses_and_counts(root):
    _w(root, "a.ts", "a()\n")
    rel = _note(root, "n", "# T\n\n## Ok\n" + _quote("a.ts", "a()") + "\n## Bad\n" + _quote("a.ts", "b()")
                + _quote("a.ts", "a()") + "\n## Plain\nA decision.\n")
    a = analyze(root, rel)
    assert _st(root, rel) == {"Ok": "ok", "Bad": "check", "Plain": None}
    assert (a["quotes"], a["failed"]) == (3, 1)


def t_duplicate_headings_are_harmless(root):
    _w(root, "a.ts", "a()\n")
    rel = _note(root, "n", "## A\n" + _quote("a.ts", "a()") + "\n## A\nmore\n")
    assert [s["status"] for s in analyze(root, rel)["sections"]] == [None, "ok", None]


def t_fenced_heading_is_not_a_heading(root):
    rel = _note(root, "n", "## A\n```\n## not a heading\n```\n")
    assert list(_st(root, rel)) == ["A"]


def t_preamble_evidence_counts(root):
    _w(root, "a.ts", "a()\n")
    rel = _note(root, "n", "# T\n\nIntro.\n" + _quote("a.ts", "b()") + "\n## A\nplain\n")
    a = analyze(root, rel)
    assert a["sections"][0]["status"] == "check" and a["failed"] == 1
    assert render_check(root, rel).startswith("(top): `a.ts` no longer contains `b()`")


# load and check

def t_load_keeps_everything_and_marks_failures(root):
    _w(root, "src/s.ts", TTL)
    rel = _note(root, "n", "# Title\n\n> Source: session\n\n## Session\nTTL is 3600 s.\n"
                + _quote("src/s.ts", TTL.strip()) + "\n## Decision\nKeep sessions short.\n")
    assert render_load(root, rel).endswith(" evidence ok 1/1\n")
    _w(root, "src/s.ts", "export const SESSION_TTL = 60 // seconds\n")
    out = render_load(root, rel)
    assert out.startswith("# Title\n\n> Source: session"), out
    flagged = ("## Session\n> check — `src/s.ts` no longer contains `export const SESSION_TTL = 3600 // seconds`. "
               "Re-read it before relying on this section.\nTTL is 3600 s.")
    assert flagged in out, out
    assert "Keep sessions short." in out and out.count("> check") == 1
    assert out.endswith(" evidence ok 0/1\n"), out


def t_load_keeps_frontmatter(root):
    text = "\ufeff---  \nstatus: done\ngoal: g\n---\t\n## Next\nplain\n"
    _w(root, f"{STORE}/handoff/x.md", text)
    out = render_load(root, f"{STORE}/handoff/x.md")
    assert out.startswith("---") and "status: done" in out and "\ufeff" not in out


def t_check_lists_only_problems(root):
    _w(root, "a.ts", "a()\n")
    rel = _note(root, "n", "## Good\n" + _quote("a.ts", "a()") + "\n## Bad\n" + _quote("gone.ts", "x") + "\n")
    assert render_check(root, rel) == "Bad: `gone.ts` does not exist\nevidence ok 1/2\n"


def t_cli_check_exits_zero(root):
    rel = _note(root, "n", "## Bad\n" + _quote("gone.ts", "x"))
    r = subprocess.run([sys.executable, os.path.abspath(__file__), "--root", root, "check", rel],
                       capture_output=True, text=True, check=False)
    assert r.returncode == 0 and "evidence ok 0/1" in r.stdout, (r.returncode, r.stdout, r.stderr)


def t_store_paths_are_contained(root):
    _w(root, "x.md", "## A\nplain\n")
    for bad in ("x.md", f"{STORE}/context/../../x.md", f"{STORE}/primer.md", "context/a/b"):
        _raises(render_load, root, bad)


def t_scan_keys_load(root):
    rel = _note(root, "n", "## A\nplain\n")
    assert render_load(root, "context/n") == render_load(root, "context/n.md") == render_load(root, rel)


# frontmatter and streams

def t_frontmatter_comments_and_quotes(_root):
    fm = parse_frontmatter('---\nstatus: active   # active | blocked | done\ngoal: "fix #12 bug"\n---\n# Body\n')
    assert fm == {"status": "active", "goal": "fix #12 bug"}, fm


def t_frontmatter_ignores_indented_keys(root):
    _w(root, f"{STORE}/handoff/x.md", "---\ngoal: g\nmeta:\n  status: done\n---\n## Next\nplain\n")
    assert scan(root)["streams"][0][1] == "active"


def t_unknown_stream_status_raises(root):
    _w(root, f"{STORE}/handoff/x.md", "---\nstatus: paused\ngoal: g\n---\n## Next\nplain\n")
    msg = _raises(scan, root)
    assert "x.md" in msg and "active" in msg


# new

def t_new_validates_and_suffixes(root):
    for bad in ("../x", "a/b", "UPPER", "a--b", "-a", ""):
        _raises(new_file, root, "context", bad)
    _raises(new_file, root, "notes", "x")
    assert new_file(root, "context", "topic") == f"{STORE}/context/topic.md"
    assert new_file(root, "context", "topic") == f"{STORE}/context/topic-2.md"
    leaf = new_file(root, "handoff", "stream")
    assert parse_frontmatter(_read(root, leaf))["status"] == "active"


def t_new_is_race_free(root):
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(8) as pool:
        paths = list(pool.map(lambda _: new_file(root, "handoff", "race"), range(8)))
    assert len(set(paths)) == 8


def t_new_max_length_collision(root):
    slug = "a" * MAX_SLUG
    p1, p2 = new_file(root, "context", slug), new_file(root, "context", slug)
    name = os.path.basename(p2)[:-3]
    assert p1 != p2 and len(name) <= MAX_SLUG and SLUG_RE.match(name), name


# scan and session status

def _entry_bytes(entry):
    return len(json.dumps(entry, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) + 1


def t_scan_health_and_budget(root):
    _w(root, "a.ts", "a()\n")
    _note(root, "n", "## A\n" + _quote("a.ts", "a()") + _quote("a.ts", "b()"))
    _note(root, "p", "## A\nplain\n")
    assert scan(root)["health"] == [["context/n", 1, 2], ["context/p", 0, 0]]
    for i in range(50):
        _note(root, f"m{i:019d}", "## A\nplain\n")
    avg = sum(_entry_bytes(e) for e in scan(root)["health"]) / 52
    assert avg <= 40, avg


def t_scan_stream_budget_and_truncation(root):
    goal = ('Ship the "é" rate limiter \\ with backslashes and naïve unicode ✓ ' * 4)[:200]
    for i in range(50):
        _w(root, f"{STORE}/handoff/h{i:039d}.md",
           f"---\nstatus: blocked\nupdated: 2026-10-08 13:13\ngoal: {goal}\n---\n## Next\nplain\n")
    streams = scan(root)["streams"]
    assert all(_entry_bytes(s) <= 140 for s in streams), max(_entry_bytes(s) for s in streams)


def t_goal_truncation_round_trips(_root):
    for special in ('"', "\\", "\n", "\x01", "é", "✓"):
        for k in range(30, 50):
            goal = "a" * k + special + "b" * 60
            cut = truncate_goal(goal)
            encoded = json.dumps(cut, ensure_ascii=False)
            assert len(encoded.encode("utf-8")) <= GOAL_BYTES, (special, k, encoded)
            assert json.loads(encoded) == cut
            assert cut == goal or (cut.endswith("…") and goal.startswith(cut[:-1]))


def t_scan_keeps_long_names_and_namespaces(root):
    long_name = "x" * 100
    _w(root, f"{STORE}/handoff/{long_name}.md", "---\nstatus: active\ngoal: g\n---\n## Next\nplain\n")
    _w(root, f"{STORE}/handoff/auth.md", "---\nstatus: active\ngoal: g\n---\n## Next\nplain\n")
    _note(root, "auth", "## A\nplain\n")
    keys = [h[0] for h in scan(root)["health"]]
    assert f"handoff/{long_name}" in keys and "handoff/auth" in keys and "context/auth" in keys


def t_scan_without_store(root):
    assert scan(root) == {"v": 2, "store": False}


def t_session_status(root):
    assert session_status(root) == ""
    _w(root, "a.ts", "a()\n")
    _note(root, "good", "## A\n" + _quote("a.ts", "a()"))
    _note(root, "bad", "## A\n" + _quote("a.ts", "b()"))
    for i in range(10):
        _note(root, f"n{i:02d}", "## A\nplain\n")
    text = session_status(root)
    assert "context/bad — 1/1 quotes failing" in text and "context/good — 1/1 quotes ok" in text, text
    assert "context/n00 — no quotes" in text and "+2 more" in text, text


TESTS = [v for k, v in sorted(globals().items()) if k.startswith("t_")]


def run_tests():
    import shutil
    failed = []
    for test in TESTS:
        root = _repo()
        try:
            test(root)
            print(f"PASS {test.__name__}")
        except Exception as e:  # noqa: BLE001 — report every case, keep going
            failed.append(test.__name__)
            print(f"FAIL {test.__name__}: {type(e).__name__}: {e}")
        finally:
            shutil.rmtree(root, ignore_errors=True)
    print(f"{len(TESTS) - len(failed)}/{len(TESTS)} passed")
    return 1 if failed else 0


# ---------- CLI ----------

def _emit(text):
    sys.stdout.buffer.write(text.encode("utf-8"))


def main(argv=None):
    parser = argparse.ArgumentParser(prog="wisci.py", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", help="project root (default: git toplevel of the current directory)")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("scan")
    for name in ("load", "check"):
        sub.add_parser(name).add_argument("file")
    nw = sub.add_parser("new")
    nw.add_argument("kind", choices=KINDS)
    nw.add_argument("slug")
    sub.add_parser("session-status")
    sub.add_parser("test")
    args = parser.parse_args(argv)
    if args.cmd == "test":
        return run_tests()
    root = os.path.realpath(args.root) if args.root else project_root(os.getcwd())
    try:
        if args.cmd == "scan":
            _emit(json.dumps(scan(root), ensure_ascii=False, separators=(",", ":")) + "\n")
        elif args.cmd == "load":
            _emit(render_load(root, args.file))
        elif args.cmd == "check":
            _emit(render_check(root, args.file))
        elif args.cmd == "new":
            _emit(new_file(root, args.kind, args.slug) + "\n")
        elif args.cmd == "session-status":
            text = session_status(root)
            if text:
                _emit(text + "\n")
    except WisciError as e:
        print(f"wisci: {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
