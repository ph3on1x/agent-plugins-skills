# anymodel tests

End-to-end tests run real Claude Code sessions with the plugin. Each session's "cloud" is
`recorder.mjs`, a loopback stand-in for api.anthropic.com that records every request (headers
`x-claude-code-agent-id`, `x-claude-code-request-class`, the model and the whole body) and forwards it
to the local model on Unsloth Studio, so the main agent behaves for real. An anymodel agent passes when the recorder never
sees a request carrying its agent id and its answer is right. The checks also note when the statement's
canary, IBAN or raw rows appear in a request body; with only the subagent's answer reaching main they do
not.

Nothing touches your `~/.claude` or `~/.local/state/anymodel`: every session gets its own `HOME` and
`CLAUDE_CONFIG_DIR` under the test dir, a dummy token, and `ANTHROPIC_BASE_URL` pointed at the recorder.
The agents go into that config's plugin store, as anymodel saves them, and their keys into its
`pluginConfigs["anymodel@inline"].options` API key field, as the settings form holds them (`ANYMODEL_AGENTS` in
`run.sh`; by default the agent `gem` on Unsloth Studio with its key); the suite sets the options back to `{}` when it
ends. The mod puts the workers' state under the session's `HOME`, so their sessions and
transcripts land in `$ANYMODEL_TEST_DIR/home/.local/state/anymodel`, where `check.mjs` reads them.

## Requirements

- Unsloth Studio serving on `http://127.0.0.1:8888` with a tool-capable model loaded (it answers any model name
  with it), and a file holding its key (`ANYMODEL_KEY_FILE`). The model is the stand-in main and the agents'
  model; its id is read from `/v1/models` (the one with a context length) unless `ANYMODEL_MODEL` gives it.
- `claude`, `node`, `jq`, `curl` and `python3` on `PATH`; macOS or Linux.

## Run

```bash
node --test plugins/anymodel/test/*.test.js                          # unit tests of hooks/worker.js
(cd plugins/anymodel && claude plugin test)                          # tests of the mod's hooks (test/anymodel.test.ts)
claude plugin eval plugins/anymodel --trust-plugin --no-publish      # evals (evals/), against a no-plugin baseline
export ANYMODEL_KEY_FILE=~/unsloth.key
ANYMODEL_TEST_DIR=/tmp/anymodel-test bash plugins/anymodel/test/suite.sh    # everything, an hour or more on a 27B model
ANYMODEL_TEST_DIR=/tmp/anymodel-test bash plugins/anymodel/test/suite.sh t1 t9   # some scenarios
```

The evals run in Claude Code's eval sandbox, which starts each run with a fresh home and no plugin settings, so no
agent exists there. They cover what holds then: `/anymodel`, `/anymodel check` and a bad `/anymodel cleanup` answer
with their guidance at no model cost, and with the plugin loaded Claude's own answers and a `general-purpose`
subagent are as without it (Δ 0). Agents on real models are this suite's job.

Use a fresh `ANYMODEL_TEST_DIR` per full run. The suite prints one `PASS`/`FAIL` line per check, then the number
that failed; the evidence is in `$ANYMODEL_TEST_DIR/logs/`. A headless run that does not exit 0 (for example the 300 s
cap) fails its scenario. A check on main's answer passes when the value reached main (an agent's result or task
notification): the plugin's job ends there, and the local model standing in for Claude can misquote it.

That stand-in also slips now and then (it runs a tool itself instead of calling the agent), so each failed scenario
runs once more, in `$ANYMODEL_TEST_DIR/retry`: `FLAKY <tag>` when it passes there, `FAIL <tag> (twice)` when it fails
again. The suite exits 1 only on a scenario that failed twice, or on the key found in a log (`tkey`, never retried).
A run that exits 0 is done: a flaky scenario needs no more runs, and one that failed twice needs its cause, from its
logs, before anything changes.

| Scenario | What it shows |
|---|---|
| t1 | Delegation: correct totals from `fixtures/statement.csv` reach main; the facade logged the `$.agent.list()` row and the task it read with `$.session.messages` (T2). |
| t3 | Two parallel agents and one background one. |
| t4 | `SendMessage` (to the agentId from the Agent result) resumes a finished agent: the worker runs with `--resume` and only the new message. |
| t5 | A `general-purpose` subagent in the same session still reaches the recorder with its agent id. |
| t6down, t6config | A server with nothing listening; a saved agent whose server URL is no URL: an `anymodel:` error answer (for t6config the settings problem), nothing at the recorder. |
| t7fg, t7bg, t7crash | Esc on a foreground agent, Ctrl-C exit with a background one, SIGKILL of the session: no worker left, nothing at the recorder. |
| t8 | The t1 journey in the interactive TUI (auto mode, so the report goes through `SubagentHandback`). A worker that runs over ~30 s gets the TUI's progress-summary request at the recorder under its agent id (a documented limit, README); `check.mjs` lists it as `progressSummaries`, not as a leak. |
| t9 | Main's sandbox (`--settings`) is the worker's: in `acceptEdits` its Bash cannot reach example.com or Unsloth Studio (in `bypassPermissions` the sandbox lets any domain through, for Claude too); no socket of the worker leaves the machine (lsof every 50 ms). t9auth: with a second recorder as `base_url`, every worker request carries the agent's key as `x-api-key` and no other credential. |
| t10 | `claude plugin validate` and the unit tests of `worker.js`. |
| t11 | Hooks disabled: no `anymodel:` agent is registered, so the Agent call to `anymodel:gem` fails; nothing runs under it. |
| t14ro | Main in `default` mode, headless: the worker's `echo x > planted.txt; rm -f keep.txt` asks, no one can answer, so it changes nothing in the project. |
| t14rw | Main in `acceptEdits`: the worker creates `made.txt` in the project with its Write tool; the agent's transcript has the `Write(...)` notice and the `⎿ …` line of its output. |
| t15 | A `SendMessage` sent while the local worker runs goes to the running worker, which answers both in its report. |
| t16 | Auto mode with `SubagentHandback` denied: the worker runs once, no loop. |
| t17 | Each name runs on its own model: `anymodel:other` (`local-other-x`) even when the Agent call says `model: "haiku"`, and `anymodel:gem`; the second recorder sees both model ids. |
| t18 | A `SendMessage` resume answers a question about the file the worker read in its first run (the largest debit's description); the check output shows whether it re-read the file. |
| t19 | The worker runs a `general-purpose` subagent of its own; its transcript is in the worker's session, nothing at the recorder. |
| t20 | The worker loads the project's `CLAUDE.md`: it reports a secret word that is only there, not in its task. |
| t21 | Named agents on two servers, paid, only with `ANYMODEL_OPENROUTER_KEY_FILE` (a file holding an OpenRouter key): `gem` on Unsloth Studio, `olga3` on `deepseek/deepseek-v4-flash` and `jimmy3` on `moonshotai/kimi-k3` through OpenRouter answer in one session, with context sizes read from the servers; the key is in no log, transcript or worker file. About $0.002 a run. |
| t22 | `@agent-anymodel:gem <task>`, headless: main starts the agent by name and the facade answers. |
| t23 | TUI: the `@` list shows `anymodel:gem` with its model and server; `@agent-anymodel:gem` and `@agent-anymodel:other` answer in one session. |
| t24 | An agent renamed in the saved agents, then the session resumed: a `SendMessage` to the old agent is refused ("no longer in the settings") and nothing goes out under its id. |
| t25 | TUI: the settings form saved mid-session (as by another session) reloads the plugin; the agent it names is added and answers in the same session, `/anymodel` lists it, and the form is cleared. |
| t26 | `/anymodel` headless: alone it lists `gem` with the context size read from Unsloth Studio; an unknown agent exits 1 with its error; `/anymodel gem <task>` runs the agent in main's mode (`acceptEdits`) with no main request at the recorder. |
| t27 | `/anymodel gem <task>` in the TUI, auto mode: the answer shows under the agent's model, its hand-back to main is dropped (no main turn), and main answers a follow-up about it from the transcript. |
| t28 | TUI: Esc on a running `/anymodel` stops the agent: its worker ends (`gone`), it answers `gem was stopped`, no main turn. |
| t30 | TUI, `default` mode: a worker's Write asks in the question dialog; Yes writes `asked-yes.txt`, No refuses the second Write (the debug log's permission answers are allow, then deny). |
| t31 | Main's MCP server (`fixtures/mcp-word.mjs`, in the session's user config): the agent calls its tool and reports its word. |
| t32 | A project's `.claude/settings.local.json` env (base URL, keys, headers, every proxy spelling, an API socket) does not move the worker: it reaches only its provider with the agent's key, nothing reaches the project's URL. |
| t33 | The key: `keywatch.py` finds it in no process's argv or environment during a 13+ request run (each step needs the last one's output), every request of which carries it. |
| t34 | A task of about 50k tokens (a long silent prefill on the local model) answers, no timeout cuts it. |
| t35 | `/anymodel check`: both steps pass for `gem`; for a server that is down both fail with "cannot reach http://127.0.0.1:9 (…): is its server running?", exit 1. |
| t36 | `/anymodel cleanup`: an old worker record and transcript go; a current record and an old agent mark stay. |
| t37 | An agent moved to another provider: the SendMessage resume starts a new worker there (`resume=-`), and its requests hold none of the old worker's tool results (a random marker it printed). |
| t38 | TUI: a settings change while an agent's worker runs (a 30 s `sleep`) reloads the plugin; nothing of that agent reaches the recorder. |
| t39 | A `SendMessage` written to the running worker, which is killed before it takes it: the run sends the message on to the agent, which answers it in its next run (37 negative rows). |
| t40 | A Claude Code agent definition `.claude/agents/gem.md` (its own prompt, `tools: Bash, Read`, `model: anymodel`): main calls `subagent_type "gem"`, the plugin answers it as `anymodel:gem`, and the worker's requests carry the definition's prompt, only its tools and the agent's model; nothing at the recorder. |
| tkey | After every run: the Unsloth key in no log, transcript, worker file or run directory. |

The main agent in these runs is the local model standing in for Claude, so a scenario can fail because
it did not follow the prompt (for example an Agent call without `description`, an Agent call where the
prompt says SendMessage, or a background result it does not take from its task-notification); re-run it.
The prompts that resume a subagent tell it to end its turn after `SendMessage` and read the `<result>` of
the notification.

## Files

- `recorder.mjs`: the recording stand-in cloud. `node recorder.mjs <port> <log.jsonl> [upstream=http://127.0.0.1:8888]`,
  with `UP_MODEL` (the model every request goes to) and `UP_KEY_FILE` (its key); the suite sets both. A second
  instance on port 18402 (18404) is the agents' provider in t9auth, t17, t32, t33 and t37 (`logs/<tag>.wrec.jsonl`); it
  records which credentials came (an `x-api-key` equal to its own key, any bearer, a header a project tried to add),
  never the header values. The suite stops when a recorder cannot take its port: another suite's would take its
  requests.
- `run.sh`: one isolated session, headless (`-p`, stream-json) or `--tui`.
- `pty_run.py`: drives a `--tui` session through a pty with steps (`say:`, `type:`, `exec:`, `settle`, `worker`, `esc`,
  `ctrlc`, `kill9`, `gone:<s>`, `ps`, `wait:<text>`: the screen shows text after what the last wait matched).
- `check.mjs`: the verdict for one run from the recorder log, the debug log, the transcript and the workers'
  transcripts. A request under an anymodel agent's id, or of agent type `custom` (a plugin agent; with the mod
  on only anymodel's), counts as a leak.
- `keywatch.py`: lists the processes whose arguments or environment hold a key, from `ps` every 0.3 s.
- `fixtures/mcp-word.mjs`: a stdio MCP server with one tool, `secret_word`.
- `anymodel.test.ts`: the mod's hooks under `claude plugin test`, with Claude Code, the worker and the provider stubbed.
- `netwatch.py`: records the sockets of every worker process tree. It and `pty_run.py` count only the
  workers whose cwd is `$ANYMODEL_TEST_DIR/work`, so other anymodel sessions on the machine do not interfere.
- `fixtures/statement.csv`: 40 synthetic rows for an invented account holder and IBAN, one row with
  the canary `CANARY-ANYMODEL-7Q9X` (also the largest debit, -1120.00, "Miete Ref ..."); `fixtures/expected.json`
  holds the ground truth.
