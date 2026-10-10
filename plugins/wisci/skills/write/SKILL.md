---
name: write
description: Saves knowledge from the conversation — research results, decisions with rationale, architecture notes, API quirks — as a note in .wisci/context/ whose claims about code carry quoted evidence, merging into an existing note on the same topic. Use when the user asks to save, persist, record or write down findings for future sessions. Not for code, tests, READMEs or other project files; session progress belongs to compress.
argument-hint: what to save
allowed-tools: Read Write Edit Glob Grep Bash(uv run --no-config --no-cache --script "${CLAUDE_SKILL_DIR}/scripts/wisci.py" *)
compatibility: Requires uv (uv provides Python 3.11+; git recommended); uses the bundled scripts/wisci.py.
---

# /write — Save Knowledge

Save reusable knowledge from this conversation as a note in `.wisci/context/`. `/select` loads it later and flags any section whose quoted code is no longer in the code. Session state (progress, next steps) belongs to `/compress`.

Script: `uv run --no-config --no-cache --script "${CLAUDE_SKILL_DIR}/scripts/wisci.py"` (`<wisci>` below). Run it exactly as written, as a command of its own, with the absolute path and quotes and no shell variables: the permission rule matches only that literal command. Edit store files with Write or Edit, never with shell redirects. Hosts without command injection: run it from the project root with `<this skill's directory>/scripts/wisci.py` as the path.

Store state:
!`uv run --no-config --no-cache --script "${CLAUDE_SKILL_DIR}/scripts/wisci.py" scan`

## Steps

1. **Topic.** Name the core topic from `$ARGUMENTS` and the conversation, and compare it with the `context/…` paths above: same topic → merge (3); new → create (2), slug kebab-case, at most 4 words; unsure → ask.
2. **Create.** `<wisci> new context <slug>` reserves the file and prints its path (`-2` if taken). Read it, then Write the full note (the Write tool requires the Read).
3. **Merge.** Read the note, then change it with Edit. Rewrite the sections you re-checked against the code this session and add new ones. Leave the others as they are, failing quotes included. A newer decision on the same topic replaces the older one, which moves to Ruled out with why. Facts that conflict with no way to tell which is current: keep both, mark `<!-- REVIEW: possible overlap -->`.
4. **Check.** Always run `<wisci> check <path>`: it is part of saving, not a code review. It lists every quote that no longer matches the code, then `evidence ok N/M`. Fix the failures in sections you wrote or changed: re-read the file, then correct the quote and the claim beside it together. Leave failures in sections you didn't touch. Never delete or swap a quote just to make it pass.
5. **Confirm:** path, created or merged, `evidence ok N/M`, one-line summary.

## Evidence

For each claim about what the code does, quote the lines it rests on in a fenced block tagged with the language and the file's path from the project root:

```ts src/auth/session.ts
export const SESSION_TTL = 3600 // seconds
```

- Copy whole lines exactly as they are in the file now, 1–3 lines per quote. Quote the line that would change if your claim became false (the value, the condition, the call), not just the signature. Pick lines that occur once.
- One block per place in the code; no `...`.
- Decisions, requirements, plans and ruled-out approaches need no quote.
- Only fenced blocks with a path are checked. Mention other files in prose.

## Note format

````markdown
# <Title>

## <Topic section>
<claims, each followed by its evidence block>

## Key Details
- **Decisions**: <decision — rationale> (YYYY-MM-DD)
- **Ruled out**: <approach — why> (YYYY-MM-DD)
- **Open questions**: <unresolved items>
````

Keep facts out of the title. Omit empty sections.

## Keep verbatim

Paths and line numbers; function, class and module names; error messages, numbers and command output; decisions with their reasoning and approaches ruled out with why; the user's requirements, constraints and preferences in their words; URLs. When you condense, keep a pointer (path, URL, commit) beside the claim. If the store is gitignored, a replaced section is gone for good, so merge rather than replace.
