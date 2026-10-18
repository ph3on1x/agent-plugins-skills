# /// script
# requires-python = ">=3.11"
# dependencies = []
# [tool.uv]
# required-version = ">=0.12"
# ///
"""wisci.py — deterministic core for the WISCI context framework (4.x).

Store layout (under the project root):
  .wisci/context/<slug>.md    knowledge notes            (/write)
  .wisci/handoff/<slug>.md    per-stream work state      (/compress, compaction)
  .wisci/.drafts/, .pending/  /compress drafts, compaction markers (gitignored, as is .lock)

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
  draft <slug> [--session ID]   copy a handoff leaf (or an empty one) to a draft for /compress, print its path
  save <draft> [--session ID]   merge the draft into its leaf: new records appended, Constraints verified
                                against the session's transcript, state replaced
  session-status              SessionStart hook: commit compactions, then the store summary; after a compaction
                              (event on stdin) also this session's handoff records, verbatim
  precompact                  PreCompact hook: commit compactions, then the summarizer's handoff instructions
  mark                        PostCompact hook: note where the transcript ends, for `commit`
  stop                        Stop hook: save the main thread's compaction summaries into their leaves
  test                        self-tests

Run: uv run --no-config --no-cache --script wisci.py <command>. Python 3.11+ stdlib only.
"""

import argparse
import fcntl
import glob
import hashlib
import json
import os
import re
import secrets
import subprocess
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timedelta

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
    sid = parse_frontmatter(a["doc"]["frontmatter"]).get("committed-by")
    if sid and SID_RE.match(sid):
        try:
            text += f"> transcript of the session that saved it: {session_transcript(sid)}\n"
        except WisciError:
            pass  # that session's transcript is gone or on another machine
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
    return lifecycle, fm.get("updated", "")[:16], fm.get("goal", "")


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


# ---------- store writes ----------

PRIVATE = (".lock", ".drafts/", ".pending/")


def _ignore_private(root):
    """Keep wisci's lock, drafts and compaction markers out of git, also when the store itself is committed."""
    path = os.path.join(root, STORE, ".gitignore")
    text = _read_text(path) if os.path.isfile(path) else ""
    missing = [p for p in PRIVATE if p not in text.split()]
    if missing:
        with open(path, "a", encoding="utf-8") as f:
            f.write(("\n" if text and not text.endswith("\n") else "") + "".join(p + "\n" for p in missing))


def _read_text(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


@contextmanager
def store_lock(root, timeout=10.0):
    """Serialize every leaf write of the project (hooks, commits and saves of parallel sessions)."""
    os.makedirs(os.path.join(root, STORE), exist_ok=True)
    _ignore_private(root)
    with open(os.path.join(root, STORE, ".lock"), "a") as f:
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() > deadline:
                    raise WisciError(f"{STORE}/.lock is held by another wisci process; try again") from None
                time.sleep(0.05)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def _write_atomic(root, rel, text):
    path = os.path.join(root, rel)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def _with_keys(text, keys):
    """`text` with these frontmatter keys set, or removed where the value is None; other lines keep their order."""
    m = FM_RE.match(text)
    lines = m.group(1).split("\n") if m else []
    kept = [ln for ln in lines if ln[:1] in (" ", "\t", "#") or ln.partition(":")[0].strip() not in keys]
    kept += [f"{k}: {v}" for k, v in keys.items() if v is not None]
    return "---\n" + "\n".join(kept) + "\n---\n" + (text[m.end():] if m else text)


def _stamp(moment):
    return moment.astimezone().isoformat(sep=" ", timespec="seconds")


def _moment(value):
    """An aware datetime from a transcript timestamp or a leaf's `updated` (no zone: local time), else None."""
    try:
        return datetime.fromisoformat(value).astimezone()
    except (TypeError, ValueError):
        return None


# ---------- transcript ----------

def transcript_lines(path, offset=0):
    """(lines, end): the complete JSONL lines of a transcript from byte `offset`, and the byte after the last one.
    A partial last line (still being written) is left for the next read; U+2028 inside a row doesn't split it."""
    with open(path, "rb") as f:
        f.seek(offset)
        data = f.read()
    cut = data.rfind(b"\n") + 1
    return data[:cut].decode("utf-8", errors="replace").split("\n")[:-1], offset + cut


def iter_rows(lines, *needles):
    """(index, row) for the lines holding one of the needles (every line without needles) that are JSON objects."""
    for i, line in enumerate(lines):
        if needles and not any(n in line for n in needles):
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(row, dict):
            yield i, row


def _main(row):
    """Whether a transcript row is the main thread's, not a subagent's."""
    return not row.get("isSidechain") and not row.get("agentId")


def _content(row):
    message = row.get("message")
    return message.get("content") if isinstance(message, dict) else None


def _blocks(row, kind):
    content = _content(row)
    return [b for b in content if isinstance(b, dict) and b.get("type") == kind] if isinstance(content, list) else []


def _text(content):
    if isinstance(content, str):
        return content
    blocks = content if isinstance(content, list) else []
    return "\n".join(b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == "text")


COMMAND_ARGS_RE = re.compile(r"<command-args>(.*?)</command-args>", re.DOTALL)


def _typed(row):
    """A prompt the user typed (`claude -p`: the caller's prompt). Teammate, agent and task messages are user rows
    too, but their `origin` and `turnOrigin` name another sender or none."""
    return (row.get("origin") or {}).get("kind") == "human" or row.get("turnOrigin") in ("human", "sdk")


def user_words(lines):
    """[(text, date, question)]: the user's own words in the main thread. Typed prompts (of a typed slash command,
    its arguments), prompts typed while Claude worked, and AskUserQuestion answers and notes, with their question.
    Skill bodies are meta; tool output is no prompt."""
    words, asked = [], set()
    for _, row in iter_rows(lines, '"human"', '"sdk"', "AskUserQuestion", '"answers"'):
        if not _main(row):
            continue
        kind, date = row.get("type"), (_moment(row.get("timestamp")) or datetime.now().astimezone()).strftime("%Y-%m-%d")
        results = _blocks(row, "tool_result") if kind == "user" else []
        if results:
            result = row.get("toolUseResult")
            answered = any(b.get("tool_use_id") in asked and not b.get("is_error") for b in results)
            answers = result.get("answers") if answered and isinstance(result, dict) else None
            notes = result.get("annotations") if isinstance(result, dict) else None
            for question, answer in (answers if isinstance(answers, dict) else {}).items():
                note = (notes or {}).get(question) if isinstance(notes, dict) else None
                words.append((str(answer), date, question))
                if isinstance(note, dict) and note.get("notes"):
                    words.append((str(note["notes"]), date, question))
        elif kind == "user" and _typed(row) and not row.get("isMeta") and not row.get("isCompactSummary"):
            text = _text(_content(row))
            words.append(("\n".join(COMMAND_ARGS_RE.findall(text)) if "<command-name>" in text else text, date, None))
        elif kind == "attachment":
            queued = row.get("attachment") or {}
            if queued.get("type") == "queued_command" and (queued.get("origin") or {}).get("kind") == "human":
                words.append((_text(queued.get("prompt")), date, None))
        elif kind == "assistant":
            asked |= {b.get("id") for b in _blocks(row, "tool_use") if b.get("name") == "AskUserQuestion"}
    return [w for w in words if w[0].strip()]


QUOTES = str.maketrans({"“": '"', "”": '"', "„": '"', "‘": "'", "’": "'"})
NEGATIONS = {"no", "not", "never", "nor", "without", "avoid", "stop", "dont", "cannot"}
MIN_QUOTE_WORDS, MIN_QUOTE_CHARS = 3, 15


def _norm(text):
    return " ".join(text.translate(QUOTES).casefold().split())


def _span_re(quote):
    """The words of `quote` in order as whole words: any whitespace between them, any quote style, any case."""
    words = [re.escape(w).replace('"', '["“”„]').replace("'", "['‘’]")
             for w in quote.translate(QUOTES).split()]
    return re.compile(r"(?<!\w)" + r"\s+".join(words) + r"(?!\w)", re.IGNORECASE)


def _negated(text, start):
    before = [w.translate(QUOTES).strip(".,;:!?\"'()").casefold() for w in text[:start].split()[-2:]]
    return any(w in NEGATIONS or w.endswith("n't") for w in before)


def _clip(text, limit=100):
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit - 1].rstrip() + "…"


def verify_quote(quote, words):
    """(exact words, provenance) from the latest of the user's words (`user_words`) that holds `quote`, else None:
    a short answer label like "Yes (Recommended)" most likely means the newest question it answered.

    The quote must be whole words, MIN_QUOTE_WORDS words or MIN_QUOTE_CHARS characters unless it is a whole answer,
    and must not follow a negation it left out ("do not deploy to prod" quoted as "deploy to prod")."""
    quote = " ".join(quote.split())
    if not quote:
        return None
    short = len(quote.split()) < MIN_QUOTE_WORDS and len(quote) < MIN_QUOTE_CHARS
    pattern = _span_re(quote)
    for text, date, asked in reversed(words):
        m = pattern.search(text)
        if not m or _negated(text, m.start()) or (short and (asked is None or _norm(m.group(0)) != _norm(text))):
            continue
        exact = " ".join(m.group(0).split())
        return exact, f'(answer to "{_clip(asked)}", {date})' if asked is not None else f"({date})"
    return None


# ---------- records ----------

RECORDS = ("Constraints", "Decisions", "Tried / Ruled out")
BULLET_RE = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+")
PROVENANCE_RE = re.compile(r'\s*\((?:the user\b[^()]*|answer to ".*"[^()]*|\d{4}-\d\d-\d\d)\)\s*$')
QUOTED_RE = re.compile(r'^\s*[-*+]\s+["“](.*)["”]')
ANSWER_RE = re.compile(r'\(answer to "(.*)", [^()]*\)\s*$')


def _trim(lines):
    lines = list(lines)
    while lines and not lines[-1].strip():
        lines.pop()
    return lines


def record_items(lines):
    """The items of a record section: a line at the margin starts one, an indented line continues it."""
    items = []
    for line in lines:
        if line.strip():
            if items and line[:1] in (" ", "\t"):
                items[-1].append(line)
            else:
                items.append([line])
    return items


def constraint_quote(line):
    """The quoted words of a Constraint line (`- "words"`, with or without provenance after them), else None."""
    m = QUOTED_RE.match(PROVENANCE_RE.sub("", line))
    return m.group(1) if m else None


def _quote_key(quote):
    return _norm(quote).rstrip(".;,:!")


def item_key(section, item):
    """What makes two record items the same: a Constraint's quoted words (and, for an answer, its question), else the
    item's text, normalized."""
    quote = constraint_quote(item[0]) if section == "Constraints" else None
    if quote is None:
        return _quote_key(BULLET_RE.sub("", "\n".join(item)))
    m = ANSWER_RE.search(item[0])
    return _quote_key(quote) + (f"\x00{_question_key(m.group(1))}" if m else "")


def _question_key(question):
    """A question as provenance shows it: clipped, so a full question and its clipped copy are the same."""
    return _norm(_clip(question))


def _assemble(doc, records):
    """The document with each record section's lines replaced by `records`: an empty one is left out, a missing one
    goes after the record sections before it, and a repeated heading keeps only its first section."""
    out, done = [], set()
    for s in doc["sections"]:
        if s["id"] in RECORDS:
            if s["id"] in done or not records[s["id"]]:
                continue
            done.add(s["id"])
            s = {**s, "lines": records[s["id"]] + [""] * max(len(s["lines"]) - len(_trim(s["lines"])), 1)}
        out.append(s)
    for k, sid in enumerate(RECORDS):
        if sid not in done and records[sid]:
            ids = [s["id"] for s in out]
            before = [ids.index(r) for r in RECORDS[:k] if r in ids]
            out.insert(before[-1] + 1 if before else 1, {"id": sid, "heading": f"## {sid}", "lines": [*records[sid], ""]})
    return doc["frontmatter"] + "\n".join(ln for s in out for ln in ([s["heading"]] if s["heading"] else []) + s["lines"])


def _span(item):
    """A Constraint's quoted words and, for an answer, its question, normalized."""
    m = ANSWER_RE.search(item[0])
    return _norm(constraint_quote(item[0]) or ""), _question_key(m.group(1)) if m else None


def _within_another(span, spans):
    """Whether the words of `span` occur, as whole words, inside a longer one of `spans` with the same question: the
    same words answering another question are another Constraint."""
    words, question = span
    pattern = re.compile(rf"(?<!\w){re.escape(words)}(?!\w)")
    return bool(words) and any(q == question and other != words and pattern.search(other) for other, q in spans)


def merge_leaf(old, new, words, keep_state=False):
    """(leaf, left out): every record line of the old leaf byte for byte, then the new leaf's record items that are
    not there yet; a new Constraint only as the user's exact words plus provenance (`verify_quote`; with `words`
    None, as written), and not when its words lie within another Constraint's. The other sections and the
    frontmatter are the new leaf's, or the old one's if `keep_state`."""
    old_doc, new_doc = (parse_doc(old) if old else None), parse_doc(new)
    saved = {s["id"]: _trim(s["lines"]) for s in old_doc["sections"] if s["id"] in RECORDS} if old_doc else {}
    proposed = {}
    for s in new_doc["sections"]:
        if s["id"] in RECORDS:
            proposed.setdefault(s["id"], []).extend(s["lines"])
    records, left_out = {}, []
    for sid in RECORDS:
        kept = saved.get(sid, [])
        seen, added = {item_key(sid, item) for item in record_items(kept)}, []
        quoted = [(q, item) for item in record_items(kept) if (q := constraint_quote(item[0])) is not None]
        quotes = {_quote_key(q) for q, _ in quoted}
        plain = {_quote_key(q) for q, item in quoted if not ANSWER_RE.search(item[0])}  # typed, or a legacy line
        for item in record_items(proposed.get(sid, [])):
            if item_key(sid, item) in seen:
                continue
            quote = constraint_quote(item[0]) if sid == "Constraints" else None
            if sid == "Constraints" and words is not None:
                found = verify_quote(quote, words) if quote is not None else None
                if not found:
                    if quote is None or _quote_key(quote) not in quotes:  # a saved quote repeated is no news
                        left_out.append(item[0].strip())
                    continue
                item = [f'- "{found[0]}" {found[1]}']
                if item_key(sid, item) in seen or _quote_key(found[0]) in plain:
                    continue
            elif quote is not None and not ANSWER_RE.search(item[0]) and _quote_key(quote) in quotes:
                continue
            seen.add(item_key(sid, item))
            added.append(item)
        if sid == "Constraints":
            spans = [_span(item) for item in record_items(kept) + added]
            added = [item for item in added if not _within_another(_span(item), spans)]
        records[sid] = kept + [line for item in added for line in item]
    return _assemble(old_doc if keep_state and old_doc else new_doc, records), left_out


def records_digest(root, slugs, cap):
    """The saved records of these streams, a `done` one left out, the whole output within `cap` characters. Each
    stream gets its need or an even share of what is left, whichever is smaller, smallest need first, so one big leaf
    can't crowd out the others. Within a stream the newest Constraints, then the newest Decisions and Tried lines, are
    taken while they fit (one too big is passed over) and shown in their saved order; the rest is counted, with the
    leaf's path."""
    streams = []
    for slug in slugs:
        rel = f"{STORE}/handoff/{slug}.md"
        text = _read(root, rel)
        sections = {s["id"]: record_items(_trim(s["lines"])) for s in parse_doc(text)["sections"] if s["id"] in RECORDS}
        if parse_frontmatter(text).get("status") == "done" or not any(sections.values()):
            continue
        order = [("Constraints", k) for k in reversed(range(len(sections.get("Constraints", []))))]
        decisions, tried = sections.get("Decisions", []), sections.get("Tried / Ruled out", [])
        for k in range(max(len(decisions), len(tried))):
            order += [(sid, len(items) - 1 - k) for sid, items in (("Decisions", decisions), ("Tried / Ruled out", tried))
                      if k < len(items)]
        lines = sum(len(item) for items in sections.values() for item in items)
        frame = (len(f"handoff/{slug}:") + sum(len(f"\n\n## {sid}") for sid in sections)
                 + len(f"\n\n({lines} more lines in {rel})") + 2)  # everything but the items
        streams.append((slug, rel, sections, [(key, sum(len(ln) + 1 for ln in sections[key[0]][key[1]])) for key in order], frame))
    while streams and sum(st[4] for st in streams) > cap:
        streams.pop()  # the least recent goes first
    budget, left = {}, cap - sum(st[4] for st in streams)
    for n, (slug, _, _, items, _) in enumerate(sorted(streams, key=lambda st: sum(size for _, size in st[3]))):
        budget[slug] = min(sum(size for _, size in items), left // (len(streams) - n))
        left -= budget[slug]
    parts = []
    for slug, rel, sections, items, _ in streams:
        chosen, room = set(), budget[slug]
        for key, size in items:
            if size <= room:
                chosen.add(key)
                room -= size
        shown = ["\n".join([f"## {sid}", *(ln for k, item in enumerate(items) if (sid, k) in chosen for ln in item)])
                 for sid, items in sections.items() if any((sid, k) in chosen for k in range(len(items)))]
        rest = sum(len(item) for sid, items in sections.items() for k, item in enumerate(items) if (sid, k) not in chosen)
        parts.append("\n\n".join([f"handoff/{slug}:", *shown] + ([f"({rest} more lines in {rel})"] if rest else [])))
    return "\n\n".join(parts)


# ---------- compaction ----------

COMPRESS_SKILL = os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "skills", "compress", "SKILL.md")
SPEC_SECTIONS = ("At compaction", "Leaf format", "What to keep")
BLOCK_OPEN, BLOCK_CLOSE = "<wisci-handoff>", "</wisci-handoff>"
BLOCK_RE = re.compile(rf"{BLOCK_OPEN}\s*(---\n.*?){BLOCK_CLOSE}", re.DOTALL)  # a prose mention has no frontmatter
OWN = float("inf")  # stream_claims rank of a leaf this session committed
INVALID_ESCAPE_RE = re.compile(r'(?<!\\)((?:\\\\)*)\\(?=[^"\\/bfnrtu])')
PENDING = f"{STORE}/.pending"
SID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
PRECOMPACT_CAP = 16_000  # PreCompact output has no platform cap; a saved record left out invites a restatement
SESSION_CAP = 9_500  # SessionStart output over 10,000 chars reaches the model only as a file path
INJECT_LABEL = ("wisci: the main session's saved handoff records, verbatim; they still apply. "
                "A subagent follows its own task brief.")


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


def _sid(sid):
    if not SID_RE.match(sid or ""):
        raise WisciError(f"session id {sid!r} is not a Claude Code session id")
    return sid


def _session(event):
    sid, path = event.get("session_id"), event.get("transcript_path")
    if not sid or not path:
        raise WisciError("the hook event has no session_id or transcript_path")
    return _sid(sid), path


def _event_lines(event):
    sid, path = _session(event)
    return sid, transcript_lines(path)[0] if os.path.isfile(path) else []  # not written yet: nothing claimed


WISCI_CALL_RE = re.compile(r'wisci\.py["\']?\s+(?:--root\s+\S+\s+)?(load|draft|save)\s+["\']?([^\s"\';&|]+)')
SLUG = r"[a-z0-9]+(?:-[a-z0-9]+)*"
DRAFT_NAME_RE = re.compile(rf"({SLUG})-[0-9A-Za-z]{{1,8}}\.md")


def _call_slugs(root, block):
    """Slugs of the handoff leaves a tool call reads, writes, or loads, drafts or saves through wisci."""
    args, name = block.get("input") or {}, block.get("name")
    if name in ("Read", "Write", "Edit") and isinstance(args.get("file_path"), str):
        path = os.path.join(root, args["file_path"])
        handoff = os.path.realpath(os.path.join(root, STORE, "handoff"))
        return [os.path.basename(path)[:-3]] if path.endswith(".md") and os.path.realpath(os.path.dirname(path)) == handoff else []
    if name != "Bash" or not isinstance(args.get("command"), str):
        return []
    patterns = {"load": rf"(?:.*/)?handoff/({SLUG})(?:\.md)?", "draft": f"({SLUG})", "save": rf"(?:.*/)?{DRAFT_NAME_RE.pattern}"}
    found = (re.fullmatch(patterns[verb], arg) for verb, arg in WISCI_CALL_RE.findall(args["command"]))
    return [m.group(1) for m in found if m]


def stream_claims(root, sid, lines):
    """{slug: rank} of the handoff leaves session `sid` may update: those its main thread read, wrote, loaded,
    drafted or saved with a tool call that succeeded (rank: the line of the result), and those it committed
    (`committed-by`, rank OWN). A failed call, a subagent's call and a leaf named only in text claim nothing."""
    calls = {}
    for _, row in iter_rows(lines, "handoff/", ".drafts/", "wisci.py"):
        if row.get("type") == "assistant" and _main(row):
            for block in _blocks(row, "tool_use"):
                slugs = _call_slugs(root, block)
                if slugs and block.get("id"):
                    calls[block["id"]] = slugs
    claims = {}
    for i, row in iter_rows(lines, *calls) if calls else ():
        if row.get("type") == "user" and _main(row):
            for block in _blocks(row, "tool_result"):
                if block.get("tool_use_id") in calls and not block.get("is_error"):
                    claims.update(dict.fromkeys(calls[block["tool_use_id"]], i))
    leaves = {store_key(rel).removeprefix("handoff/"): rel for rel in store_files(root) if rel.startswith(f"{STORE}/handoff/")}
    claims = {slug: rank for slug, rank in claims.items() if slug in leaves}
    claims.update({slug: OWN for slug, rel in leaves.items() if parse_frontmatter(_read(root, rel)).get("committed-by") == sid})
    return claims


def _by_recency(claims):
    return sorted(claims, key=claims.__getitem__, reverse=True)


def precompact_instructions(root, skill_path, event):
    """PreCompact hook output, appended to the summarizer's instructions: this session's saved records and streams,
    then the compress skill's compaction rules, verbatim (the skill is the only place they are written). The rules
    come last: with the records after them, Haiku fell back to the stock summary 8 times in 20; with the
    records first, 1 in 20."""
    sid, lines = _event_lines(event)
    slugs = _by_recency(stream_claims(root, sid, lines))
    known = "\n".join(f"- {s}: {truncate_goal(parse_frontmatter(_read(root, f'{STORE}/handoff/{s}.md')).get('goal', ''))}"
                      for s in slugs) or "- none"
    saved = records_digest(root, slugs, PRECOMPACT_CAP)
    return ((f"Already saved; wisci keeps these lines, so never repeat or reword them:\n\n{saved}\n\n" if saved else "")
            + f"This session's streams:\n{known}\n\n{handoff_spec(skill_path)}\n")


def session_records(root, event, cap):
    """After a compaction: the saved records of every stream this session claims, so none is lost to the summary."""
    sid, lines = _event_lines(event)
    digest = records_digest(root, _by_recency(stream_claims(root, sid, lines)), cap - len(INJECT_LABEL) - 2)
    return f"{INJECT_LABEL}\n\n{digest}" if digest else ""


def session_status(root, event=None):
    """SessionStart hook output: compaction problems, after a compaction this session's records, then the store
    summary. Empty when there is nothing to say. A malformed leaf is reported, not raised."""
    try:
        problems = commit(root)[1]
    except WisciError as e:
        problems = [str(e)]
    try:
        listing = store_listing(root)
    except WisciError as e:
        listing = f"wisci: {e}"
    notes = "\n".join(f"wisci: {p}" for p in problems)
    records = (session_records(root, event, SESSION_CAP - len(listing) - len(notes))
               if event and event.get("source") == "compact" else "")
    return "\n\n".join(part for part in (records, notes, listing) if part)


def mark(root, event):
    """PostCompact: note where the transcript ends. A main-thread compaction appends its summary row after its
    hooks return; a subagent's fires the same hooks with the main transcript and adds no summary row to it."""
    sid, path = _session(event)
    offset = os.path.getsize(path) if os.path.isfile(path) else 0
    os.makedirs(os.path.join(root, PENDING), exist_ok=True)
    _ignore_private(root)
    rel = f"{PENDING}/{sid}-{time.time_ns()}.json"
    at = datetime.now().astimezone().isoformat()
    _write_atomic(root, rel, json.dumps({"session_id": sid, "transcript_path": path, "offset": offset, "at": at}))
    return rel


def commit(root):
    """Resolve the project's compaction markers (`mark`): a main-thread summary row after one is saved
    (`commit_summary`); one the main thread moved past without a summary was a subagent's compaction and is
    dropped; one with nothing decisive after it yet stays. Returns (saved paths, problems)."""
    folder = os.path.join(root, PENDING)
    if not os.path.isdir(folder) or not any(n.endswith(".json") for n in os.listdir(folder)):
        return [], []
    saved, problems, summaries = [], [], set()
    with store_lock(root):
        for name in sorted(n for n in os.listdir(folder) if n.endswith(".json")):
            with open(os.path.join(folder, name), encoding="utf-8") as f:
                marker = json.load(f)
            if _resolve(root, marker, saved, problems, summaries):
                os.remove(os.path.join(folder, name))
    return list(dict.fromkeys(saved)), problems


def _resolve(root, marker, saved, problems, summaries):
    """Whether the marker is settled; a main-thread summary after it is saved into `saved` and `problems`, once:
    a subagent's marker still pending when the main thread compacted finds the same summary (`summaries`). A row
    stamped before the marker was still being written when the hook ran, so it settles nothing."""
    path, offset, sid, at = marker["transcript_path"], marker["offset"], marker["session_id"], datetime.fromisoformat(marker["at"])
    if not os.path.isfile(path) or os.path.getsize(path) < offset:
        problems.append(f"transcript {path} is gone or was replaced; a compaction of session {sid} was not saved")
        return True
    boundary = None
    for _, row in iter_rows(transcript_lines(path, offset)[0]):
        if not _main(row):
            continue
        if row.get("isCompactSummary"):
            if row.get("uuid") in summaries:
                return True
            summaries.add(row.get("uuid"))
            s, p = commit_summary(root, path, sid, row, boundary)
            saved += s
            problems += p
            return True
        if row.get("type") == "system" and row.get("subtype") == "compact_boundary":
            boundary = row
        elif boundary is None and row.get("type") in ("user", "assistant") and (_moment(row.get("timestamp")) or at) > at:
            return True
    return False


STALE_AFTER = timedelta(minutes=15)


def _clock(moment, ref):
    """Local time of `moment`, with its date when that isn't `ref`'s (today)."""
    local = moment.astimezone()
    return local.strftime("%H:%M" if local.date() == ref.astimezone().date() else "%Y-%m-%d %H:%M")


def _lag(delta):
    minutes = int(delta.total_seconds() // 60)
    days, hours, mins = minutes // 1440, minutes // 60 % 24, minutes % 60
    return " ".join(f"{n} {unit}" for n, unit in ((days, "d"), (hours, "h"), (mins, "min")) if n) or "0 min"


def _row_index(lines, uuid, end=None):
    return next((i for i, row in iter_rows(lines[:end], uuid) if row.get("uuid") == uuid), None) if uuid else None


def commit_summary(root, path, sid, summary, boundary):
    """Save a main-thread compaction summary's handoff blocks. Its as-of is the first row the summary didn't cover
    (`preservedSegment.headUuid`; else the summary row's own time). Ownership and Constraints count only rows
    before it: the summarizer saw nothing after."""
    lines = transcript_lines(path)[0]
    end = _row_index(lines, summary.get("uuid"))
    head_uuid = (((boundary or {}).get("compactMetadata") or {}).get("preservedSegment") or {}).get("headUuid")
    head = _row_index(lines, head_uuid, end)
    as_of = ((_moment(json.loads(lines[head]).get("timestamp")) if head is not None else None)
             or _moment(summary.get("timestamp")) or datetime.now().astimezone())
    cut = lines[:head if head is not None else end]
    applied = _moment((boundary or {}).get("timestamp"))
    return save_blocks(root, _text(_content(summary)), sid, as_of, stream_claims(root, sid, cut), user_words(cut), applied)


def _is_fork_of(name, slug):
    """Whether `new_file` would have named a collision of `slug` this way."""
    m = re.fullmatch(r"(.+)(-\d+)", name)
    return bool(m) and m.group(1) == slug[:MAX_SLUG - len(m.group(2))].rstrip("-")


def _slugify(goal):
    slug = "-".join(re.findall(r"[a-z0-9]+", goal.lower())[:4])[:MAX_SLUG].strip("-")
    if not slug:
        raise WisciError(f"handoff block: no stream slug and none can be made from goal {goal!r}")
    return slug


def save_blocks(root, summary, sid, as_of, claims, words, applied=None):
    """Save every handoff block of a compaction summary; (saved paths, problems).

    A block merges (`merge_leaf`) into its stream's leaf only if this session claims it (`stream_claims`); any
    other existing slug gets a new leaf (`-2`), which later compactions in this session keep updating. A block
    under a new slug but with the exact goal of a leaf this session claims goes to that leaf. A block without
    `stream:` goes to this session's own leaf, else to a slug made from its goal. A leaf updated after `as_of`
    keeps its state and frontmatter and gains only the block's new records; within one second the leaf wins. A
    saved state older than the compaction (`applied`) by STALE_AFTER or more is named in the problems."""
    blocks = [m.group(1).strip() + "\n" for m in BLOCK_RE.finditer(summary.replace("\r\n", "\n"))]
    if not blocks:
        return [], ["the compaction summary has no handoff block; run /compress to save this stream"]
    saved, problems = [], []
    for body in blocks:
        fm = parse_frontmatter(body)
        if fm.get("status") not in STREAM_STATUSES or not fm.get("goal"):
            problems.append(f"handoff block: needs a goal and a status in {STREAM_STATUSES}")
            continue
        own = sorted(s for s, rank in claims.items() if rank == OWN)
        slug = fm.get("stream") or (own[0] if len(own) == 1 else _slugify(fm["goal"]))
        if not SLUG_RE.match(slug) or len(slug) > MAX_SLUG:
            problems.append(f"handoff block: stream {slug!r} must match {SLUG_RE.pattern} and be at most {MAX_SLUG} chars")
            continue
        same_goal = [s for s in claims if parse_frontmatter(_read(root, f"{STORE}/handoff/{s}.md")).get("goal") == fm["goal"]]
        target = (slug if slug in claims else same_goal[0] if len(same_goal) == 1
                  else next((s for s in own if _is_fork_of(s, slug)), None))
        rel = f"{STORE}/handoff/{target}.md" if target else new_file(root, "handoff", slug)
        old = _read(root, rel) if target else None
        newer = _moment(parse_frontmatter(old).get("updated")) if old else None
        keep = newer is not None and newer >= as_of.replace(microsecond=0)
        text, left_out = merge_leaf(old, body, words, keep_state=keep)
        keys = {"stream": None, "session": None, "committed-by": sid}
        _write_atomic(root, rel, _with_keys(text, keys if keep else {**keys, "updated": _stamp(as_of)}))
        slug_saved = store_key(rel).removeprefix("handoff/")
        claims[slug_saved] = OWN
        saved.append(rel)
        state_as_of, today = newer if keep else as_of, datetime.now().astimezone()
        if applied is not None and applied - state_as_of >= STALE_AFTER:
            what = (f"kept its newer state as of {_clock(state_as_of, today)} (this compaction summarized up to "
                    f"{_clock(as_of, today)})" if keep else f"saved state as of {_clock(as_of, today)}")
            when = "" if applied.astimezone().date() == today.date() else f" at {_clock(applied, today)}"
            problems.append(f"{rel}: {what}, {_lag(applied - state_as_of)} before this compaction{when}; "
                            f"/compress {slug_saved} saves the work since")
        if left_out:
            problems.append(f"{rel}: left out Constraints that aren't the user's exact words: {'; '.join(left_out)}")
    return saved, problems


# ---------- /compress drafts ----------

DRAFTS = f"{STORE}/.drafts"


def _digest(root, rel):
    with open(os.path.join(root, rel), "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()[:12]


def draft(root, slug, sid=None):
    """A private copy of a stream's leaf (an empty leaf for a new slug) to edit. The leaf's revision goes to a
    sidecar `.base` file, out of the model's way: a draft rewritten whole loses nothing `save` needs."""
    if not SLUG_RE.match(slug) or len(slug) > MAX_SLUG:
        raise WisciError(f"slug {slug!r} must match {SLUG_RE.pattern} and be at most {MAX_SLUG} chars")
    if sid is not None:
        _sid(sid)
    leaf = os.path.join(root, STORE, "handoff", f"{slug}.md")
    data = None
    if os.path.isfile(leaf):
        with open(leaf, "rb") as f:
            data = f.read()  # one read: the copy and its base are the same revision
    text = (data.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n").removeprefix("\ufeff") if data is not None
            else "---\nstatus: active\ngoal: \n---\n")
    os.makedirs(os.path.join(root, DRAFTS), exist_ok=True)
    _ignore_private(root)
    rel = f"{DRAFTS}/{slug}-{(re.sub(r'[^0-9A-Za-z]', '', sid or '') or secrets.token_hex(4))[:8]}.md"
    _write_atomic(root, rel, text)
    _write_atomic(root, rel[:-3] + ".base", hashlib.sha256(data).hexdigest()[:12] if data is not None else "new")
    return rel


def session_transcript(sid):
    config = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    found = glob.glob(os.path.join(glob.escape(config), "projects", "*", f"{sid}.jsonl"))
    if not found:
        raise WisciError(f"no transcript for session {sid} in {config}/projects")
    return found[0]


def save_draft(root, path, sid, words):
    """Save a draft (`draft`) into its leaf; (leaf, left-out Constraints). Refused, the draft kept, when the leaf
    changed since the draft was made or a saved record line was edited or removed. `words` None: Constraints
    aren't verified."""
    rel = os.path.relpath(os.path.abspath(os.path.join(root, path)), root).replace(os.sep, "/")
    m = re.fullmatch(rf"{re.escape(DRAFTS)}/{DRAFT_NAME_RE.pattern}", rel)
    if not m:
        raise WisciError(f"{path}: not a draft (expected {DRAFTS}/<slug>-<id>.md, made by `draft`)")
    leaf, text = f"{STORE}/handoff/{m.group(1)}.md", _read(root, rel)
    with store_lock(root):
        exists = os.path.isfile(os.path.join(root, leaf))
        if not os.path.isfile(os.path.join(root, rel[:-3] + ".base")):
            raise WisciError(f"{path}: no base revision beside it; make the draft with `draft {m.group(1)}`")
        base, now = _read_text(os.path.join(root, rel[:-3] + ".base")), _digest(root, leaf) if exists else "new"
        if base != now:
            raise WisciError(f"{leaf} changed since this draft was made; run `draft {m.group(1)}` again and redo the edits")
        old = _read(root, leaf) if exists else None
        drafted = {s["id"]: {ln.rstrip() for ln in s["lines"]} for s in parse_doc(text)["sections"] if s["id"] in RECORDS}
        gone = [ln for s in (parse_doc(old)["sections"] if old else []) if s["id"] in RECORDS
                for ln in s["lines"] if ln.strip() and ln.rstrip() not in drafted.get(s["id"], set())]
        if gone:
            raise WisciError("saved record lines must stay exactly as they are; restore: " + "; ".join(gone[:5]))
        merged, left_out = merge_leaf(old, text, words)
        merged = _with_keys(merged, {"stream": None, "session": None, "committed-by": sid,
                                     "updated": _stamp(datetime.now())})
        fm = parse_frontmatter(merged)
        if fm.get("status") not in STREAM_STATUSES or not fm.get("goal"):
            raise WisciError(f"{rel}: frontmatter needs a goal and a status in {STREAM_STATUSES}")
        os.makedirs(os.path.join(root, STORE, "handoff"), exist_ok=True)
        _write_atomic(root, leaf, merged)
        os.remove(os.path.join(root, rel))
        os.remove(os.path.join(root, rel[:-3] + ".base"))
    return leaf, left_out


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
TS = "2026-10-16T12:00:00.000Z"
WISCI = 'uv run --no-config --no-cache --script "/p/scripts/wisci.py"'
LOAD = WISCI + " load .wisci/handoff/{}.md"
RECORDS_OLD = ('## Constraints\n- "no new dependencies" (the user, 2026-10-01)\n\n'
               "## Tried / Ruled out\n- nginx limiting → no per-user state\n\n## Completed\n- old work\n")


def _summary(*blocks):
    return "Summary:\n1. Primary Request: add a <wisci-handoff> block.\n" + "".join(
        f"<wisci-handoff>\n{b}</wisci-handoff>\n" for b in blocks)


def _jsonl(rows):
    return "".join(json.dumps(r, separators=(",", ":"), ensure_ascii=False) + "\n" for r in rows)


def _event(root, *rows, sid="s1", **extra):
    """A hook event whose transcript holds the given rows, serialized as Claude Code writes JSONL."""
    _w(root, "transcript.jsonl", _jsonl(rows))
    return {"session_id": sid, "transcript_path": os.path.join(root, "transcript.jsonl"), **extra}


def _add(event, *rows):
    with open(event["transcript_path"], "a", encoding="utf-8") as f:
        f.write(_jsonl(rows))


def _said(text, **row):
    """A prompt the user typed."""
    return {"type": "user", "origin": {"kind": "human"}, "timestamp": TS, "message": {"role": "user", "content": text}, **row}


def _tool(name, tid="t1", **inputs):
    return {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": tid, "name": name, "input": inputs}]}}


def _done(tid="t1", error=False, **row):
    result = {"type": "tool_result", "tool_use_id": tid, "content": "ok", **({"is_error": True} if error else {})}
    return {"type": "user", "timestamp": TS, "message": {"content": [result]}, **row}


def _call(name, tid="t1", **inputs):
    return [_tool(name, tid, **inputs), _done(tid)]


def _asked(tid, answers, notes=None):
    questions = [{"question": q, "options": []} for q in answers]
    return [_tool("AskUserQuestion", tid, questions=questions),
            _done(tid, turnOrigin="human", toolUseResult={"questions": questions, "answers": answers,
                                                          "annotations": notes or {}})]


def _compaction(summary, head=None, ts="2026-10-16T12:30:00.000Z", **row):
    meta = {"preservedSegment": {"headUuid": head}} if head else {}
    return [{"type": "system", "subtype": "compact_boundary", "compactMetadata": meta, **row},
            {"type": "user", "isCompactSummary": True, "uuid": f"sum-{time.time_ns()}", "timestamp": ts,
             "message": {"content": summary}, **row}]


def _compact_summary(root, event, summary, **kw):
    """A main-thread compaction with this summary, committed: (saved, problems)."""
    mark(root, event)
    _add(event, *_compaction(summary, **kw))
    return commit(root)


def _compact(root, event, *blocks, **kw):
    return _compact_summary(root, event, _summary(*blocks), **kw)


def _leaf(slug, goal="audit data files", body="## Next Steps\n1. Read part4.\n", **fm):
    keys = {"status": "active", "updated": "2026-10-14 18:46", "goal": goal, **fm}
    return "---\n" + "".join(f"{k}: {v}\n" for k, v in keys.items()) + f"---\n\n# Handoff: {slug}\n\n" + body


def _pending(root):
    folder = os.path.join(root, PENDING)
    return sorted(os.listdir(folder)) if os.path.isdir(folder) else []


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


# transcript

def t_transcript_reads_whole_lines_from_an_offset(root):
    event = _event(root, _said("one"), _said("two still two"))
    lines, end = transcript_lines(event["transcript_path"])
    assert len(lines) == 2 and end == os.path.getsize(event["transcript_path"]), lines
    with open(event["transcript_path"], "a", encoding="utf-8") as f:
        f.write('{"type":"user","mess')
    assert transcript_lines(event["transcript_path"], end) == ([], end)
    with open(event["transcript_path"], "a", encoding="utf-8") as f:
        f.write('age":{}}\nnot json\n')
    lines, _ = transcript_lines(event["transcript_path"], end)
    assert [row for _, row in iter_rows(lines)] == [{"type": "user", "message": {}}], lines


def t_user_words_are_only_the_users(root):
    queued = {"type": "attachment", "timestamp": TS, "attachment": {
        "type": "queued_command", "prompt": "also keep the tests green", "origin": {"kind": "human"}}}
    peer = {"type": "attachment", "timestamp": TS, "attachment": {
        "type": "queued_command", "prompt": "deploy now", "origin": {"kind": "peer", "from": "builder"}}}
    command = "<command-message>wisci:select</command-message>\n<command-name>/wisci:select</command-name>\n"
    event = _event(
        root, _said("Never use the claude API"), _said(command + "<command-args>handoff/auth please</command-args>"),
        _said(command), queued, peer,
        {"type": "user", "turnOrigin": "sdk", "timestamp": TS, "message": {"content": "a claude -p prompt"}},
        {"type": "user", "timestamp": TS, "message": {"content": "<teammate-message>ship it</teammate-message>"}},
        {"type": "user", "origin": {"kind": "peer"}, "turnOrigin": "peer", "message": {"content": "<agent-message>"}},
        {"type": "user", "origin": {"kind": "task-notification"}, "message": {"content": "<task-notification>x"}},
        _said("Base directory for this skill", isMeta=True), _said("sidechain words", isSidechain=True),
        _said("agent words", agentId="a1"), _said("Summary: old", isCompactSummary=True),
        *_asked("q1", {"Which store?": "Redis (Recommended)", "Scope?": "auth only"}, {"Scope?": {"notes": "keep billing"}}),
        _tool("AskUserQuestion", "q2"), _done("q2", error=True, toolUseResult={"answers": {"X?": "refused"}}),
        _done("q3", toolUseResult={"answers": {"Y?": "not from AskUserQuestion"}}))
    words = user_words(transcript_lines(event["transcript_path"])[0])
    assert [(t, q) for t, _, q in words] == [
        ("Never use the claude API", None), ("handoff/auth please", None), ("also keep the tests green", None),
        ("a claude -p prompt", None),
        ("Redis (Recommended)", "Which store?"), ("auth only", "Scope?"), ("keep billing", "Scope?")], words
    assert {d for _, d, _ in words} == {datetime.fromisoformat(TS).astimezone().strftime("%Y-%m-%d")}


def t_constraints_must_be_the_users_exact_words(_root):
    words = [("Please, Do NOT deploy to “prod” before Friday.\nAlso keep\n  the tests green", "2026-10-16", None),
             ("Redis (Recommended)", "2026-10-16", "Which store backs sessions?"), ("Yes", "2026-10-16", "Ship?")]
    assert verify_quote('do not deploy to "prod"', words) == ("Do NOT deploy to “prod”", "(2026-10-16)")
    assert verify_quote("keep the tests green", words) == ("keep the tests green", "(2026-10-16)")
    assert verify_quote('deploy to "prod" before Friday', words) is None  # the negation was left out
    assert verify_quote("don't deploy to prod", words) is None  # a paraphrase
    assert verify_quote("tests gree", words) is None  # not whole words
    assert verify_quote("deploy", [("do not deploy", "2026-10-16", None)]) is None  # too short to mean anything
    assert verify_quote("Redis", words) is None  # part of an answer
    assert verify_quote("Redis (Recommended)", words) == ("Redis (Recommended)", '(answer to "Which store backs sessions?", 2026-10-16)')
    assert verify_quote("yes", words) == ("Yes", '(answer to "Ship?", 2026-10-16)')  # a whole answer, however short


# records

WORDS = [("no new dependencies, ship today and keep it simple", "2026-10-16", None)]


def t_merge_appends_only_new_records(_root):
    new = _leaf("x", goal="new goal", body=(
        '## Constraints\n- "No new dependencies" (2026-10-16)\n- "keep it simple"\n- "ship today and keep it simple" — the deadline\n'
        '- "no new dependencies, ship"\n'
        '- "ship by friday"\n\n## Decisions\n- use Redis — shared\n  across pods\n\n'
        "## Tried / Ruled out\n- Nginx limiting → no per-user state.\n\n## Completed\n- new work\n\n## Next Steps\n1. Deploy.\n"))
    merged, left_out = merge_leaf(_leaf("x", body=RECORDS_OLD), new, WORDS)
    assert merged.startswith(_leaf("x", goal="new goal", body="")), merged
    assert ('## Constraints\n- "no new dependencies" (the user, 2026-10-01)\n'  # "keep it simple" lies within
            '- "ship today and keep it simple" (2026-10-16)\n'  # another; a quote that adds words is kept
            '- "no new dependencies, ship" (2026-10-16)\n\n') in merged, merged
    assert left_out == ['- "ship by friday"'], left_out
    assert "## Decisions\n- use Redis — shared\n  across pods\n" in merged, merged
    assert "## Tried / Ruled out\n- nginx limiting → no per-user state\n\n## Completed\n- new work" in merged, merged
    assert "old work" not in merged and "1. Deploy." in merged, merged
    assert merge_leaf(merged, merged, WORDS) == (merged, [])  # a replayed block changes nothing
    kept, _ = merge_leaf(merged, _leaf("x", body="## Decisions\n- cache 60 s\n\n## Completed\n- stale\n"), WORDS, keep_state=True)
    assert kept.startswith(_leaf("x", goal="new goal", body="")) and "new work" in kept and "stale" not in kept, kept
    assert "  across pods\n- cache 60 s\n" in kept, kept


def t_merge_places_new_record_sections(_root):
    merged, _ = merge_leaf(None, _leaf("x", body="## Completed\n- a\n\n## Decisions\n- d\n\n## Decisions\n- e\n"), [])
    assert merged.count("## Decisions") == 1 and "## Decisions\n- d\n- e\n" in merged, merged
    merged, _ = merge_leaf(_leaf("x", body="## Tried / Ruled out\n- t\n"), _leaf("x", body="## Next Steps\n1. n\n"), [])
    assert merged.endswith("# Handoff: x\n\n## Tried / Ruled out\n- t\n\n## Next Steps\n1. n\n"), merged
    merged, _ = merge_leaf(None, _leaf("x", body='## Constraints\n- "made up"\n\n## Completed\n- a\n'), [])
    assert "## Constraints" not in merged, merged


def t_records_digest_shares_one_budget(root):
    _w(root, f"{STORE}/handoff/a.md", _leaf("a", body="## Constraints\n" + "".join(f'- "rule {i}"\n' for i in range(400))
                                                 + "\n## Decisions\n- d0\n- d1\n\n## Completed\n- done\n"))
    _w(root, f"{STORE}/handoff/b.md", _leaf("b", body="## Decisions\n- old\n- new\n\n## Tried / Ruled out\n- t\n"))
    text = records_digest(root, ["a", "b"], 2_000)
    assert len(text) <= 2_000 and '- "rule 399"' in text and '- "rule 0"' not in text and "done" not in text, text
    assert f"more lines in {STORE}/handoff/a.md" in text and "## Decisions\n- old\n- new\n\n## Tried / Ruled out\n- t" in text, text
    assert "1 more lines" not in records_digest(root, ["b"], 2_000)
    assert '- "rule 300"' in text, text  # b needs little, so a gets the rest of the budget
    shown = [int(n) for n in re.findall(r'"rule (\d+)"', text)]
    assert shown == sorted(shown), shown  # taken newest first, shown in their saved order
    _w(root, f"{STORE}/handoff/b.md", _leaf("b", status="done", body="## Decisions\n- old\n"))
    assert "handoff/b" not in records_digest(root, ["a", "b"], 2_000)  # a done stream's records are history
    _w(root, f"{STORE}/handoff/c.md", _leaf("c", body='## Constraints\n- "' + "x" * 2_100 + '"\n\n## Decisions\n- short\n'))
    assert "- short" in records_digest(root, ["c"], 2_000)  # an item too big is passed over, not a stop
    many = [f"s{i}" for i in range(8)]
    for slug in many:
        _w(root, f"{STORE}/handoff/{slug}.md", _leaf(slug, body="## Constraints\n" + "".join(
            f'- "rule {i} of {slug}"\n' for i in range(60)) + "\n## Decisions\n- d\n\n## Tried / Ruled out\n- t\n"))
    assert len(records_digest(root, many, 1_500)) <= 1_500  # headings and pointers count too


# compaction commits

def t_commit_saves_a_main_thread_compaction(root):
    event = _event(root, _said("keep the old API stable please"), *_call("Bash", command="ls"))
    mark(root, event)
    assert commit(root) == ([], []) and len(_pending(root)) == 1  # nothing after the marker yet
    _add(event, *_compaction(_summary(_leaf("a", stream="audit-data", body=(
        '## Constraints\n- "keep the old API stable"\n- "made up rule here"\n\n## Next Steps\n1. Read part4.\n')))))
    saved, problems = commit(root)
    assert saved == [f"{STORE}/handoff/audit-data.md"] and "made up rule here" in problems[0], (saved, problems)
    text = _read(root, saved[0])
    fm = parse_frontmatter(text)
    assert fm["committed-by"] == "s1" and fm["updated"] == _stamp(_moment("2026-10-16T12:30:00.000Z")), fm
    assert "stream" not in fm and '- "keep the old API stable" (' in text and "made up" not in text, text
    assert _pending(root) == [] and commit(root) == ([], [])
    with open(os.path.join(root, STORE, ".gitignore"), encoding="utf-8") as f:
        assert f.read().split() == list(PRIVATE)


def t_commit_drops_a_subagent_marker(root):
    event = _event(root, _said("hello there friend"))
    mark(root, event)
    _add(event, {"type": "attachment", "attachment": {"type": "hook_success"}},
         *_compaction(_summary(_leaf("a", stream="sub")), isSidechain=True), {"type": "system", "subtype": "x"})
    assert commit(root) == ([], []) and len(_pending(root)) == 1  # metadata and subagent rows decide nothing
    _add(event, _said("written before the hook ran", timestamp="2026-10-16T00:00:00.000Z"))
    assert commit(root) == ([], []) and len(_pending(root)) == 1
    _add(event, {"type": "assistant", "timestamp": "2099-01-01T00:00:00.000Z", "message": {"content": []}})
    assert commit(root) == ([], []) and _pending(root) == []  # the main thread went on: a subagent compacted
    assert not os.path.isdir(os.path.join(root, STORE, "handoff"))
    mark(root, event)
    _add(event, {"type": "system", "subtype": "compact_boundary"})
    assert commit(root) == ([], []) and len(_pending(root)) == 1  # a boundary waits for its summary
    _w(root, "transcript.jsonl", "")
    assert "was replaced" in commit(root)[1][0] and _pending(root) == []


def t_commit_resolves_two_markers_once(root):
    event = _event(root)
    mark(root, event)
    mark(root, event)  # a subagent compacted while the main thread did
    _add(event, *_compaction(_summary(_leaf("a", stream="audit-data", body='## Constraints\n- "made up rule here"\n'))))
    saved, problems = commit(root)
    assert saved == [f"{STORE}/handoff/audit-data.md"] and len(problems) == 1 and _pending(root) == [], problems
    assert os.listdir(os.path.join(root, STORE, "handoff")) == ["audit-data.md"]  # one summary, saved and reported once


def t_commit_keeps_newer_state(root):
    _w(root, f"{STORE}/handoff/auth.md", _leaf("auth", body=RECORDS_OLD, updated="2026-10-16 13:00:00+00:00"))
    head = {"type": "assistant", "uuid": "h1", "timestamp": "2026-10-16T11:00:00.000Z", "message": {"content": []}}
    event = _event(root, *_call("Bash", command=LOAD.format("auth")), _said("ship the refresh flow today"), head,
                   *_call("Bash", "t2", command=LOAD.format("tail")))
    _w(root, f"{STORE}/handoff/tail.md", _leaf("tail", goal="tail"))
    stale = _leaf("auth", stream="auth", body='## Constraints\n- "ship the refresh flow today"\n\n## Completed\n- stale\n')
    assert _compact(root, event, stale, _leaf("tail", goal="tail", stream="tail"), head="h1")[0] == [
        f"{STORE}/handoff/auth.md", f"{STORE}/handoff/tail-2.md"]  # calls after the summary's cut claim nothing
    text = _read(root, f"{STORE}/handoff/auth.md")
    assert "stale" not in text and "old work" in text and '- "ship the refresh flow today" (' in text, text
    assert parse_frontmatter(text)["updated"] == "2026-10-16 13:00:00+00:00", text
    _add(event, {**head, "uuid": "h2", "timestamp": "2026-10-16T14:00:00.000Z"})
    _compact(root, event, _leaf("auth", stream="auth", body="## Completed\n- fresh\n"), head="h2")
    text = _read(root, f"{STORE}/handoff/auth.md")
    assert "fresh" in text and "old work" not in text and "ship the refresh flow" in text, text
    assert parse_frontmatter(text)["updated"] == _stamp(_moment("2026-10-16T14:00:00.000Z")), text


def t_commit_same_second_keeps_the_leaf(root):
    _w(root, f"{STORE}/handoff/auth.md", _leaf("auth", body=RECORDS_OLD, updated="2026-10-16 11:00:00+00:00"))
    head = {"type": "assistant", "uuid": "h1", "timestamp": "2026-10-16T11:00:00.600Z", "message": {"content": []}}
    event = _event(root, *_call("Bash", command=LOAD.format("auth")), head)
    _compact(root, event, _leaf("auth", stream="auth", body="## Completed\n- stale\n"), head="h1")
    text = _read(root, f"{STORE}/handoff/auth.md")
    assert "old work" in text and "stale" not in text, text  # a tie within one second goes to the saved leaf


def t_constraints_verify_only_before_the_summarys_cut(root):
    head = {"type": "assistant", "uuid": "h1", "timestamp": TS, "message": {"content": []}}
    event = _event(root, _said("keep the old API stable please"), head, _said("ship the new API on friday"))
    saved, problems = _compact(root, event, _leaf("a", stream="audit-data", body=(
        '## Constraints\n- "keep the old API stable"\n- "ship the new API on friday"\n')), head="h1")
    text = _read(root, saved[0])
    assert '- "keep the old API stable" (' in text and "friday" not in text and "friday" in problems[0], (text, problems)


def t_an_answer_label_goes_to_its_latest_question(root):
    _w(root, f"{STORE}/handoff/auth.md", _leaf("auth", body='## Constraints\n- "Yes (Recommended)" (answer to "Store?", 2026-10-16)\n'))
    event = _event(root, *_call("Bash", command=LOAD.format("auth")), *_asked("q1", {"Store?": "Yes (Recommended)"}),
                   *_asked("q2", {"Ship?": "Yes (Recommended)"}))
    block = _leaf("auth", stream="auth", body='## Constraints\n- "Yes (Recommended)"\n')
    _compact(root, event, block)
    text = _read(root, f"{STORE}/handoff/auth.md")
    assert text.count('"Yes (Recommended)"') == 2 and '(answer to "Ship?", ' in text, text  # another question's answer
    _compact(root, event, block)
    assert _read(root, f"{STORE}/handoff/auth.md").count('"Yes (Recommended)"') == 2  # the same answer again: a repeat
    unverified = merge_leaf(_read(root, f"{STORE}/handoff/auth.md"), block, None)[0]
    assert unverified.count('"Yes (Recommended)"') == 2, unverified  # without a transcript: a saved quote is a repeat


def t_answers_to_different_questions_stay_apart(root):
    old = _leaf("auth", body='## Constraints\n- "Use Redis only" (answer to "Which database?", 2026-10-16)\n'
                              '- "Use the Redis cache" (the user, 2026-10-01)\n')
    words = [("Use Redis only", "2026-10-16", "Which database?"), ("Use Redis", "2026-10-16", "Which cache?"),
             ("Use the Redis cache", "2026-10-16", "Cache?"), ("Yes (Recommended)", "2026-10-16", "Ship on Friday?"),
             ("Yes (Recommended)", "2026-10-16", "Keep the old API?")]
    block = _leaf("auth", body='## Constraints\n- "Use Redis"\n- "Use the Redis cache"\n- "Yes (Recommended)"\n')
    text, left_out = merge_leaf(old, block, words)
    assert '- "Use Redis" (answer to "Which cache?", 2026-10-16)' in text, text  # not "within" another question's answer
    assert text.count("Use the Redis cache") == 1 and left_out == [], (text, left_out)  # the legacy line already says it
    assert '- "Yes (Recommended)" (answer to "Keep the old API?", 2026-10-16)' in text, text  # the latest answer
    long = "Should wisci paste your saved records back after each compaction, knowing helper agents get that block too?"
    full = _leaf("auth", body=f'## Constraints\n- "Paste in (Recommended)" (answer to "{long}", 2026-10-16)\n')
    again = merge_leaf(full, '## Constraints\n- "Paste in (Recommended)"\n', [("Paste in (Recommended)", "2026-10-16", long)])[0]
    assert again.count("Paste in") == 1, again  # its saved question in full, the new one clipped: the same answer
    other = _leaf("auth", body='## Constraints\n- "Use Redis only" (answer to "Which cache?", 2026-10-16)\n- "Use Redis only"\n')
    text = merge_leaf(old, other, None)[0]
    assert text.count('"Use Redis only"') == 2, text  # without a transcript: a bare repeat goes, another question stays


def t_commit_names_how_old_the_saved_state_is(root):
    _w(root, f"{STORE}/handoff/auth.md", _leaf("auth", goal="auth", body=RECORDS_OLD, updated="2026-10-16 13:00:00+00:00"))
    event = _event(root, *_call("Bash", command=LOAD.format("auth")))
    swap = {"type": "system", "subtype": "compact_boundary", "timestamp": "2026-10-16T22:00:00.000Z", "compactMetadata": {}}
    mark(root, event)
    _add(event, swap, _compaction(_summary(_leaf("a", stream="audit-data"), _leaf("auth", goal="auth", stream="auth")))[1])
    saved, problems = commit(root)
    assert saved == [f"{STORE}/handoff/audit-data.md", f"{STORE}/handoff/auth.md"], saved
    assert len(problems) == 2 and "saved state as of" in problems[0] and "9 h 30 min before this compaction" in problems[0], problems
    assert "/compress audit-data saves the work since" in problems[0], problems
    assert "kept its newer state as of" in problems[1] and "9 h before this compaction" in problems[1], problems
    mark(root, event)
    _add(event, {**swap, "timestamp": "2026-10-16T12:40:00.000Z"}, _compaction(_summary(_leaf("a", stream="audit-data")))[1])
    assert commit(root) == ([f"{STORE}/handoff/audit-data.md"], [])  # 10 minutes: fresh enough to say nothing


def t_ownership_needs_a_successful_main_thread_call(root):
    for slug in ("auth", "billing", "drafted", "saved", "failed", "side", "docs", "cache", "eval"):
        _w(root, f"{STORE}/handoff/{slug}.md", _leaf(slug))
    side = [{**row, "isSidechain": True} for row in _call("Read", "t6", file_path=f"{root}/.wisci/handoff/side.md")]
    lines = transcript_lines(_event(
        root, *_call("Bash", "t1", command=LOAD.format("auth")),
        *_call("Write", "t2", file_path=f"{root}/.wisci/handoff/billing.md", content="x"),
        *_call("Bash", "t3", command=f"{WISCI} draft drafted --session s1"),
        *_call("Bash", "t4", command=f"{WISCI} save .wisci/.drafts/saved-s1abcdef.md --session s1"),
        _tool("Read", "t5", file_path=f"{root}/.wisci/handoff/failed.md"), _done("t5", error=True), *side,
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "see .wisci/handoff/docs.md"}]}},
        *_call("Read", "t7", file_path="/elsewhere/.wisci/handoff/cache.md"),
        *_call("Read", "t8", file_path=f"{root}/.wisci/handoff/gone.md"))["transcript_path"])[0]
    claims = stream_claims(root, "s1", lines)
    assert set(claims) == {"auth", "billing", "drafted", "saved"} and _by_recency(claims)[0] == "saved", claims
    _w(root, f"{STORE}/handoff/eval.md", _leaf("eval", **{"committed-by": "s1"}))
    _w(root, f"{STORE}/handoff/docs.md", _leaf("docs", session="s1"))  # 3.2.0's key claims nothing
    claims = stream_claims(root, "s1", lines)
    assert claims["eval"] == OWN and "docs" not in claims and "eval" not in stream_claims(root, "s2", lines), claims
    assert stream_claims(root, "s1", lines[:1]) == {"eval": OWN}  # the result is after the cut


def t_compaction_forks_a_stream_it_never_saw(root):
    original = _leaf("auth", body=RECORDS_OLD)
    _w(root, f"{STORE}/handoff/auth.md", original)
    event = _event(root, *_call("Bash", command="ls"))
    assert _compact(root, event, _leaf("auth", stream="auth")) == ([f"{STORE}/handoff/auth-2.md"], [])
    saved, _ = _compact(root, event, _leaf("auth", body="## Next Steps\n1. Later.\n", stream="auth"), ts="2026-10-16T13:30:00.000Z")
    assert saved == [f"{STORE}/handoff/auth-2.md"] and "1. Later." in _read(root, saved[0]), saved
    assert _read(root, f"{STORE}/handoff/auth.md") == original


def t_compaction_merges_a_loaded_stream(root):
    _w(root, f"{STORE}/handoff/auth.md", _leaf("auth", body=RECORDS_OLD, session="s0"))
    event = _event(root, _said("ship today, then rest"), *_call("Bash", command=LOAD.format("auth")))
    new = _leaf("auth", body='## Constraints\n- "ship today, then rest"\n\n## Completed\n- refresh added\n', stream="auth")
    assert _compact(root, event, new) == ([f"{STORE}/handoff/auth.md"], [])
    text = _read(root, f"{STORE}/handoff/auth.md")
    assert '- "no new dependencies" (the user, 2026-10-01)\n- "ship today, then rest" (' in text, text
    assert "nginx limiting" in text and "refresh added" in text and "old work" not in text, text
    fm = parse_frontmatter(text)
    assert fm["committed-by"] == "s1" and "stream" not in fm and "session" not in fm, fm


def t_compaction_matches_a_claimed_stream_by_goal(root):
    _w(root, f"{STORE}/handoff/auth-refactor.md", _leaf("auth-refactor", goal="refactor auth middleware", body=RECORDS_OLD))
    event = _event(root, *_call("Bash", command=LOAD.format("auth-refactor")))
    block = _leaf("x", goal="refactor auth middleware", stream="refactor-auth-middleware")
    assert _compact(root, event, block)[0] == [f"{STORE}/handoff/auth-refactor.md"]
    assert "nginx limiting" in _read(root, f"{STORE}/handoff/auth-refactor.md")
    _w(root, f"{STORE}/handoff/billing.md", _leaf("billing", goal="bill"))  # same goal, never loaded: no match
    assert _compact(root, _event(root), _leaf("y", goal="bill", stream="billing-runs"))[0] == [f"{STORE}/handoff/billing-runs.md"]


def t_compaction_saves_every_block(root):
    saved, _ = _compact(root, _event(root), _leaf("a", stream="audit-data"), _leaf("b", goal="b", stream="billing"))
    assert saved == [f"{STORE}/handoff/audit-data.md", f"{STORE}/handoff/billing.md"], saved
    assert "Read part4" in _read(root, saved[0]) and parse_frontmatter(_read(root, saved[1]))["goal"] == "b"


def t_compaction_without_stream_uses_the_session_leaf(root):
    event = _event(root)
    first, _ = _compact(root, event, _leaf("a", stream="read-data-chain"))
    assert _compact(root, event, _leaf("a"))[0] == first
    assert _compact(root, _event(root, sid="s2"), _leaf("a", goal="Audit the data files"))[0] == [
        f"{STORE}/handoff/audit-the-data-files.md"]


def t_compaction_reports_bad_blocks(root):
    event = _event(root)
    for summary in ("Summary: nothing", "<wisci-handoff>\n" + _leaf("a", stream="a"), "see <wisci-handoff>…</wisci-handoff>"):
        saved, problems = _compact_summary(root, event, summary)
        assert saved == [] and "no handoff block" in problems[0], problems
    for bad in (_leaf("a", stream="../x"), _leaf("a", stream="a", status="paused"), _leaf("a", goal="", stream="a")):
        assert _compact(root, event, bad)[0] == []
    assert not os.path.isdir(os.path.join(root, STORE, "handoff"))
    saved, problems = _compact(root, event, _leaf("b", stream="../x"), _leaf("a", stream="ok"), _leaf("c", stream="a", status="x"))
    assert saved == [f"{STORE}/handoff/ok.md"] and "'../x'" in problems[0] and "status" in problems[1], problems


def t_precompact_lists_streams_and_saved_records(root):
    _w(root, "SKILL.md", SKILL)
    skill = os.path.join(root, "SKILL.md")
    assert "This session's streams:\n- none\n" in precompact_instructions(root, skill, _event(root))
    _w(root, f"{STORE}/handoff/auth.md", _leaf("auth", goal="refactor auth", body=RECORDS_OLD))
    _w(root, f"{STORE}/handoff/billing.md", _leaf("billing", goal="billing", body=RECORDS_OLD))
    _w(root, f"{STORE}/handoff/broken.md", _leaf("broken", status="paused"))
    text = precompact_instructions(root, skill, _event(root, *_call("Bash", command=LOAD.format("auth"))))
    assert text.startswith("Already saved") and text.endswith("This session's streams:\n- auth: refactor auth\n\n"
                                                             + handoff_spec(skill) + "\n"), text
    assert '- "no new dependencies" (the user, 2026-10-01)' in text and "nginx limiting" in text, text
    assert "billing" not in text and "old work" not in text, text


def t_session_status_injects_the_streams_records(root):
    _w(root, f"{STORE}/handoff/auth.md", _leaf("auth", body=RECORDS_OLD, **{"committed-by": "s1"}))
    _w(root, f"{STORE}/handoff/other.md", _leaf("other", body='## Constraints\n- "other rule" (the user)\n'))
    _w(root, f"{STORE}/handoff/billing.md", _leaf("billing", body="## Decisions\n- invoices monthly\n"))
    event = _event(root, *_call("Bash", command=LOAD.format("billing")), source="compact")
    text = session_status(root, event)
    assert text.startswith(INJECT_LABEL + "\n\nhandoff/auth:\n\n## Constraints\n"), text
    assert "nginx limiting" in text and "invoices monthly" in text, text
    assert "old work" not in text and "other rule" not in text and "WISCI store" in text, text
    assert "no new dependencies" not in session_status(root, {**event, "session_id": "s2"})
    assert INJECT_LABEL not in session_status(root, {**event, "source": "startup"})
    _w(root, f"{STORE}/handoff/auth.md", _leaf("auth", body="## Constraints\n" + "- x\n" * 5000, **{"committed-by": "s1"}))
    big = session_status(root, event)
    assert len(big) < 10_000 and f"more lines in {STORE}/handoff/auth.md" in big and "invoices monthly" in big, big[-500:]


def t_session_status_commits_and_reports(root):
    event = _event(root)
    mark(root, event)
    _add(event, *_compaction("Summary: no block"))
    text = session_status(root, {**event, "source": "startup"})
    assert text.startswith("wisci: the compaction summary has no handoff block") and _pending(root) == [], text


def t_lock_times_out(root):
    def locked():
        with store_lock(root, timeout=0.1):
            pass
    os.makedirs(os.path.join(root, STORE))
    with open(os.path.join(root, STORE, ".lock"), "a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        assert "held by another wisci process" in _raises(locked)
    locked()


# /compress drafts

def t_draft_and_save(root):
    _w(root, f"{STORE}/handoff/auth.md", _leaf("auth", body=RECORDS_OLD))
    words = user_words(transcript_lines(_event(root, _said("keep the refresh tokens short lived"))["transcript_path"])[0])
    d = draft(root, "auth", "s1abcdef99")
    assert d == f"{STORE}/.drafts/auth-s1abcdef.md" and _read(root, d) == _read(root, f"{STORE}/handoff/auth.md")
    assert _read(root, f"{STORE}/.drafts/auth-s1abcdef.base") == _digest(root, f"{STORE}/handoff/auth.md")
    _w(root, d, _read(root, d).replace("2026-10-01)\n", '2026-10-01)\n- "keep the refresh tokens short lived"\n'
                                       '- "invented rule here"\n').replace("- old work", "- new work"))
    leaf, left_out = save_draft(root, d, "s1abcdef99", words)
    text = _read(root, leaf)
    assert leaf == f"{STORE}/handoff/auth.md" and left_out == ['- "invented rule here"'], left_out
    assert '(the user, 2026-10-01)\n- "keep the refresh tokens short lived" (' in text and "invented" not in text, text
    assert "new work" in text and "old work" not in text and not os.path.exists(os.path.join(root, d)), text
    fm = parse_frontmatter(text)
    assert fm["committed-by"] == "s1abcdef99" and _moment(fm["updated"]), fm
    assert not os.path.exists(os.path.join(root, f"{STORE}/.drafts/auth-s1abcdef.base"))
    other, mine = draft(root, "auth", "s2zzzzzzzz"), draft(root, "auth", "s1abcdef99")
    assert other != mine
    _w(root, leaf, text + "\n## Blockers / Open Questions\n- x\n")
    assert "changed since this draft" in _raises(save_draft, root, other, "s2zzzzzzzz", words)
    assert os.path.exists(os.path.join(root, other))
    edited = draft(root, "auth", "s2zzzzzzzz")
    _w(root, edited, _read(root, edited).replace("nginx limiting", "nginx rate limiting"))
    assert "- nginx limiting" in _raises(save_draft, root, edited, "s2zzzzzzzz", words)
    new = draft(root, "billing", "s1abcdef99")
    assert _read(root, f"{STORE}/.drafts/billing-s1abcdef.base") == "new"
    assert "goal" in _raises(save_draft, root, new, "s1abcdef99", words)
    _w(root, new, _read(root, new).replace("goal: ", "goal: bill monthly") + '\n## Constraints\n- "invented rule"\n')
    assert save_draft(root, new, None, None) == (f"{STORE}/handoff/billing.md", [])  # no session: not verified
    assert '- "invented rule"' in _read(root, f"{STORE}/handoff/billing.md")
    for bad in ("x.md", f"{STORE}/handoff/auth.md", f"{STORE}/.drafts/Auth-12345678.md"):
        assert "not a draft" in _raises(save_draft, root, bad, None, None)
    whole = draft(root, "auth", "s1abcdef99")
    _w(root, whole, _read(root, whole).replace("updated:", "x-updated:").replace("committed-by:", "x-by:"))
    assert save_draft(root, whole, "s1abcdef99", words)[0] == f"{STORE}/handoff/auth.md"
    _w(root, f"{STORE}/.drafts/auth-handmade.md", _read(root, f"{STORE}/handoff/auth.md"))
    assert "no base revision" in _raises(save_draft, root, f"{STORE}/.drafts/auth-handmade.md", None, None)


def t_load_names_the_saving_sessions_transcript(root):
    _w(root, f"{STORE}/handoff/x.md", _leaf("x", **{"committed-by": "s1"}))
    _w(root, "config/projects/-p/s1.jsonl", "")
    before = os.environ.get("CLAUDE_CONFIG_DIR")
    os.environ["CLAUDE_CONFIG_DIR"] = os.path.join(root, "config")
    try:
        out = render_load(root, f"{STORE}/handoff/x.md")
        assert f"> transcript of the session that saved it: {root}/config/projects/-p/s1.jsonl\n" in out, out
        os.remove(os.path.join(root, "config/projects/-p/s1.jsonl"))
        assert "> transcript" not in render_load(root, f"{STORE}/handoff/x.md")
    finally:
        if before is None:
            os.environ.pop("CLAUDE_CONFIG_DIR")
        else:
            os.environ["CLAUDE_CONFIG_DIR"] = before


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
    def run(cmd, event, *args):
        return subprocess.run([sys.executable, os.path.abspath(__file__), "--root", root, cmd, *args],
                              input=json.dumps(event) if event is not None else "", capture_output=True, text=True,
                              check=False)
    event = _event(root)
    r = run("mark", event)
    assert r.returncode == 0 and r.stdout == "" and len(_pending(root)) == 1, r
    assert run("stop", None).stdout == ""
    _add(event, *_compaction(_summary(_leaf("a", stream="audit-data"))))
    r = run("stop", None)
    assert r.returncode == 0 and json.loads(r.stdout) == {"systemMessage": f"wisci: saved {STORE}/handoff/audit-data.md"}, r
    r = run("precompact", None)
    assert r.returncode == 2 and "hook event" in r.stderr, r
    r = run("session-status", None)
    assert r.returncode == 0 and "handoff/audit-data" in r.stdout, r
    r = run("session-status", {**event, "source": "compact"})
    assert r.returncode == 0 and "Read part4" not in r.stdout and "handoff/audit-data" in r.stdout, r
    r = run("draft", None, "audit-data", "--session", "s1")
    assert r.returncode == 0 and r.stdout == f"{STORE}/.drafts/audit-data-s1.md\n", r
    r = run("draft", None, "audit-data", "--session", "${CLAUDE_SESSION_ID}")
    assert r.returncode == 2 and "session id" in r.stderr, r
    path = run("draft", None, "audit-data").stdout.strip()
    r = run("save", None, path)
    assert r.returncode == 0 and r.stdout.startswith(f"wisci: saved {STORE}/handoff/audit-data.md\n"), r
    assert "Constraints not verified" in r.stdout and r.stdout.endswith("evidence ok 0/0\n"), r


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
    dr = sub.add_parser("draft")
    dr.add_argument("slug")
    dr.add_argument("--session")
    sv = sub.add_parser("save")
    sv.add_argument("draft")
    sv.add_argument("--session")
    for name in ("session-status", "precompact", "mark", "stop", "test"):
        sub.add_parser(name)
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
        elif args.cmd == "draft":
            _emit(draft(root, args.slug, args.session) + "\n")
        elif args.cmd == "save":
            words = user_words(transcript_lines(session_transcript(_sid(args.session)))[0]) if args.session else None
            leaf, left_out = save_draft(root, args.draft, args.session, words)
            notes = [f"wisci: left out, not the user's exact words: {line}" for line in left_out] + (
                [] if args.session else ["wisci: Constraints not verified (no --session)"])
            _emit("\n".join([f"wisci: saved {leaf}", *notes]) + "\n" + render_check(root, leaf))
        elif args.cmd == "session-status":
            raw = "" if sys.stdin.isatty() else sys.stdin.read()  # the hook pipes its event; a manual run has none
            text = session_status(root, compact_event(raw) if raw.strip() else None)
            if text:
                _emit(text + "\n")
        elif args.cmd == "precompact":
            raw = "" if sys.stdin.isatty() else sys.stdin.read()  # from a terminal: fail fast, don't wait for input
            event = compact_event(raw)
            try:
                problems = commit(root)[1]
            except WisciError as e:
                problems = [str(e)]
            for problem in problems:  # stdout is the summarizer's prompt
                print(f"wisci: {problem}", file=sys.stderr)
            _emit(precompact_instructions(root, COMPRESS_SKILL, event))
        elif args.cmd == "mark":
            mark(root, compact_event(sys.stdin.read()))
        elif args.cmd == "stop":
            try:
                saved, problems = commit(root)
            except WisciError as e:  # exit 2 would make Claude continue with the error as its prompt
                saved, problems = [], [str(e)]
            lines = [f"wisci: saved {rel}" for rel in saved] + [f"wisci: {p}" for p in problems]
            if lines:
                _emit(json.dumps({"systemMessage": "\n".join(lines)}, ensure_ascii=False) + "\n")
    except WisciError as e:
        print(f"wisci: {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
