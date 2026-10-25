#!/bin/bash
# The whole suite (T1-T37) against Unsloth Studio on :8888, one PASS/FAIL line per scenario: its loaded model is the
# stand-in main (through the recorder) and the agents' model.
# Evidence: $ANYMODEL_TEST_DIR/logs/<tag>.{jsonl,debug.txt,check.json,pty.txt,net.txt,wrec.jsonl} and logs/recorder.jsonl(.bodies);
# the workers' own sessions under $ANYMODEL_TEST_DIR/home/.local/state/anymodel.
# usage: ANYMODEL_KEY_FILE=<file with the Unsloth Studio key> ANYMODEL_TEST_DIR=<fresh dir> bash suite.sh [tag...]   (no tags: all)
#        ANYMODEL_MODEL: the model id (default: the one Unsloth Studio has loaded)
set -u
here=$(cd "$(dirname "$0")" && pwd)
export ANYMODEL_TEST_DIR=${ANYMODEL_TEST_DIR:-${TMPDIR:-/tmp}/anymodel-test}
D=$ANYMODEL_TEST_DIR
mkdir -p "$D/logs"
cd "$here"
: "${ANYMODEL_KEY_FILE:?set ANYMODEL_KEY_FILE to a file holding the Unsloth Studio key}"
# The key goes in a header file (a pipe), never in argv. The loaded model is the one with a context length.
export ANYMODEL_KEY_FILE ANYMODEL_MODEL=${ANYMODEL_MODEL:-$(curl -sS -m 10 -H @<(printf 'authorization: Bearer %s\n' "$(tr -d '\n' < "$ANYMODEL_KEY_FILE")") \
  http://127.0.0.1:8888/v1/models | jq -r '[.data[] | select(.context_length != null)][0].id')}
[ -n "$ANYMODEL_MODEL" ] && [ "$ANYMODEL_MODEL" != null ] || { echo 'no model loaded in Unsloth Studio on :8888'; exit 1; }
M=$ANYMODEL_MODEL
# Every recorder sends what it records to that model, with the key.
export UP_MODEL=$M UP_KEY_FILE=$ANYMODEL_KEY_FILE
node recorder.mjs "${RECORDER_PORT:-18401}" "$D/logs/recorder.jsonl" > "$D/logs/recorder.out" 2>&1 &
recorder=$!
# The session settings hold the key (pluginConfigs): they do not outlive the suite.
trap 'kill $recorder ${wrecpid:-} 2>/dev/null; echo "{}" > "$D/cfg/settings.json"' EXIT
sleep 1
# Another suite's recorder on the port would take this one's requests: every check would read the wrong log.
kill -0 $recorder 2>/dev/null || { echo "the recorder did not start: $(tail -1 "$D/logs/recorder.out")"; exit 1; }

# A scenario's block is its first tag: a FAIL of any of its checks runs the block once more (see the end).
block=; retry=
want() { block=$tag; [ $# -eq 0 ] || [[ " $* " == *" $tag "* ]]; }
failed=0
verdict() {
  if [ "$1" = 0 ]; then echo "PASS $tag $2"; else
    echo "FAIL $tag $2"; failed=$((failed + 1)); [[ " $retry " == *" $block "* ]] || retry+=" $block"
  fi
}
# A headless run that did not exit 0 (the 300 s cap, a crash) fails its scenario whatever check.mjs says.
rc=0
run() { bash run.sh "$@"; rc=$?; }
check() { node check.mjs "$tag" "$@" > "$D/logs/$tag.check.json"; local v=$?; [ $rc = 0 ] || v=1; verdict $v "(exit=$rc, logs/$tag.check.json)"; rc=0; }
# A second recorder as the workers' base_url, forwarding to Unsloth Studio: logs/<tag>.wrec.jsonl.
wrec() {
  node recorder.mjs "${1:-18402}" "$D/logs/$tag.wrec.jsonl" > "$D/logs/$tag.wrec.out" 2>&1 & wrecpid=$!; sleep 1
  kill -0 $wrecpid 2>/dev/null || { echo "the workers' recorder did not start: $(tail -1 "$D/logs/$tag.wrec.out")"; exit 1; }
}
# The agent "gem" on the server at $1, with the key (its context size given: $1 may not list models), as run.sh's
# ANYMODEL_AGENTS; $2 adds agents on that server, as JSON object members ("other": {"model": ...}).
agents() {
  jq -nc --rawfile k "$ANYMODEL_KEY_FILE" --arg u "$1" --arg m "$M" --argjson more "{${2:-}}" \
    '{agents: ({gem: {url: $u, model: $m, context: 131072}} + ($more | map_values({url: $u} + .))), keys: {($u): ($k | rtrimstr("\n"))}}'
}
# The screen's text, as screen() compares it, for gem's model on Unsloth Studio.
via=$(printf '%s' "${M}via127.0.0.1:8888" | tr -d '[:space:]')
private='statement.csv in the current directory is private: do not read it yourself.'
rows='Count the data rows (excluding the header) of statement.csv using the Bash tool and answer with just the number.'
# A TUI run's screen, escapes and whitespace removed, contains $1.
screen() { python3 -c "import re,sys; t=re.sub(r'\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\s', '', open(sys.argv[1], errors='replace').read()); sys.exit(0 if sys.argv[2] in t else 1)" "$D/logs/$tag.pty.txt" "$1"; }
totals='a prompt asking for the total of all positive amount_eur values, the total of all negative amount_eur values and the net change in statement.csv'

tag=t1; want "$@" && {  # T1 delegation, T2 introspection (agent row and task text in the debug log, checked by check.mjs)
  run $tag "$private Call the Agent tool once with description \"statement totals\", subagent_type \"anymodel:gem\", run_in_background false and $totals. Then tell me the three numbers."
  check --expect 7964.25 --expect 4967.87 --expect 2996.38 --expect-main 7964.25 --expect-main 4967.87 --expect-main 2996.38; }

tag=t3; want "$@" && {  # parallel and background
  run $tag "$private In ONE assistant message make THREE Agent tool calls, each with a description and subagent_type \"anymodel:gem\": (1) with run_in_background false: the total of all positive amount_eur values in statement.csv; (2) with run_in_background false: the total of all negative amount_eur values in statement.csv; (3) with run_in_background true: the number of rows in statement.csv whose amount_eur is negative. When all three have answered, report the three results."
  check --locals 3 --expect 7964.25 --expect 4967.87 --expect '\b37\b' --expect-main 7964.25 --expect-main 4967.87 --expect-main '\b37\b'; }

tag=t4; want "$@" && {  # SendMessage resume
  run $tag "$private Step 1: call the Agent tool with description \"ledger\", subagent_type \"anymodel:gem\", name \"ledger\", run_in_background false, asking for the total of all positive amount_eur values in statement.csv. Step 2: the Agent tool result gives the subagent's agentId. Do NOT call the Agent tool again: use the SendMessage tool with to set to that agentId to ask that same subagent for the total of all negative amount_eur values in statement.csv. After the SendMessage call do not call any tool: end your turn and wait. The answer arrives later in a task-notification; its <result> element is the subagent's answer. Then report both numbers."
  check --expect 7964.25 --expect 4967.87 --resumes 1 --expect-main 7964.25 --expect-main 4967.87; }

tag=t5; want "$@" && {  # a general-purpose subagent in the same session still uses the session's backend
  run $tag "$private Make two Agent tool calls, both with run_in_background false: (a) description \"credits\", subagent_type \"anymodel:gem\", asking for the total of all positive amount_eur values in statement.csv; (b) description \"math\", subagent_type \"general-purpose\", asking: what is 17 * 23? Report both answers."
  check --expect 7964.25 --others 1 --expect-main 7964.25 --expect-main '\b391\b'; }

tag=t6down; want "$@" && {  # backend down: nothing listens on the configured port
  ANYMODEL_AGENTS=$(agents http://127.0.0.1:9) run $tag "$private Call the Agent tool once with description \"sum credits\", subagent_type \"anymodel:gem\", run_in_background false and a prompt asking for the total of all positive amount_eur values in statement.csv. If the subagent answers with a message starting with \"anymodel:\", report that message exactly and stop without retrying."
  check --error 'ECONNREFUSED|Connection refused'; }

tag=t6config; want "$@" && {  # a settings error: the agent still exists and answers with it
  ANYMODEL_AGENTS='{"agents":{"gem":{"url":"nowhere","model":"some-model"}},"keys":{}}' run $tag "$private Call the Agent tool once with description \"sum credits\", subagent_type \"anymodel:gem\", run_in_background false and a prompt asking for the total of all positive amount_eur values in statement.csv. If the subagent answers with a message starting with \"anymodel:\", report that message exactly and stop without retrying."
  check --error 'settings need fixing.*the server URL must start with http:// or https://'; }

slow='Call the Agent tool once with description "slow job", subagent_type "anymodel:gem"'
sleeper='this prompt: "Use the Bash tool to run exactly this command: sleep 90; echo finished -- then report its output."'
tag=t7fg; want "$@" && {  # Esc while a foreground local subagent runs (the TUI runs subagents in the background unless this is set at launch)
  EXTRA_ENV=CLAUDE_CODE_FORK_SUBAGENT=0 python3 -I pty_run.py $tag "say:$slow, run_in_background false and $sleeper Wait for it." worker sleep:4 esc gone:5 \
    > "$D/logs/$tag.out"; verdict $? "(logs/$tag.out)"; check; }

tag=t7bg; want "$@" && {  # Esc leaves a background subagent running (by design); Ctrl-C twice exits the session
  python3 -I pty_run.py $tag "say:$slow and $sleeper" worker sleep:4 esc sleep:3 ps ctrlc sleep:0.5 ctrlc gone:10 > "$D/logs/$tag.out"; verdict $? "(logs/$tag.out)"; check; }

tag=t7crash; want "$@" && {  # the session is SIGKILLed while the worker runs
  python3 -I pty_run.py $tag "say:$slow and $sleeper" worker sleep:6 kill9 gone:10 > "$D/logs/$tag.out"; verdict $? "(logs/$tag.out)"; check; }

tag=t8; want "$@" && {  # the T1 journey in the TUI, in auto mode
  # As in t16: main's own auto-mode classifier can time out on the local main a few times before a call passes.
  TUI_ARGS='--permission-mode auto' QUIET=15 SETTLE=900 python3 -I pty_run.py $tag "say:$private Call the Agent tool once with description \"statement totals\", subagent_type \"anymodel:gem\" and $totals. If auto mode refuses the Agent call as unavailable, make the same call again, up to six times. Then tell me the three numbers." settle sleep:3 > "$D/logs/$tag.out"
  check --expect 7964.25 --expect 4967.87 --expect 2996.38 --expect-main 7964.25 --expect-main 4967.87 --expect-main 2996.38; }

tag=t9; want "$@" && {  # main's sandbox is the worker's: in acceptEdits its shell reaches no network (in bypassPermissions any domain goes, as for Claude); no socket leaves the machine
  python3 -I netwatch.py "$D/logs/$tag.net.txt" 240 > "$D/logs/$tag.netwatch.out" &
  watch=$!
  PERMS='--permission-mode acceptEdits --allowedTools Agent' run $tag 'Call the Agent tool once with description "network check", subagent_type "anymodel:gem", run_in_background false and this prompt: "Use the Bash tool to run exactly this command: curl -sS -m 10 https://example.com -o /dev/null; echo EXIT=$?; curl -sS -m 5 http://127.0.0.1:8888/v1/models -o /dev/null; echo EXIT2=$? -- then report only the two lines that start with EXIT." Then report what the subagent said.' \
    --settings '{"sandbox":{"enabled":true,"allowUnsandboxedCommands":false}}'
  wait $watch
  other=$(grep -vE '\(LISTEN\)$|->127\.0\.0\.1:[0-9]+ \(ESTABLISHED\)$' "$D/logs/$tag.net.txt")
  check --expect 'EXIT=[1-9]' --expect 'EXIT2=[1-9]'
  grep -q . "$D/logs/$tag.net.txt" && [ -z "$other" ]; verdict $? "no socket off this machine (logs/$tag.net.txt)"
  tag=t9auth; wrec  # the worker's only credential is the agent's key, as x-api-key
  ANYMODEL_AGENTS=$(agents http://127.0.0.1:18402) run $tag "$private Call the Agent tool once with description \"rows\", subagent_type \"anymodel:gem\", run_in_background false and a prompt asking for the number of data rows in statement.csv. Then report what it said."
  kill $wrecpid; check --expect '\b40\b' --wrec; }

tag=t10; want "$@" && {
  claude plugin validate "$here/.." > "$D/logs/$tag.validate.txt" 2>&1; verdict $? "plugin validate (logs/$tag.validate.txt)"
  node --test "$here"/*.test.js > "$D/logs/$tag.unit.txt" 2>&1; verdict $? "unit tests (logs/$tag.unit.txt)"; }

tag=t11; want "$@" && {  # hooks disabled: no anymodel agent exists, so none can run; the Agent tool says so
  run $tag 'Call the Agent tool once with exactly this input: {"description": "sum credits", "subagent_type": "anymodel:gem", "run_in_background": false, "prompt": "Report the total of all positive amount_eur values in statement.csv."}. If the Agent tool fails, report its error exactly and stop.' --settings '{"disableAllHooks":true}'
  check --locals 0 --mod-off
  grep -q 'not loaded: only managed plugins' "$D/logs/$tag.debug.txt" && ! grep -q 'anymodel: registered' "$D/logs/$tag.debug.txt" &&
    grep -q "anymodel:gem" <(jq -c 'select(.type=="user") | .message.content[]? | select(.type=="tool_result" and .is_error==true)' "$D/logs/$tag.jsonl")
  verdict $? "mod off: no agent registered, the Agent call failed"; }

tag=t14ro; want "$@" && {  # main in default mode: the worker cannot write or delete in the project
  mkdir -p "$D/work" && echo 'keep me' > "$D/work/keep.txt" && rm -f "$D/work/planted.txt"
  PERMS='--permission-mode default --allowedTools Agent' run $tag 'Call the Agent tool once with description "files", subagent_type "anymodel:gem", run_in_background false and this prompt: "Use the Bash tool to run exactly this command: echo x > planted.txt; rm -f keep.txt; ls -- then report the exit status." Then report what it said.'
  check --task-mode default; [ -f "$D/work/keep.txt" ] && [ ! -e "$D/work/planted.txt" ]; verdict $? "keep.txt kept, planted.txt not created"; }

tag=t14rw; want "$@" && {  # main in acceptEdits: the worker writes in the project with its Write tool
  rm -f "$D/work/made.txt"
  PERMS='--permission-mode acceptEdits --allowedTools Agent' run $tag 'Call the Agent tool once with description "write file", subagent_type "anymodel:gem", run_in_background false and this prompt: "Use the Write tool to create the file made.txt in the current directory with the single line written-by-local as its whole content. Then report done." Then report what it said.'
  check --task-mode acceptEdits --worker-tool Write --notice '^Write\(' --notice '^⎿ '; grep -qx 'written-by-local' "$D/work/made.txt"; verdict $? "made.txt written (work/made.txt)"; }

tag=t15; want "$@" && {  # a SendMessage that arrives while the local worker runs goes to the worker, which answers it in the same run
  run $tag "$private Call the Agent tool with description \"slow\", name \"slow\", subagent_type \"anymodel:gem\", run_in_background true and this prompt: \"Use the Bash tool to run exactly this command: sleep 25; echo first-done -- then report its output.\" Right after launching it, while it still runs, use the SendMessage tool with to set to \"slow\" and the message: Also report the number of rows of statement.csv whose amount_eur is negative. After the SendMessage call do not call any tool: end your turn and wait. The answers arrive later in task-notifications; each <result> element is an answer of the subagent. Then report them."
  check --expect first-done --expect '\b37\b'
  grep -q 'anymodel: message to the running worker' "$D/logs/$tag.debug.txt"; verdict $? "the message went to the running worker"; }

tag=t16; want "$@" && {  # auto mode with SubagentHandback refused: the later steps repeat the report, no worker re-run
  # Main's own auto-mode classifier sends about 35k tokens to the local main, which can take it over its 60 s limit a few
  # times before a call passes, so main retries it. With the hand-back refused, main is told no report came and would
  # resume the agent again and again, so it is told to stop once the Agent call returns.
  RUN_TIMEOUT=900 PERMS='--permission-mode auto' run $tag "$private Call the Agent tool once with description \"sum credits\", subagent_type \"anymodel:gem\", run_in_background false and a prompt asking for the total of all positive amount_eur values in statement.csv. If auto mode refuses the Agent call as unavailable, make the same call again, up to six times. Once it returns, do not call any tool: report what it said, or that no report came." --settings '{"permissions":{"deny":["SubagentHandback"]}}'
  check --expect 7964.25; }

tag=t17; want "$@" && {  # each name runs on its own model, whatever model the Agent call names; the backend env follows
  wrec
  ANYMODEL_AGENTS=$(agents http://127.0.0.1:18402 '"other": {"model": "local-other-x", "context": 65536}') run $tag "$private Make two Agent tool calls, one after the other, both with run_in_background false: (a) description \"rows other\", subagent_type \"anymodel:other\", model \"haiku\", asking for the number of data rows in statement.csv; (b) description \"rows gem\", subagent_type \"anymodel:gem\", with no model parameter, asking the same. Then report both answers."
  # The routing is the test: an answer counts with or without the header line, as main's brief may put it.
  kill $wrecpid; check --locals 2 --expect '\b4[01]\b' --task-name other --task-name gem --task-model local-other-x --task-model "$M" --wrec --wrec-model local-other-x --wrec-model "$M"; }

tag=t18; want "$@" && {  # a SendMessage resume continues the worker session: it answers from what it read in the first run
  run $tag "$private Step 1: call the Agent tool with description \"rows\", subagent_type \"anymodel:gem\", name \"rows\", run_in_background false and this prompt: \"Use the Read tool to read statement.csv, then report only the number of data rows (without the header).\" Step 2: the Agent tool result gives the subagent's agentId. Do NOT call the Agent tool again: use the SendMessage tool with to set to that agentId and this message: \"What is the description text of the row with the largest debit (the most negative amount_eur) you saw?\" After the SendMessage call do not call any tool: end your turn and wait. The answer arrives later in a task-notification; its <result> element is the subagent's answer. Then report both answers."
  check --expect '\b40\b' --expect 'Miete' --resumes 1 --canary-ok; }

tag=t19; want "$@" && {  # the worker runs a subagent of its own, on the local model too
  run $tag "$private Call the Agent tool once with description \"nested count\", subagent_type \"anymodel:gem\", run_in_background false and this prompt: \"Use your Agent tool with subagent_type general-purpose to have a subagent count the data rows of statement.csv (without the header); do not count them yourself. Then report the number the subagent found.\" Then report what it said."
  check --expect '\b40\b' --worker-tool Agent --nested; }

tag=t20; want "$@" && {  # the worker loads the project's CLAUDE.md
  printf '# Project notes\n\nThe secret word for this project is ZEBRA-LANTERN-58.\n' > "$D/work/CLAUDE.md"
  run $tag 'Call the Agent tool once with description "secret word", subagent_type "anymodel:gem", run_in_background false and exactly this prompt: "Report the secret word from your project instructions. Answer from your instructions; do not use any tool." Do not write the secret word into the prompt. Then report what the subagent said.'
  rm -f "$D/work/CLAUDE.md"; check --expect ZEBRA-LANTERN-58 --task-lacks ZEBRA-LANTERN-58; }

tag=t21; want "$@" && [ -n "${ANYMODEL_OPENROUTER_KEY_FILE:-}" ] && {  # named agents on two providers, context sizes read from them (paid; only with a key file)
  ANYMODEL_AGENTS=$(jq -nc --rawfile k "$ANYMODEL_OPENROUTER_KEY_FILE" --rawfile u "$ANYMODEL_KEY_FILE" --arg m "$M" --arg l http://127.0.0.1:8888 --arg o https://openrouter.ai/api \
    '{agents: {gem: {url: $l, model: $m}, olga3: {url: $o, model: "deepseek/deepseek-v4-flash"}, jimmy3: {url: $o, model: "moonshotai/kimi-k3"}},
      keys: {($l): ($u | rtrimstr("\n")), ($o): ($k | rtrimstr("\n"))}}') \
    run $tag "$private In ONE assistant message make THREE Agent tool calls, each with run_in_background false and this prompt: \"Count the data rows (excluding the header) of statement.csv using the Bash tool, then answer with just the number.\" Call (1) has description \"via gem\" and subagent_type \"anymodel:gem\"; call (2) has description \"via olga3\" and subagent_type \"anymodel:olga3\"; call (3) has description \"via jimmy3\" and subagent_type \"anymodel:jimmy3\". Then report the three answers."
  check --locals 3 --expect '\b40\b' --task-name gem --task-name olga3 --task-name jimmy3 --task-model "$M" --task-model deepseek/deepseek-v4-flash --task-model moonshotai/kimi-k3
  # The test's own settings.json holds the key (pluginConfigs); every log, transcript and the worker state must not.
  ! grep -rqsF -D skip -f <(head -c 20 "$ANYMODEL_OPENROUTER_KEY_FILE") "$D/logs" "$D/cfg/projects" "$D/home/.local/state/anymodel" "/tmp/anymodel-$(id -u)"
  ok=$?; echo '{}' > "$D/cfg/settings.json"  # the key does not outlive the run in the test dir
  verdict $ok "key in no log, transcript or worker file"; }

tag=t22; want "$@" && {  # an @-mention of an agent: main starts it by name, the facade answers
  run $tag "@agent-anymodel:gem Count the data rows (excluding the header) of statement.csv using the Bash tool and answer with just the number. Do not run any tool yourself."
  check --locals 1 --expect '\b40\b' --task-name gem; }

tag=t23; want "$@" && {  # TUI: the @ list offers each agent with its model; two agents called by @-mention in one session
  ANYMODEL_AGENTS=$(agents http://127.0.0.1:8888 '"other": {"model": "local-other-x", "context": 65536}') QUIET=15 python3 -I pty_run.py $tag 'type:@ge' sleep:3 'type:'$'\x7f\x7f\x7f' sleep:1 \
    'say:@agent-anymodel:gem Count the data rows (excluding the header) of statement.csv using the Bash tool and answer with just the number. Do not run any tool yourself.' settle \
    'say:@agent-anymodel:other Report the total of all positive amount_eur values in statement.csv, just the number. Do not run any tool yourself.' settle sleep:3 > "$D/logs/$tag.out"
  check --locals 2 --expect '\b40\b' --expect 7964.25 --task-name gem --task-name other --task-model local-other-x
  screen "anymodel:gem(agent)–${via:0:30}"
  verdict $? "the @ list shows anymodel:gem with its model"; }

tag=t24; want "$@" && {  # an agent removed from the settings: a message to it is refused, never run on the Claude backend
  tag=t24a; run $tag "Call the Agent tool once with description \"rows\", subagent_type \"anymodel:gem\", run_in_background false and a prompt asking for the number of data rows in statement.csv. Then report the agent's answer and its agentId."
  sid=$(jq -r 'select(.type=="system" and .subtype=="init") | .session_id' "$D/logs/t24a.jsonl" | head -1)
  aid=$(grep -o 'anymodel: task agent=[a-z0-9]*' "$D/logs/t24a.debug.txt" | head -1 | sed 's/.*agent=//')
  check --locals 1 --expect '\b40\b'
  # The same session, resumed after gem was renamed: its agent type is gone, the agent id is not.
  tag=t24b; ANYMODEL_AGENTS=$(agents http://127.0.0.1:8888 | jq -c '.agents |= {gem2: .gem}') run $tag "Use the SendMessage tool to send the message \"How many rows have a positive amount_eur?\" to the agent $aid. Then report exactly what came back, error or answer." --resume "$sid"
  [ -n "$aid" ] && grep -q 'no longer in the settings' "$D/logs/t24b.jsonl" && ! grep "\"run\":\"t24b\"" "$D/logs/recorder.jsonl" | grep -q "\"agent\":\"$aid\""
  verdict $? "the renamed agent $aid refused, nothing under its id at the recorder"; tag=t24; }

tag=t25; want "$@" && {  # TUI: a settings form saved outside the session (as by another one) reloads the plugin, which adds the agent
  QUIET=15 python3 -I pty_run.py $tag \
    'say:@agent-anymodel:gem Count the data rows (excluding the header) of statement.csv using the Bash tool and answer with just the number. Do not run any tool yourself.' settle \
    "exec:jq --arg m '$M' '.pluginConfigs[\"anymodel@inline\"].options += {agent: \"gem2\", url: \"http://127.0.0.1:8888\", model: \$m}' '$D/cfg/settings.json' > '$D/cfg/settings.new' && mv '$D/cfg/settings.new' '$D/cfg/settings.json'" sleep:8 \
    'say:@agent-anymodel:gem2 Report the total of all positive amount_eur values in statement.csv, just the number. Do not run any tool yourself.' settle 'say:/anymodel' sleep:3 > "$D/logs/$tag.out"
  check --locals 2 --expect '\b40\b' --expect 7964.25 --task-name gem --task-name gem2
  form=$(jq -c '.pluginConfigs["anymodel@inline"].options | del(.api_key)' "$D/cfg/settings.json")
  screen "gem2${M}athttp://127.0.0.1:8888" && [ "$form" = '{"agent":"","url":"","model":""}' ]
  verdict $? "/anymodel lists the agent the form added, and the form is cleared (form: $form)"; }


tag=t26; want "$@" && {  # /anymodel: alone it lists the agents; with an agent and a task it runs it in main's mode, with no Claude turn
  run t26list '/anymodel'; list_rc=$rc
  # A headless command's exit code applies to text output; stream-json exits 0.
  run t26bad '/anymodel nobody count the rows' --output-format text; bad_rc=$rc; rc=0
  [ $list_rc = 0 ] && jq -r 'select(.type=="result") | .result' "$D/logs/t26list.jsonl" | grep -qF "gem  $M at http://127.0.0.1:8888, context 262144 (read from 127.0.0.1:8888), key set" &&
    [ $bad_rc = 1 ] && grep -qxF 'anymodel: no agent named "nobody"; yours are gem (/anymodel lists them)' "$D/logs/t26bad.jsonl" &&
    ! grep -qsE '"run":"t26(list|bad)"' "$D/logs/recorder.jsonl"
  verdict $? "/anymodel lists gem, an unknown agent exits 1 with its error, nothing at the recorder"
  PERMS='--permission-mode acceptEdits' run $tag "/anymodel gem $rows"
  check --locals 1 --expect '\b40\b' --expect-main '\b40\b' --task-name gem --task-mode acceptEdits --sent "$rows" --max-main 0; }

tag=t27; want "$@" && {  # TUI, auto mode: /anymodel shows the answer, the agent's hand-back to main is dropped, and Claude reads the answer later
  TUI_ARGS='--permission-mode auto' QUIET=15 python3 -I pty_run.py $tag "say:/anymodel gem $rows" settle \
    'say:What number did gem answer? Reply with just the number.' settle sleep:3 > "$D/logs/$tag.out"
  # The one main request is the follow-up's: a hand-back that got through would add one.
  check --locals 1 --expect '\b40\b' --expect-main '\b40\b' --task-name gem --task-mode auto --sent "$rows" --max-main 1
  screen "gem($via):"
  verdict $? "the TUI shows gem's answer under its model"; }

tag=t28; want "$@" && {  # TUI: Esc on a running /anymodel stops the agent, as for a subagent in the foreground: its worker ends, no Claude turn
  slow="First run the Bash command: sleep 60. Then $rows"
  # Esc puts the command back in the prompt: Ctrl-U clears it, so the session's closing /exit does not run it again.
  TUI_ARGS='--permission-mode auto' QUIET=15 python3 -I pty_run.py $tag "say:/anymodel gem $slow" worker sleep:15 esc gone:20 sleep:2 $'type:\x15' sleep:5 > "$D/logs/$tag.out"
  stopped=$?
  check --locals 1 --error 'gem was stopped' --sent "$slow" --max-main 0
  [ $stopped = 0 ] && grep -q 'command.run settled' "$D/logs/$tag.debug.txt" && ! grep -q 'hook failed: anymodel' "$D/logs/$tag.debug.txt"
  verdict $? "Esc stopped gem's worker without a hook failure"; }

tag=t30; want "$@" && {  # TUI, default mode: a worker's tool use main would ask about goes to the person in the question dialog; yes runs it, no refuses it
  rm -f "$D/work/asked-yes.txt" "$D/work/asked-no.txt"
  yes='Use the Write tool to create the file asked-yes.txt in the current directory with the content yes, then report done.'
  no='Use the Write tool to create the file asked-no.txt in the current directory with the content no, then report done. If the Write tool is refused, do not create the file any other way: report refused.'
  # The dialog: 1. Yes, 2. No (Write gets no rule to allow again), then free text.
  TUI_ARGS='--permission-mode default' QUIET=15 python3 -I pty_run.py $tag \
    "say:/anymodel gem $yes" 'wait:wantstouseWrite(' sleep:1 'type:1' sleep:1 enter 'wait:via127.0.0.1:8888):' sleep:3 \
    "say:/anymodel gem $no" 'wait:wantstouseWrite(' sleep:1 'type:2' sleep:1 enter 'wait:via127.0.0.1:8888):' sleep:5 > "$D/logs/$tag.out"
  asked=$?
  check --locals 2 --task-mode default --max-main 0 --sent "$yes" --sent "$no"
  # The person's answers, in order: Bash is allowed by the TUI's --allowedTools, so a model could still write with it.
  [ $asked = 0 ] && [ -f "$D/work/asked-yes.txt" ] &&
    [ "$(grep -o 'tool=Write check=ask answer=[a-z]*' "$D/logs/$tag.debug.txt" | tr '\n' ' ')" = 'tool=Write check=ask answer=allow tool=Write check=ask answer=deny ' ]
  verdict $? "the dialog asked twice; yes wrote asked-yes.txt, no refused the second Write"; }

tag=t31; want "$@" && {  # main's MCP servers: an agent calls a tool of a server in main's user config
  [ -f "$D/cfg/.claude.json" ] || echo '{}' > "$D/cfg/.claude.json"
  jq --arg node "$(command -v node)" --arg srv "$here/fixtures/mcp-word.mjs" '.mcpServers = {word: {type: "stdio", command: $node, args: [$srv]}}' "$D/cfg/.claude.json" > "$D/cfg/.claude.json.new" && mv "$D/cfg/.claude.json.new" "$D/cfg/.claude.json"
  MAIN_MCP=1 run $tag 'Call the Agent tool once with description "mcp word", subagent_type "anymodel:gem", run_in_background false and this prompt: "Call the MCP tool mcp__word__secret_word (load it with ToolSearch first if it is deferred) and report exactly the text it returned." Then report what the subagent said.'
  jq 'del(.mcpServers)' "$D/cfg/.claude.json" > "$D/cfg/.claude.json.new" && mv "$D/cfg/.claude.json.new" "$D/cfg/.claude.json"
  check --expect MCP-OTTER-41 --worker-tool mcp__word__secret_word; }

tag=t32; want "$@" && {  # a project's env cannot send the worker's requests, or other credentials, elsewhere
  wrec; node recorder.mjs 18403 "$D/logs/$tag.trap.jsonl" > "$D/logs/$tag.trap.out" 2>&1 & trapped=$!; sleep 1
  mkdir -p "$D/work/.claude"
  # Every proxy spelling (the provider is http://), and a socket that would take the requests if it were not pinned.
  printf '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:18403","ANTHROPIC_API_KEY":"sk-trap","ANTHROPIC_AUTH_TOKEN":"trap","ANTHROPIC_CUSTOM_HEADERS":"x-trap: 1","HTTPS_PROXY":"http://127.0.0.1:18403","https_proxy":"http://127.0.0.1:18403","HTTP_PROXY":"http://127.0.0.1:18403","http_proxy":"http://127.0.0.1:18403","ALL_PROXY":"http://127.0.0.1:18403","all_proxy":"http://127.0.0.1:18403","NO_PROXY":"","no_proxy":"","ANTHROPIC_UNIX_SOCKET":"/nonexistent/anymodel-trap.sock"}}' > "$D/work/.claude/settings.local.json"
  # Main reads its user settings only, so the project's env reaches the worker alone.
  ANYMODEL_AGENTS=$(agents http://127.0.0.1:18402) run $tag "$private Call the Agent tool once with description \"rows\", subagent_type \"anymodel:gem\", run_in_background false and this prompt: \"$rows\" Then report what it said." --setting-sources user
  rm -f "$D/work/.claude/settings.local.json"; kill $wrecpid $trapped
  check --expect '\b40\b' --wrec; [ ! -s "$D/logs/$tag.trap.jsonl" ]; verdict $? "nothing at the project's base URL"; }

tag=t33; want "$@" && {  # the key: on fd 4 only, in no process's arguments or environment, and read for every request of a long run
  wrec
  python3 -I keywatch.py "$ANYMODEL_KEY_FILE" 200 "$D/logs/$tag.keywatch.txt" & watch=$!
  ANYMODEL_AGENTS=$(agents http://127.0.0.1:18402) run $tag "/anymodel gem Use the Bash tool twelve times, one call at a time: first run echo step-1; then each time run echo step-N with N one more than the number the last call printed, until it prints step-12. Then report the output of the last one."
  kill $wrecpid; wait $watch; seen=$?
  check --locals 1 --expect step-12 --wrec --sent "Use the Bash tool twelve times, one call at a time"
  [ $seen = 0 ] && [ "$(grep -c '"method":"POST"' "$D/logs/$tag.wrec.jsonl")" -ge 13 ]; verdict $? "key in no argv or env (logs/$tag.keywatch.txt), 13+ requests with it"; }

tag=t34; want "$@" && {  # a long silent prefill (a task of about 40k tokens on the local model) is not cut by a timeout
  big=$(python3 -c "print(' '.join(f'Line {i}: the quick brown fox jumps over the lazy dog near the river bank.' for i in range(2800)) + ' The code word is HERON-77.')")
  RUN_TIMEOUT=1500 run $tag "/anymodel gem At the end of this text is a code word. Reply with only the code word. $big"
  check --locals 1 --expect HERON-77 --sent 'At the end of this text is a code word'; }

tag=t35; want "$@" && {  # /anymodel check: each step of a working agent passes; for a provider that is down, each says so
  run $tag '/anymodel check' --output-format text; ok_rc=$rc
  ANYMODEL_AGENTS=$(agents http://127.0.0.1:9) run t35down '/anymodel check' --output-format text; down_rc=$rc; rc=0
  [ $ok_rc = 0 ] && grep -qE '(^|: )gem  context [0-9]+ \(read from 127\.0\.0\.1:8888\) ok \([0-9]+ ms\), tool call ok \([0-9]+ ms\)$' "$D/logs/$tag.jsonl" &&
    [ $down_rc = 1 ] && grep -qE '(^|: )gem  context FAILED: cannot reach http://127\.0\.0\.1:9 \(.*\): is its server running\?, tool call FAILED: cannot reach http://127\.0\.0\.1:9 \(.*\): is its server running\?$' "$D/logs/t35down.jsonl"
  verdict $? "check passes gem, and fails both steps of a server that is down"; }

tag=t36; want "$@" && {  # /anymodel cleanup: old worker records and transcripts go; this session's records and every agent mark stay
  S="$D/home/.local/state/anymodel"; mkdir -p "$S/sessions" "$S/agents" "$S/config/projects/old"
  touch -t 202001010000 "$S/sessions/OLD-x1" "$S/config/projects/old/old.jsonl" "$S/agents/old-x1"
  touch "$S/sessions/NEW-x2"
  run $tag '/anymodel cleanup' --output-format text
  [ ! -e "$S/sessions/OLD-x1" ] && [ ! -e "$S/config/projects/old/old.jsonl" ] && [ -e "$S/sessions/NEW-x2" ] && [ -e "$S/agents/old-x1" ] &&
    grep -q 'Removed 1 worker session record(s) and 1 worker transcript file(s) older than 30 days' "$D/logs/$tag.jsonl"
  verdict $? "old records gone, current ones and the marks kept"; }

tag=t37; want "$@" && {  # an agent moved to another provider starts a new worker there: its old worker's tool results stay behind
  tag=t37a; wrec
  ANYMODEL_AGENTS=$(agents http://127.0.0.1:18402) run $tag 'Call the Agent tool once with description "marker", subagent_type "anymodel:gem", run_in_background false and this prompt: "Use the Bash tool to run exactly this command: echo MARKER-$RANDOM$RANDOM -- then report its output." Then report the agent answer and its agentId.'
  kill $wrecpid; check --expect 'MARKER-[0-9]+'
  marker=$(grep -rhoE 'MARKER-[0-9]+' "$D/logs/t37a.wrec.jsonl.bodies" | sort -u | head -1)
  sid=$(jq -r 'select(.type=="system" and .subtype=="init") | .session_id' "$D/logs/t37a.jsonl" | head -1)
  aid=$(grep -o 'anymodel: task agent=[a-z0-9]*' "$D/logs/t37a.debug.txt" | head -1 | sed 's/.*agent=//')
  tag=t37b; wrec 18404
  ANYMODEL_AGENTS=$(agents http://127.0.0.1:18404) run $tag "Use the SendMessage tool to send the message \"How many data rows does statement.csv have? Count them with the Bash tool.\" to the agent $aid. After the SendMessage call do not call any tool: end your turn and wait. The answer arrives later in a task-notification; its <result> element is the agent's answer. Then report it." --resume "$sid"
  kill $wrecpid; check --expect '\b40\b'
  [ -n "$aid" ] && grep -q "anymodel: task agent=$aid .* resume=- " "$D/logs/t37b.debug.txt" && [ -s "$D/logs/t37b.wrec.jsonl" ] && [ -n "$marker" ] && ! grep -rqsF "$marker" "$D/logs/t37b.wrec.jsonl.bodies"
  verdict $? "a new worker on the new provider, without the old worker's results"; tag=t37; }

tag=t38; want "$@" && {  # TUI: a settings change while an agent's worker runs reloads the plugin; the agent's step never reaches Claude
  QUIET=15 python3 -I pty_run.py $tag \
    'say:@agent-anymodel:gem Use the Bash tool to run exactly this command: sleep 30; echo slept-done -- then report its output. Do not run any tool yourself.' worker sleep:5 \
    "exec:sed -i.bak 's/@131072/@131000/' '$D/cfg/settings.json'" settle sleep:5 > "$D/logs/$tag.out"
  check --locals 1; }

tag=t39; want "$@" && {  # a SendMessage the worker never took (killed first) goes to the agent as any other, which answers it in its next run
  bash run.sh $tag "$private Call the Agent tool with description \"slow\", name \"slow\", subagent_type \"anymodel:gem\", run_in_background true and this prompt: \"Use the Bash tool to run exactly this command: sleep 40; echo first-done -- then report its output.\" Right after launching it, while it still runs, use the SendMessage tool with to set to \"slow\" and the message: Also report the number of rows of statement.csv whose amount_eur is negative. After the SendMessage call do not call any tool: end your turn and wait. The answers arrive later in task-notifications; each <result> element is an answer of the subagent. Then report them." &
  runpid=$!
  # Once the message is in the worker's FIFO, while its Bash still sleeps, the worker dies.
  for _ in $(seq 360); do grep -qs 'anymodel: message to the running worker' "$D/logs/$tag.debug.txt" && break; sleep 0.5; done
  sleep 2; for f in "/tmp/anymodel-$(id -u)"/run-*/pid; do [ -f "$f" ] && kill -9 "$(cat "$f")"; done
  wait $runpid; rc=$?
  check --expect '\b37\b'
  grep -q 'anymodel: message sent on agent=[a-z0-9]* delivered=true' "$D/logs/$tag.debug.txt"; verdict $? "the untaken message went to the agent again"; }

tag=t40; want "$@" && {  # a Claude Code agent definition named like the agent: Claude calls it by that name, and it runs as the definition on the agent's model, never on Claude
  mkdir -p "$D/work/.claude/agents"
  printf '%s\n' '---' 'name: gem' 'description: Answers questions about statement.csv in the current directory' 'tools: Bash, Read' 'model: anymodel' '---' \
    'You are the statement agent GEM-DEF-7. Answer the question you are given, briefly.' > "$D/work/.claude/agents/gem.md"
  wrec
  ANYMODEL_AGENTS=$(agents http://127.0.0.1:18402) run $tag "$private Call the Agent tool once with description \"rows\", subagent_type \"gem\", run_in_background false and the prompt \"How many data rows (excluding the header) does statement.csv have? Count them with the Bash tool.\" Then report what it said."
  kill $wrecpid; rm -f "$D/work/.claude/agents/gem.md"
  check --locals 1 --expect '\b40\b' --task-name gem --wrec
  # The worker's requests: the definition's prompt, only its tools, the agent's model and not the definition's.
  node -e 'const fs = require("fs"), [d, model] = process.argv.slice(1)
    const bodies = fs.readdirSync(d).map(f => JSON.parse(fs.readFileSync(`${d}/${f}`, "utf8") || "{}")).filter(b => b.messages)
    const tools = b => (b.tools ?? []).map(t => t.name)
    process.exit(bodies.some(b => JSON.stringify(b.system ?? "").includes("GEM-DEF-7")) && bodies.every(b => b.model === model) &&
      bodies.filter(b => tools(b).length).every(b => tools(b).includes("Bash") && !tools(b).includes("Write") && !tools(b).includes("Edit")) ? 0 : 1)' \
    "$D/logs/$tag.wrec.jsonl.bodies" "$M"
  verdict $? "the definition's prompt and tools, on the agent's model"; }

# Every run: the key in no log, transcript, worker file or run directory (-D skip: a killed worker's run directory
# keeps its FIFO, and grep would wait on it for good).
tag=tkey; block=tkey; ! grep -rqsF -D skip -f <(head -c 20 "$ANYMODEL_KEY_FILE") "$D/logs" "$D/cfg/projects" "$D/home/.local/state/anymodel" "/tmp/anymodel-$(id -u)"
verdict $? "the Unsloth key in no log, transcript or worker file"
echo "$failed failed"
echo "$retry" > "$D/logs/failed.txt"
[ $failed = 0 ] && exit 0
# The local model standing in for main slips now and then (it misquotes a report, or runs a tool itself instead of
# calling the agent): each failed block runs once more, in a fresh directory. FLAKY when it passes there; the suite
# fails only on a block that failed twice. A key in a log is never a slip.
if [ -n "${ANYMODEL_RETRY:-}" ] || [[ " $retry " == *" tkey "* ]]; then exit 1; fi
kill $recorder; wait $recorder 2>/dev/null
echo "once more, in $D/retry:$retry"
ANYMODEL_RETRY=1 ANYMODEL_TEST_DIR="$D/retry" bash "$here/suite.sh" $retry; again=$?
# A retry that stopped before its end wrote no list: every block counts as failed twice.
twice=$(cat "$D/retry/logs/failed.txt" 2>/dev/null) || twice=$retry
for t in $retry; do if [[ " $twice " == *" $t "* ]]; then echo "FAIL $t (twice)"; else echo "FLAKY $t"; fi; done
exit $again
