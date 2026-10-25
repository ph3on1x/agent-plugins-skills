#!/bin/bash
# One isolated Claude Code session with the anymodel plugin, its cloud pointed at the recorder.
# usage: run.sh <tag> <prompt> [extra claude args...]      headless (-p, stream-json to logs/<tag>.jsonl)
#        run.sh --tui <tag> [extra claude args...]         interactive; pty_run.py drives it
# env: ANYMODEL_TEST_DIR (default $TMPDIR/anymodel-test), RECORDER_PORT (18401), ANYMODEL_AGENTS ({agents, keys} as
#      JSON: the saved agents, and their keys by server URL; default: the agent "gem" on Unsloth Studio at :8888, its key
#      from ANYMODEL_KEY_FILE, its model ANYMODEL_MODEL), ANYMODEL_FORM (more settings form fields, as a JSON object), EXTRA_ENV ("K=V ..." added to the session's env), PERMS
#      (headless permission flags, default --dangerously-skip-permissions), TUI_ARGS (interactive claude flags, default
#      --permission-mode acceptEdits), MAIN_MCP (set: main loads the MCP servers of its config), RUN_TIMEOUT (300 s)
set -u
tui=0; [ "$1" = --tui ] && { tui=1; shift; }
tag=$1; shift
here=$(cd "$(dirname "$0")" && pwd)
D=${ANYMODEL_TEST_DIR:-${TMPDIR:-/tmp}/anymodel-test}
mkdir -p "$D/home" "$D/cfg" "$D/work" "$D/logs"
cp "$here/fixtures/statement.csv" "$D/work/"
# The agents as anymodel keeps them, in its store file (a --plugin-dir plugin's id is anymodel@inline), and the settings
# form as a save leaves it: blank fields, and the API key field holding the keys by server URL. The default agent "gem"
# reads its context size from Unsloth Studio's key-protected /v1/models.
agents=${ANYMODEL_AGENTS:-$(jq -nc --rawfile k "$ANYMODEL_KEY_FILE" --arg m "$ANYMODEL_MODEL" \
  '{agents: {gem: {url: "http://127.0.0.1:8888", model: $m}}, keys: {"http://127.0.0.1:8888": ($k | rtrimstr("\n"))}}')}
mkdir -p "$D/cfg/plugins/store"
jq -c '{agents}' <<< "$agents" > "$D/cfg/plugins/store/anymodel_inline-f9a78e1879c4.json"
form=${ANYMODEL_FORM:-'{}'}
jq -c --argjson form "$form" '{pluginConfigs: {"anymodel@inline": {options: ({api_key: (.keys | tojson)} + $form)}}}' <<< "$agents" > "$D/cfg/settings.json"
cd "$D/work"
# The main session gets a clean env too: no real OAuth token or API key, and its "cloud" is the recorder.
cmd=(env -i HOME="$D/home" USER="$USER" LOGNAME="$USER" SHELL=/bin/zsh LANG=en_US.UTF-8
  PATH="$HOME/.local/bin:$(dirname "$(command -v node)"):/usr/bin:/bin:/usr/sbin:/sbin"
  CLAUDE_CONFIG_DIR="$D/cfg"
  ANTHROPIC_BASE_URL="http://127.0.0.1:${RECORDER_PORT:-18401}" ANTHROPIC_AUTH_TOKEN=dummy-recorder-token
  ANTHROPIC_MODEL=claude-sonnet-5-5 ANTHROPIC_CUSTOM_HEADERS="x-anymodel-run: $tag"
  CLAUDE_CODE_ATTRIBUTION_HEADER=0 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 CLAUDE_CODE_GATEWAY_HINT_HEADERS=1
  CLAUDE_CODE_TOTAL_TOKENS_REMINDER=off  # main's <total_tokens> work budget is for Claude; the stand-in does without
  ${EXTRA_ENV:-}
  claude --plugin-dir "$here/.." $([ -n "${MAIN_MCP:-}" ] || echo --strict-mcp-config) --debug-file "$D/logs/$tag.debug.txt")
if [ $tui = 1 ]; then
  # acceptEdits unless set: the TUI started in auto mode on 2.1.310, and its classifier times out on a local main.
  exec "${cmd[@]}" --allowedTools 'Agent,SendMessage,Read,Bash' ${TUI_ARGS:---permission-mode acceptEdits} "$@"
fi
prompt=$1; shift
t0=$(date +%s)
# The stand-in main can loop instead of ending its turn, and there is no --max-turns: cap the run's wall clock.
perl -e 'alarm shift; exec @ARGV or die' "${RUN_TIMEOUT:-300}" \
  "${cmd[@]}" -p "$prompt" --output-format stream-json --verbose ${PERMS:---dangerously-skip-permissions} "$@" \
  > "$D/logs/$tag.jsonl" 2> "$D/logs/$tag.err" < /dev/null
rc=$?
echo "$tag: exit=$rc wall=$(($(date +%s) - t0))s"
exit $rc
