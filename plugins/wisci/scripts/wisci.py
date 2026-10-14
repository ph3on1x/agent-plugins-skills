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
  session-status              store summary for the SessionStart hook; after a compaction (event on stdin)
                              also this session's handoff records, verbatim
  precompact                  summary-as-handoff instructions for the summarizer, PreCompact event on stdin
  postcompact                 merge the summary's handoff blocks into their leaves, PostCompact event on stdin
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


def handoff_problems(root, rel):
    """Frontmatter a handoff leaf needs: a known status and a goal. Caught at write time, so `scan` keeps working."""
    if not rel.startswith(f"{STORE}/handoff/"):
        return []
    fm = parse_frontmatter(_read(root, rel))
    status = fm.get("status") or "active"
    return ([f"frontmatter: status {status!r} not in {STREAM_STATUSES}"] if status not in STREAM_STATUSES else []) + (
        [] if fm.get("goal") else ["frontmatter: goal is empty"])


def render_check(root, rel):
    """Only the problems, one line per failing section, then the evidence count."""
    a = analyze(root, rel)
    lines = handoff_problems(root, a["file"]) + [
        f"{'(top)' if s['id'] == PREAMBLE else s['id']}: " + "; ".join(map(describe, s["failures"]))
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


def session_status(root, event=None):
    """SessionStart hook output: after a compaction, this session's handoff records verbatim; then the store
    summary. Empty when there is nothing stored. A malformed leaf is reported in the output, not raised, so the
    records still reach the model."""
    records = session_records(root, event) if event and event.get("source") == "compact" else ""
    try:
        listing = store_listing(root)
    except WisciError as e:
        listing = f"wisci: {e}"
    return "\n\n".join(part for part in (records, listing) if part)


INJECT_CAP = 8_000  # SessionStart output over 10,000 chars reaches the model only as a file path


def session_records(root, event):
    """Record sections of this session's leaves (its compactions wrote them; else the leaf it loaded or wrote last),
    so a summarizer that dropped or reworded one can't lose it."""
    claims = stream_claims(root, event)
    own = sorted(s for s, rank in claims.items() if rank == OWN)
    parts, size = [], 0
    for slug in own or ([max(claims, key=claims.__getitem__)] if claims else []):
        doc = parse_doc(_read(root, f"{STORE}/handoff/{slug}.md"))
        text = "\n\n".join("\n".join([s["heading"], *_trim(s["lines"])]) for s in doc["sections"] if s["id"] in RECORDS)
        if not text:
            continue
        if size + len(text) > INJECT_CAP:
            text = f"(too long to re-inject; run /select handoff/{slug})"
        part = f"wisci: records of this session's handoff handoff/{slug}, verbatim; they still apply:\n\n{text}"
        parts.append(part)
        size += len(part)
    return "\n\n".join(parts)


def store_listing(root):
    """One line per store file with its evidence status, streams first."""
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


# ---------- compaction ----------

COMPRESS_SKILL = os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "skills", "compress", "SKILL.md")
SPEC_SECTIONS = ("At compaction", "Leaf format", "What to keep")
BLOCK_OPEN, BLOCK_CLOSE = "<wisci-handoff>", "</wisci-handoff>"
BLOCK_RE = re.compile(rf"{BLOCK_OPEN}\s*(---\n.*?){BLOCK_CLOSE}", re.DOTALL)  # a prose mention has no frontmatter
OWN = float("inf")  # stream_claims rank of a leaf this session's compactions wrote
INVALID_ESCAPE_RE = re.compile(r'(?<!\\)((?:\\\\)*)\\(?=[^"\\/bfnrtu])')


def handoff_spec(skill_path):
    """The compress skill's leaf format and keep rules, verbatim, so /compress and compaction share one spec."""
    with open(skill_path, encoding="utf-8") as f:
        sections = {s["id"]: s for s in parse_doc(f.read())["sections"]}
    missing = [sid for sid in SPEC_SECTIONS if sid not in sections]
    if missing:
        raise WisciError(f"{skill_path}: no {', '.join(missing)} section")
    return "\n\n".join("\n".join([sections[sid]["heading"], *sections[sid]["lines"]]).strip() for sid in SPEC_SECTIONS)


def compact_event(raw):
    """A hook event from stdin; tolerates the raw control characters and invalid escapes Claude Code can emit."""
    if not raw.strip():
        raise WisciError("expected the hook event JSON on stdin")
    try:
        return json.loads(raw, strict=False)
    except json.JSONDecodeError:
        return json.loads(INVALID_ESCAPE_RE.sub(r"\1\\\\", raw), strict=False)


# A tool call that loaded or wrote a leaf: a wisci `load` command, or a Read/Write/Edit `file_path`, also inside
# JSON nested in JSON. A leaf only mentioned in prose isn't matched.
LEAF_CALL_RE = re.compile(r'(?:\bload [^"\s\\]*?handoff/|"file_path\\*":\s*\\*"[^"\\]*?/\.wisci/handoff/)'
                          r"([a-z0-9]+(?:-[a-z0-9]+)*)(?:\.md)?(?![\w-])")


def stream_claims(root, event):
    """{slug: rank} for the handoff leaves this session may update: rank is the transcript offset of the last tool
    call that loaded or wrote the leaf, or OWN for a leaf whose `session:` is this session."""
    sid, path = event.get("session_id"), event.get("transcript_path")
    if not sid or not path:
        raise WisciError("the hook event has no session_id or transcript_path")
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            transcript = f.read()
    except FileNotFoundError:  # not written yet: no tool call can have named a leaf
        transcript = ""
    calls = {m.group(1): m.start() for m in LEAF_CALL_RE.finditer(transcript)}
    claims = {}
    for rel in store_files(root):
        if rel.startswith(f"{STORE}/handoff/"):
            slug = store_key(rel).removeprefix("handoff/")
            if parse_frontmatter(_read(root, rel)).get("session") == sid:
                claims[slug] = OWN
            elif slug in calls:
                claims[slug] = calls[slug]
    return claims


def precompact_instructions(root, skill_path, event):
    """PreCompact hook output, appended to the summarizer's instructions: the compress skill's compaction rules,
    verbatim (the skill is the only place they are written), then the time and this session's streams."""
    claims = stream_claims(root, event)
    goals = {s: truncate_goal(parse_frontmatter(_read(root, f"{STORE}/handoff/{s}.md")).get("goal", "")) for s in claims}
    known = "\n".join(f"- {s}: {goals[s]}" for s in sorted(claims, key=claims.__getitem__)) or "- none"
    return (f"{handoff_spec(skill_path)}\n\nTime: {datetime.now().astimezone().strftime('%Y-%m-%d %H:%M')}\n"
            f"This session's streams:\n{known}\n")


RECORDS = ("Constraints", "Decisions", "Tried / Ruled out")


def _trim(lines):
    lines = list(lines)
    while lines and not lines[-1].strip():
        lines.pop()
    return lines


def merge_leaf(old, new):
    """`new`, except that every line of the old leaf's record sections is kept: state is replaced, records only grow.
    A record line the summarizer reworded is kept in both wordings."""
    old_records = {s["id"]: _trim(s["lines"]) for s in parse_doc(old)["sections"] if s["id"] in RECORDS}
    doc = parse_doc(new)
    body = []
    for s in doc["sections"]:
        lines = s["lines"]
        if s["id"] in old_records:
            kept = old_records.pop(s["id"])
            added = [ln for ln in _trim(lines) if ln.strip() and ln.strip() not in {k.strip() for k in kept}]
            lines = kept + added + [""] * (len(lines) - len(_trim(lines)))
        body += ([s["heading"]] if s["heading"] is not None else []) + lines
    for sid in RECORDS:
        if sid in old_records:
            body = _trim(body) + ["", f"## {sid}", *old_records[sid], ""]
    return doc["frontmatter"] + "\n".join(body)


def _is_fork_of(name, slug):
    """Whether `new_file` would have named a collision of `slug` this way."""
    m = re.fullmatch(r"(.+)(-\d+)", name)
    return bool(m) and m.group(1) == slug[:MAX_SLUG - len(m.group(2))].rstrip("-")


def _slugify(goal):
    slug = "-".join(re.findall(r"[a-z0-9]+", goal.lower())[:4])[:MAX_SLUG].strip("-")
    if not slug:
        raise WisciError(f"handoff block: no stream slug and none can be made from goal {goal!r}")
    return slug


def _with_session(body, sid):
    """The block's frontmatter without `stream:`, and with `session:` naming the compacting session."""
    m = FM_RE.match(body)
    if not m:
        raise WisciError("handoff block: no frontmatter")
    keep = [ln for ln in m.group(1).split("\n") if not re.match(r"(?:stream|session)\s*:", ln)]
    return "---\n" + "\n".join([*keep, f"session: {sid}"]) + "\n---\n" + body[m.end():]


def save_compaction_handoffs(root, summary, event):
    """Save every handoff block of the summary and return the leaf paths.

    A block merges (`merge_leaf`) into its stream's leaf only if this session loaded or wrote that leaf
    (`stream_claims`); any other existing slug gets a new leaf (`-2`), which later compactions in this session
    keep updating. A block under a new slug but with the exact goal of a leaf this session claims goes to that
    leaf. A block without `stream:` goes to this session's own leaf, else to a slug made from its goal."""
    sid = event.get("session_id")
    claims = stream_claims(root, event)
    blocks = [m.group(1).strip() + "\n" for m in BLOCK_RE.finditer(summary.replace("\r\n", "\n"))]
    if not blocks:
        raise WisciError("the compaction summary has no handoff block; run /compress to save this stream")
    saved, errors = [], []
    for body in blocks:
        fm = parse_frontmatter(body)
        if fm.get("status") not in STREAM_STATUSES or not fm.get("goal"):
            errors.append(f"needs a goal and a status in {STREAM_STATUSES}")
            continue
        own = sorted(s for s, rank in claims.items() if rank == OWN)
        slug = fm.get("stream") or (own[0] if len(own) == 1 else _slugify(fm["goal"]))
        if not SLUG_RE.match(slug) or len(slug) > MAX_SLUG:
            errors.append(f"stream {slug!r} must match {SLUG_RE.pattern} and be at most {MAX_SLUG} chars")
            continue
        same_goal = [s for s in claims if parse_frontmatter(_read(root, f"{STORE}/handoff/{s}.md")).get("goal") == fm["goal"]]
        target = (slug if slug in claims else same_goal[0] if len(same_goal) == 1
                  else next((s for s in own if _is_fork_of(s, slug)), None))
        rel = f"{STORE}/handoff/{target}.md" if target else new_file(root, "handoff", slug)
        text = _with_session(body, sid)
        if target:
            text = merge_leaf(_read(root, rel), text)
        with open(os.path.join(root, rel), "w", encoding="utf-8") as f:
            f.write(text)
        claims[store_key(rel).removeprefix("handoff/")] = OWN
        saved.append(rel)
    if errors:
        raise WisciError("handoff block: " + "; ".join(errors) + (f" (saved {', '.join(saved)})" if saved else ""))
    return saved


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


# compaction

SKILL = ("# /compress\n\n## Steps\n1. Write the leaf.\n\n## At compaction\n\n- Write only <wisci-handoff> blocks.\n\n"
         "## Leaf format\n\n```markdown\n---\nstatus: active\n---\n\n## Completed\n- x\n```\n\n- **Frontmatter:** rule.\n\n"
         "## What to keep\n\n- Paths.\n")
LEAF = ("---\nstatus: active\nupdated: 2026-10-14 18:46\ngoal: audit data files\nstream: audit-data\n---\n\n"
        "# Handoff: audit\n\n## Next Steps\n1. Read part4.\n")


def _summary(*blocks):
    return "Summary:\n1. Primary Request: add a <wisci-handoff> block.\n" + "".join(
        f"<wisci-handoff>\n{b}</wisci-handoff>\n" for b in blocks)


def t_spec_comes_from_the_compress_skill(root):
    _w(root, "SKILL.md", SKILL)
    spec = handoff_spec(os.path.join(root, "SKILL.md"))
    assert spec.startswith("## At compaction") and spec.index("## Leaf format") < spec.index("## What to keep"), spec
    assert "## Completed" in spec and spec.endswith("- Paths.") and "## Steps" not in spec, spec
    _w(root, "bad.md", "## Leaf format\nx\n")
    assert "At compaction, What to keep" in _raises(handoff_spec, os.path.join(root, "bad.md"))


def t_shipped_compress_skill_has_the_spec(_root):
    if os.path.isfile(COMPRESS_SKILL):  # npx copies ship the script without the plugin layout
        spec = handoff_spec(COMPRESS_SKILL)  # the skill words the rules; the engine parses what they name
        assert "## Completed" in spec and BLOCK_OPEN in spec and BLOCK_CLOSE in spec and "`stream`" in spec, spec[:300]
        assert all(f"## {sid}" in spec for sid in RECORDS), spec[:300]


def _event(root, *rows, sid="s1", **extra):
    """A hook event whose transcript holds the given rows, serialized as Claude Code writes JSONL."""
    lines = [json.dumps(r, separators=(",", ":"), ensure_ascii=False) for r in rows]
    _w(root, "transcript.jsonl", "".join(line + "\n" for line in lines))
    return {"session_id": sid, "transcript_path": os.path.join(root, "transcript.jsonl"), **extra}


def _tool(name, **inputs):
    return {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": name, "input": inputs}]}}


def _leaf(slug, goal="audit data files", body="## Next Steps\n1. Read part4.\n", **fm):
    keys = {"status": "active", "updated": "2026-10-14 18:46", "goal": goal, **fm}
    return "---\n" + "".join(f"{k}: {v}\n" for k, v in keys.items()) + f"---\n\n# Handoff: {slug}\n\n" + body


RECORDS_OLD = ('## Constraints\n- "no new dependencies" (the user, 2026-10-01)\n\n'
               "## Tried / Ruled out\n- nginx limiting → no per-user state\n\n## Completed\n- old work\n")
LOAD = 'uv run --no-config --no-cache --script "/p/scripts/wisci.py" load .wisci/handoff/{}.md'


def t_merge_keeps_records_and_replaces_state(_root):
    new = _leaf("x", goal="new goal", body='## Constraints\n- "no new dependencies" (the user, 2026-10-01)\n'
                '- "ship today" (the user)\n\n## Completed\n- new work\n\n## Next Steps\n1. Deploy.\n')
    merged = merge_leaf(_leaf("x", body=RECORDS_OLD), new)
    assert merged.startswith(_leaf("x", goal="new goal", body="")), merged
    assert merged.count('- "no new dependencies" (the user, 2026-10-01)\n') == 1, merged
    assert '- "ship today" (the user)' in merged and "new work" in merged and "1. Deploy." in merged, merged
    assert "old work" not in merged, merged
    assert "## Tried / Ruled out\n- nginx limiting → no per-user state\n" in merged, merged
    same = _leaf("x", body=RECORDS_OLD)
    assert merge_leaf(same, same) == same


def t_merge_keeps_reworded_records(_root):
    new = _leaf("x", body='## Constraints\n- "no deps" (the user)\n')
    merged = merge_leaf(_leaf("x", body=RECORDS_OLD), new)
    assert '- "no new dependencies" (the user, 2026-10-01)\n- "no deps" (the user)' in merged, merged


def t_ownership_needs_a_tool_call(root):
    for slug in ("auth", "billing", "cache", "docs", "eval"):
        _w(root, f"{STORE}/handoff/{slug}.md", _leaf(slug))
    nested = json.dumps({"command": LOAD.format("cache")})
    event = _event(root, _tool("Bash", command=LOAD.format("auth")),
                   _tool("Write", file_path=f"{root}/.wisci/handoff/billing.md", content="x"),
                   {"type": "progress", "data": json.dumps({"input": nested})},
                   {"type": "assistant", "message": {"content": [{"type": "text", "text": "see .wisci/handoff/docs.md"}]}})
    claims = stream_claims(root, event)
    assert set(claims) == {"auth", "billing", "cache"}, claims
    assert max(claims, key=claims.__getitem__) == "cache", claims
    _w(root, f"{STORE}/handoff/eval.md", _leaf("eval", session="s1"))
    assert max(stream_claims(root, event), key=stream_claims(root, event).__getitem__) == "eval"


def t_compaction_forks_a_stream_it_never_saw(root):
    original = _leaf("auth", body=RECORDS_OLD)
    _w(root, f"{STORE}/handoff/auth.md", original)
    event = _event(root, _tool("Bash", command="ls"))
    assert save_compaction_handoffs(root, _summary(_leaf("auth", stream="auth")), event) == [f"{STORE}/handoff/auth-2.md"]
    assert _read(root, f"{STORE}/handoff/auth.md") == original
    again = save_compaction_handoffs(root, _summary(_leaf("auth", body="## Next Steps\n1. Later.\n", stream="auth")), event)
    assert again == [f"{STORE}/handoff/auth-2.md"] and "1. Later." in _read(root, again[0])
    assert _read(root, f"{STORE}/handoff/auth.md") == original


def t_compaction_merges_a_loaded_stream(root):
    _w(root, f"{STORE}/handoff/auth.md", _leaf("auth", body=RECORDS_OLD))
    event = _event(root, _tool("Bash", command=LOAD.format("auth")))
    new = _leaf("auth", body='## Constraints\n- "ship today" (the user)\n\n## Completed\n- refresh added\n', stream="auth")
    assert save_compaction_handoffs(root, _summary(new), event) == [f"{STORE}/handoff/auth.md"]
    text = _read(root, f"{STORE}/handoff/auth.md")
    assert '- "no new dependencies" (the user, 2026-10-01)\n- "ship today" (the user)\n' in text, text
    assert "nginx limiting" in text and "refresh added" in text and "old work" not in text, text
    fm = parse_frontmatter(text)
    assert fm["session"] == "s1" and "stream" not in fm, fm


def t_compaction_matches_a_claimed_stream_by_goal(root):
    _w(root, f"{STORE}/handoff/auth-refactor.md", _leaf("auth-refactor", goal="refactor auth middleware", body=RECORDS_OLD))
    event = _event(root, _tool("Bash", command=LOAD.format("auth-refactor")))
    block = _leaf("x", goal="refactor auth middleware", stream="refactor-auth-middleware")
    assert save_compaction_handoffs(root, _summary(block), event) == [f"{STORE}/handoff/auth-refactor.md"]
    assert "nginx limiting" in _read(root, f"{STORE}/handoff/auth-refactor.md")
    _w(root, f"{STORE}/handoff/billing.md", _leaf("billing", goal="bill"))  # same goal, never loaded: no match
    assert save_compaction_handoffs(root, _summary(_leaf("y", goal="bill", stream="billing-runs")), _event(root)) == [
        f"{STORE}/handoff/billing-runs.md"]


def t_postcompact_saves_every_block(root):
    event = _event(root)
    saved = save_compaction_handoffs(root, _summary(_leaf("a", stream="audit-data"), _leaf("b", goal="b", stream="billing")), event)
    assert saved == [f"{STORE}/handoff/audit-data.md", f"{STORE}/handoff/billing.md"], saved
    assert "Read part4" in _read(root, saved[0]) and parse_frontmatter(_read(root, saved[1]))["goal"] == "b"


def t_postcompact_without_stream_uses_the_session_leaf(root):
    event = _event(root)
    first = save_compaction_handoffs(root, _summary(_leaf("a", stream="read-data-chain")), event)
    assert save_compaction_handoffs(root, _summary(_leaf("a")), event) == first
    other = _event(root, sid="s2")
    assert save_compaction_handoffs(root, _summary(_leaf("a", goal="Audit the data files")), other) == [
        f"{STORE}/handoff/audit-the-data-files.md"]


def t_postcompact_rejects_bad_blocks(root):
    event = _event(root)
    for summary in ("Summary: nothing", "<wisci-handoff>\n" + _leaf("a", stream="a"), "see <wisci-handoff>…</wisci-handoff>"):
        assert "no handoff block" in _raises(save_compaction_handoffs, root, summary, event)
    for bad in (_leaf("a", stream="../x"), _leaf("a", stream="a", status="paused"), _leaf("a", goal="", stream="a")):
        _raises(save_compaction_handoffs, root, _summary(bad), event)
    assert not os.path.isdir(os.path.join(root, STORE, "handoff"))
    mixed = _summary(_leaf("b", stream="../x"), _leaf("a", stream="ok"), _leaf("c", stream="a", status="x"))
    msg = _raises(save_compaction_handoffs, root, mixed, event)
    assert "handoff/ok.md" in msg and os.path.isfile(os.path.join(root, STORE, "handoff", "ok.md")), msg
    assert "'../x'" in msg and "status" in msg, msg


def t_precompact_lists_this_sessions_streams(root):
    _w(root, "SKILL.md", SKILL)
    skill = os.path.join(root, "SKILL.md")
    assert "This session's streams:\n- none" in precompact_instructions(root, skill, _event(root))
    _w(root, f"{STORE}/handoff/auth.md", _leaf("auth", goal="refactor auth"))
    _w(root, f"{STORE}/handoff/billing.md", _leaf("billing", goal="billing"))
    _w(root, f"{STORE}/handoff/broken.md", _leaf("broken", status="paused"))
    text = precompact_instructions(root, skill, _event(root, _tool("Bash", command=LOAD.format("auth"))))
    assert text.startswith(handoff_spec(skill) + "\n\nTime: "), text  # every rule comes from the skill
    assert "- auth: refactor auth" in text and "billing" not in text, text


def t_session_status_injects_records_after_compaction(root):
    _w(root, f"{STORE}/handoff/auth.md", _leaf("auth", body=RECORDS_OLD, session="s1"))
    _w(root, f"{STORE}/handoff/other.md", _leaf("other", body='## Constraints\n- "other rule" (the user)\n'))
    text = session_status(root, _event(root, source="compact"))
    assert '- "no new dependencies" (the user, 2026-10-01)' in text and "nginx limiting" in text, text
    assert "old work" not in text and "other rule" not in text and "handoff/auth" in text, text
    assert "no new dependencies" not in session_status(root, _event(root, sid="s2", source="compact"))
    assert "no new dependencies" not in session_status(root, _event(root, source="startup"))
    _w(root, f"{STORE}/handoff/billing.md", _leaf("billing", body='## Decisions\n- invoices monthly\n', session="s1"))
    both = session_status(root, _event(root, source="compact"))
    assert "nginx limiting" in both and "invoices monthly" in both, both
    _w(root, f"{STORE}/handoff/auth.md", _leaf("auth", body="## Constraints\n" + "- x\n" * 5000, session="s1"))
    big = session_status(root, _event(root, source="compact"))
    assert len(big) < 10_000 and "/select handoff/auth" in big, big[:300]


def t_session_status_reports_a_bad_leaf(root):
    _w(root, f"{STORE}/handoff/x.md", "---\nstatus: paused\ngoal: g\n---\n## Next\nplain\n")
    text = session_status(root)
    assert "x.md" in text and "fix its frontmatter" in text, text


def t_check_flags_handoff_frontmatter(root):
    _w(root, f"{STORE}/handoff/x.md", _leaf("x", status="paused"))
    _w(root, f"{STORE}/handoff/y.md", _leaf("y", goal=""))
    assert "status 'paused'" in render_check(root, f"{STORE}/handoff/x.md")
    assert "goal is empty" in render_check(root, f"{STORE}/handoff/y.md")
    assert render_check(root, _note(root, "n", "---\nstatus: whatever\n---\n## A\nplain\n")) == "evidence ok 0/0\n"


def t_compact_event_tolerates_bad_escapes(_root):
    raw = '{"agent_id": null, "compact_summary": "a \\. b \\\\. c\\nd\tline"}'
    assert compact_event(raw)["compact_summary"] == "a \\. b \\. c\nd\tline"
    assert "hook event" in _raises(compact_event, "")


def t_cli_compaction_hooks(root):
    def run(cmd, event):
        return subprocess.run([sys.executable, os.path.abspath(__file__), "--root", root, cmd],
                              input=json.dumps(event) if event is not None else "", capture_output=True, text=True,
                              check=False)
    event = _event(root)
    r = run("postcompact", {**event, "compact_summary": _summary(_leaf("a", stream="audit-data"))})
    assert r.returncode == 0 and "handoff/audit-data.md" in r.stdout and "evidence ok 0/0" in r.stdout, r
    r = run("postcompact", {**event, "compact_summary": "no block"})
    assert r.returncode == 2 and "no handoff block" in r.stderr, r
    r = run("postcompact", {**event, "agent_id": "a1", "compact_summary": "no block"})
    assert r.returncode == 0 and r.stdout == "", r
    r = run("precompact", None)
    assert r.returncode == 2 and "hook event" in r.stderr, r
    r = run("session-status", None)
    assert r.returncode == 0 and "handoff/audit-data" in r.stdout, r
    r = run("session-status", {**event, "source": "compact"})
    assert r.returncode == 0 and "Read part4" not in r.stdout and "handoff/audit-data" in r.stdout, r


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
    sub.add_parser("precompact")
    sub.add_parser("postcompact")
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
            raw = "" if sys.stdin.isatty() else sys.stdin.read()  # the hook pipes its event; a manual run has none
            text = session_status(root, compact_event(raw) if raw.strip() else None)
            if text:
                _emit(text + "\n")
        elif args.cmd == "precompact":
            raw = "" if sys.stdin.isatty() else sys.stdin.read()  # from a terminal: fail fast, don't wait for input
            _emit(precompact_instructions(root, COMPRESS_SKILL, compact_event(raw)))
        elif args.cmd == "postcompact":
            event = compact_event(sys.stdin.read())
            if not event.get("agent_id"):
                for rel in save_compaction_handoffs(root, event.get("compact_summary") or "", event):
                    _emit(f"wisci: saved {rel}\n" + render_check(root, rel))
    except WisciError as e:
        print(f"wisci: {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
