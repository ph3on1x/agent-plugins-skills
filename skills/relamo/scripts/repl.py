#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "dill>=0.3.8",
# ]
# ///
"""Persistent Python REPL engine for the relamo skill.

Stores codebase as a concatenated string, persists state across invocations
via dill, and provides helper functions for LLM-in-the-loop exploration.
"""

import argparse
import io
import os
import re
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path

import shutil

import dill

# ---------------------------------------------------------------------------
# Configuration defaults
# ---------------------------------------------------------------------------

DEFAULT_CONFIG = {
    "recursion_limit": 1,
    "max_iterations": 15,
    "timeout_seconds": 120,
    "max_output_chars": 10_000,
    "max_file_size": 1_000_000,       # 1 MB per file
    "max_context_bytes": 50_000_000,  # 50 MB total
}

FILE_DELIMITER = "=== {} ==="

# LLM CLI detection order: env var override, then auto-detect in PATH.
# Each entry: (binary, args_for_prompt, extra_description)
# The prompt is appended as the final argument.
_LLM_CLI_CANDIDATES = [
    ("claude", ["-p", "{prompt}", "--no-session-persistence", "--output-format", "text"]),
    ("gemini", ["-p", "{prompt}"]),
    ("codex",  ["exec", "--ephemeral", "{prompt}"]),
]


def _detect_llm_cli() -> tuple[str, list[str]] | None:
    """Return (binary, arg_template) for the first available LLM CLI.

    Checks RELAMO_LLM_CMD env var first, then auto-detects from PATH.
    """
    env_cmd = os.environ.get("RELAMO_LLM_CMD")
    if env_cmd:
        parts = env_cmd.split()
        if parts:
            binary = parts[0]
            args = parts[1:] if len(parts) > 1 else ["{prompt}"]
            if "{prompt}" not in " ".join(args):
                args.append("{prompt}")
            return (binary, args)

    for binary, args in _LLM_CLI_CANDIDATES:
        if shutil.which(binary):
            return (binary, args)

    return None

# Modules the sandboxed REPL is allowed to import
ALLOWED_MODULES = frozenset({
    "re", "json", "math", "statistics", "collections", "itertools",
    "functools", "textwrap", "difflib", "hashlib", "datetime",
    "csv", "io", "os.path", "pathlib", "string", "unicodedata",
})

# Default directories/patterns to skip when not in a git repo
DEFAULT_EXCLUDES = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", ".env",
    "dist", "build", ".next", ".nuxt", ".output", "target",
    ".cache", ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache",
    "vendor", "coverage", ".idea", ".vscode",
}

# ---------------------------------------------------------------------------
# Codebase gathering
# ---------------------------------------------------------------------------


def _is_binary(path: Path) -> bool:
    """Detect binary files by checking for null bytes in first 8 KB."""
    try:
        with open(path, "rb") as f:
            chunk = f.read(8192)
        return b"\x00" in chunk
    except OSError:
        return True


def _git_ls_files(codebase_dir: str) -> list[str]:
    """List tracked + untracked-but-not-ignored files via git."""
    result = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
        capture_output=True, text=True, cwd=codebase_dir, timeout=30,
    )
    if result.returncode != 0:
        return []
    return [f for f in result.stdout.strip().splitlines() if f]


def _walk_with_excludes(codebase_dir: str) -> list[str]:
    """Walk directory tree, skipping default excludes."""
    root = Path(codebase_dir)
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in DEFAULT_EXCLUDES]
        for fname in filenames:
            full = Path(dirpath) / fname
            files.append(str(full.relative_to(root)))
    return files


def gather_codebase(codebase_dir: str, config: dict) -> tuple[str, list[str]]:
    """Concatenate all source files into a single context string.

    Returns (context_string, list_of_file_paths).
    """
    root = Path(codebase_dir).resolve()

    # Try git first, fall back to walk
    git_dir = root / ".git"
    if git_dir.exists():
        rel_files = _git_ls_files(str(root))
    else:
        rel_files = _walk_with_excludes(str(root))

    rel_files.sort()

    parts: list[str] = []
    included: list[str] = []
    total_bytes = 0

    for rel in rel_files:
        full = root / rel
        if not full.is_file():
            continue
        try:
            size = full.stat().st_size
        except OSError:
            continue
        if size > config["max_file_size"]:
            continue
        if size == 0:
            continue
        if _is_binary(full):
            continue
        if total_bytes + size > config["max_context_bytes"]:
            print(f"[relamo] Context size limit reached at {total_bytes:,} bytes, "
                  f"skipping remaining files.", file=sys.stderr)
            break
        try:
            content = full.read_text(errors="replace")
        except OSError:
            continue

        parts.append(FILE_DELIMITER.format(rel))
        parts.append(content)
        included.append(rel)
        total_bytes += size

    context = "\n".join(parts)
    return context, included


# ---------------------------------------------------------------------------
# Helper functions injected into the REPL namespace
# ---------------------------------------------------------------------------


def _make_extract_file(context: str):
    """Create extract_file() bound to the given context string."""
    def extract_file(path: str) -> str:
        """Extract a single file's content from the concatenated context."""
        start_marker = FILE_DELIMITER.format(path)
        start = context.find(start_marker)
        if start == -1:
            return f"[error] File not found in context: {path}"
        content_start = start + len(start_marker) + 1  # skip newline
        next_marker = context.find("\n=== ", content_start)
        if next_marker == -1:
            return context[content_start:]
        return context[content_start:next_marker]
    return extract_file


def _make_list_files(file_list: list[str]):
    """Create list_files() bound to the gathered file list."""
    def list_files() -> list[str]:
        """Return all file paths present in the context."""
        return list(file_list)
    return list_files


def _make_search(context: str):
    """Create search() bound to the given context string."""
    def search(pattern: str, context_chars: int = 200) -> list[str]:
        """Search context with regex, returning matches with surrounding text."""
        results = []
        for m in re.finditer(pattern, context):
            start = max(0, m.start() - context_chars)
            end = min(len(context), m.end() + context_chars)
            snippet = context[start:end]
            results.append(snippet)
        return results
    return search


def _build_llm_cmd(cli: tuple[str, list[str]], prompt: str) -> list[str]:
    """Build the full command list, substituting {prompt} in the arg template."""
    binary, arg_template = cli
    return [binary] + [a.replace("{prompt}", prompt) for a in arg_template]


def _make_llm_query(config: dict, cli: tuple[str, list[str]] | None):
    """Create llm_query() using the detected LLM CLI."""
    def llm_query(prompt: str, max_tokens: int = 4096) -> str:
        """Send a prompt to an LLM CLI and return the response."""
        if cli is None:
            return (
                "[llm_query error] No LLM CLI found in PATH. "
                "Install claude, gemini, or codex CLI, or set RELAMO_LLM_CMD."
            )
        try:
            result = subprocess.run(
                _build_llm_cmd(cli, prompt),
                capture_output=True, text=True,
                timeout=config["timeout_seconds"],
            )
            if result.returncode != 0:
                return f"[llm_query error] {result.stderr.strip()}"
            return result.stdout.strip()
        except subprocess.TimeoutExpired:
            return f"[llm_query error] Timed out after {config['timeout_seconds']}s"
        except FileNotFoundError:
            return f"[llm_query error] {cli[0]} CLI not found in PATH"
    return llm_query


def _make_llm_query_batched(llm_query_fn):
    """Create llm_query_batched() using the given llm_query function."""
    def llm_query_batched(prompts: list[str]) -> list[str]:
        """Run multiple LLM queries sequentially."""
        return [llm_query_fn(p) for p in prompts]
    return llm_query_batched


def _make_recursive_llm(config: dict, cli: tuple[str, list[str]] | None):
    """Create recursive_llm() that spawns a child RLM via the detected LLM CLI."""
    def recursive_llm(query: str, sub_context: str, _depth: int = 0) -> str:
        """Spawn a child RLM instance to process a sub-query with its own context."""
        if cli is None:
            return (
                "[recursive_llm error] No LLM CLI found in PATH. "
                "Install claude, gemini, or codex CLI, or set RELAMO_LLM_CMD."
            )

        if _depth >= config["recursion_limit"]:
            # Fall back to flat llm_query on truncated context
            truncated = sub_context[:50_000]
            prompt = f"Answer this question based ONLY on the context below.\n\nQuestion: {query}\n\nContext:\n{truncated}"
            try:
                result = subprocess.run(
                    _build_llm_cmd(cli, prompt),
                    capture_output=True, text=True,
                    timeout=config["timeout_seconds"],
                )
                return result.stdout.strip() if result.returncode == 0 else f"[error] {result.stderr.strip()}"
            except (subprocess.TimeoutExpired, FileNotFoundError) as e:
                return f"[recursive_llm error] {e}"

        # Write sub_context to temp file
        with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as f:
            f.write(sub_context)
            ctx_path = f.name

        try:
            system_prompt = (
                f"You are a Recursive Language Model (RLM) sub-instance.\n"
                f"Your context is in: {ctx_path}\n"
                f"Read the context file first, then answer the query.\n"
                f"Be concise — max 500 words. Answer based ONLY on the context.\n"
                f"If insufficient context, say INSUFFICIENT CONTEXT and what's missing."
            )
            full_prompt = f"{system_prompt}\n\nQuery: {query}"
            result = subprocess.run(
                _build_llm_cmd(cli, full_prompt),
                capture_output=True, text=True,
                timeout=config["timeout_seconds"],
            )
            return result.stdout.strip() if result.returncode == 0 else f"[error] {result.stderr.strip()}"
        except (subprocess.TimeoutExpired, FileNotFoundError) as e:
            return f"[recursive_llm error] {e}"
        finally:
            os.unlink(ctx_path)
    return recursive_llm


def _make_final(namespace: dict):
    """Create FINAL() that emits the termination marker."""
    def FINAL(answer: str) -> None:  # noqa: N802
        """Emit the final answer. Terminates the REPL loop."""
        print(f"__RELAMO_FINAL__: {answer}")
    return FINAL


def _make_final_var(namespace: dict):
    """Create FINAL_VAR() that resolves a namespace variable as the answer."""
    def FINAL_VAR(var_name: str) -> None:  # noqa: N802
        """Emit a namespace variable as the final answer."""
        if var_name not in namespace:
            print(f"[error] Variable '{var_name}' not found in namespace")
            return
        print(f"__RELAMO_FINAL__: {namespace[var_name]}")
    return FINAL_VAR


# ---------------------------------------------------------------------------
# Sandboxed import
# ---------------------------------------------------------------------------


def _filtered_import(name, *args, **kwargs):
    """Import only whitelisted modules."""
    top_level = name.split(".")[0]
    if top_level not in ALLOWED_MODULES and name not in ALLOWED_MODULES:
        raise ImportError(f"Module '{name}' is not allowed. Permitted: {', '.join(sorted(ALLOWED_MODULES))}")
    return __builtins__.__import__(name, *args, **kwargs) if hasattr(__builtins__, "__import__") else __import__(name, *args, **kwargs)


# ---------------------------------------------------------------------------
# REPL state management
# ---------------------------------------------------------------------------


def state_path(state_dir: str) -> str:
    return os.path.join(state_dir, "state.pkl")


def context_path(state_dir: str) -> str:
    return os.path.join(state_dir, "context.txt")


def files_path(state_dir: str) -> str:
    return os.path.join(state_dir, "files.pkl")


def save_state(namespace: dict, state_dir: str) -> None:
    """Save serializable parts of namespace to disk."""
    to_save = {}
    for k, v in namespace.items():
        if k.startswith("_") or callable(v):
            continue
        try:
            dill.dumps(v)
            to_save[k] = v
        except (TypeError, dill.PicklingError):
            pass
    with open(state_path(state_dir), "wb") as f:
        dill.dump(to_save, f)


def load_state(state_dir: str) -> dict:
    """Load saved state from disk."""
    sp = state_path(state_dir)
    if not os.path.exists(sp):
        return {}
    with open(sp, "rb") as f:
        return dill.load(f)


# ---------------------------------------------------------------------------
# Init command
# ---------------------------------------------------------------------------


def cmd_init(args: argparse.Namespace) -> None:
    """Initialize the REPL environment with codebase context."""
    state_dir = args.state_dir
    if not state_dir:
        state_dir = tempfile.mkdtemp(prefix="relamo-")
    os.makedirs(state_dir, exist_ok=True)

    config = dict(DEFAULT_CONFIG)

    if args.codebase_dir:
        codebase_dir = os.path.abspath(args.codebase_dir)
        print(f"[relamo] Gathering codebase from: {codebase_dir}")
        context, file_list = gather_codebase(codebase_dir, config)
    elif args.context_file:
        context_file = os.path.abspath(args.context_file)
        print(f"[relamo] Loading context from file: {context_file}")
        context = Path(context_file).read_text(errors="replace")
        file_list = []
    else:
        print("[error] Must specify --codebase-dir or --context-file", file=sys.stderr)
        sys.exit(1)

    # Write context to disk
    with open(context_path(state_dir), "w") as f:
        f.write(context)
    with open(files_path(state_dir), "wb") as f:
        dill.dump(file_list, f)

    # Save initial config as state
    save_state({"config": config}, state_dir)

    # Print summary
    print(f"[relamo] State directory: {state_dir}")
    print(f"[relamo] Context size: {len(context):,} characters ({len(context.encode('utf-8')):,} bytes)")
    print(f"[relamo] Files included: {len(file_list)}")
    if file_list:
        print(f"[relamo] Sample files: {', '.join(file_list[:10])}")
        if len(file_list) > 10:
            print(f"[relamo]   ... and {len(file_list) - 10} more")
    print()
    cli = _detect_llm_cli()
    if cli:
        print(f"[relamo] LLM CLI: {cli[0]}")
    else:
        print("[relamo] LLM CLI: none detected (llm_query/recursive_llm will be unavailable)")
        print("[relamo]   Install claude, gemini, or codex CLI, or set RELAMO_LLM_CMD")

    print("[relamo] Available in REPL:")
    print("  context          — full codebase as string")
    print("  list_files()     — all file paths in context")
    print("  extract_file(p)  — extract single file content")
    print("  search(pattern)  — regex search with context")
    llm_label = f"LLM completion via {cli[0]}" if cli else "unavailable (no CLI)"
    print(f"  llm_query(p)     — {llm_label}")
    print("  llm_query_batched(ps) — sequential LLM calls")
    print("  recursive_llm(q, ctx) — spawn child RLM")
    print("  FINAL(answer)    — emit final answer")
    print("  FINAL_VAR(name)  — emit variable as answer")
    print("  config           — safety config (mutable)")


# ---------------------------------------------------------------------------
# Execute command
# ---------------------------------------------------------------------------


def cmd_execute(args: argparse.Namespace) -> None:
    """Execute Python code in the persistent REPL namespace."""
    state_dir = args.state_dir
    if not state_dir or not os.path.exists(state_dir):
        print("[error] --state-dir is required and must exist", file=sys.stderr)
        sys.exit(1)

    # Load context and file list
    ctx_file = context_path(state_dir)
    if not os.path.exists(ctx_file):
        print("[error] No context found. Run --init first.", file=sys.stderr)
        sys.exit(1)

    context = Path(ctx_file).read_text(errors="replace")

    fl_file = files_path(state_dir)
    file_list = []
    if os.path.exists(fl_file):
        with open(fl_file, "rb") as f:
            file_list = dill.load(f)

    # Load persisted state
    saved = load_state(state_dir)
    config = saved.pop("config", dict(DEFAULT_CONFIG))

    # Build namespace
    namespace = dict(saved)
    namespace["context"] = context
    namespace["config"] = config
    namespace["extract_file"] = _make_extract_file(context)
    namespace["list_files"] = _make_list_files(file_list)
    namespace["search"] = _make_search(context)

    cli = _detect_llm_cli()
    llm_query_fn = _make_llm_query(config, cli)
    namespace["llm_query"] = llm_query_fn
    namespace["llm_query_batched"] = _make_llm_query_batched(llm_query_fn)
    namespace["recursive_llm"] = _make_recursive_llm(config, cli)
    namespace["FINAL"] = _make_final(namespace)
    namespace["FINAL_VAR"] = _make_final_var(namespace)

    # Sandboxed builtins
    import builtins
    safe_builtins = {k: getattr(builtins, k) for k in dir(builtins) if not k.startswith("_")}
    safe_builtins.pop("eval", None)
    safe_builtins.pop("exec", None)
    safe_builtins.pop("compile", None)
    safe_builtins["__import__"] = _filtered_import
    namespace["__builtins__"] = safe_builtins

    # Read code from --execute argument or stdin
    code = args.code
    if code == "-":
        code = sys.stdin.read()

    # Capture stdout/stderr
    stdout_capture = io.StringIO()
    stderr_capture = io.StringIO()

    old_stdout, old_stderr = sys.stdout, sys.stderr
    sys.stdout = stdout_capture
    sys.stderr = stderr_capture

    try:
        exec(code, namespace)  # noqa: S102
    except Exception:
        traceback.print_exc(file=stderr_capture)
    finally:
        sys.stdout = old_stdout
        sys.stderr = old_stderr

    # Collect output
    stdout_val = stdout_capture.getvalue()
    stderr_val = stderr_capture.getvalue()

    max_chars = config.get("max_output_chars", 10_000)

    if stdout_val:
        if len(stdout_val) > max_chars:
            stdout_val = stdout_val[:max_chars] + f"\n[truncated at {max_chars} chars]"
        print(stdout_val, end="")

    if stderr_val:
        if len(stderr_val) > max_chars:
            stderr_val = stderr_val[:max_chars] + f"\n[truncated at {max_chars} chars]"
        print(stderr_val, end="", file=sys.stderr)

    # Save state (exclude non-serializable helpers and context)
    to_persist = {}
    for k, v in namespace.items():
        if k in ("context", "__builtins__", "extract_file", "list_files",
                 "search", "llm_query", "llm_query_batched", "recursive_llm",
                 "FINAL", "FINAL_VAR"):
            continue
        to_persist[k] = v
    to_persist["config"] = config
    save_state(to_persist, state_dir)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description="relamo REPL engine")
    sub = parser.add_subparsers(dest="command")

    # Init
    init_p = sub.add_parser("init", help="Initialize REPL with context")
    init_p.add_argument("--codebase-dir", help="Directory to gather as context")
    init_p.add_argument("--context-file", help="Single file to use as context")
    init_p.add_argument("--state-dir", help="Directory for persisted state")

    # Execute
    exec_p = sub.add_parser("execute", help="Execute code in REPL")
    exec_p.add_argument("code", help="Python code to execute (use '-' for stdin)")
    exec_p.add_argument("--state-dir", required=True, help="State directory from init")

    args = parser.parse_args()

    if args.command == "init":
        cmd_init(args)
    elif args.command == "execute":
        cmd_execute(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
