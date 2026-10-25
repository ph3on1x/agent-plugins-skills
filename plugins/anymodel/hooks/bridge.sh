#!/bin/sh
# Starts an anymodel worker on the FIFOs of its run directory, so the mod can write to it while it runs.
# usage: bridge.sh <run dir> <worker argv...>
# Standard input: the provider's key on the first line (empty for none), then the worker's first stream-json message.
# $.process.spawn closes standard input after that, so the worker reads <run dir>/in instead, opened read-write: it
# never sees end-of-file when the mod's writes come and go. The key reaches it through the FIFO <run dir>/key on fd 4
# (CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR), so it is in no file, argument or environment.
set -eu
dir=$1
shift
# The worker runs in main's environment, as main's own subagents do, less main's Claude Code variables: its login,
# config directory and backend. The worker's own come in its argv (workerArgv).
for v in $(env | sed -nE 's/^((ANTHROPIC|CLAUDE)[A-Za-z0-9_]*)=.*/\1/p'); do unset "$v"; done
# The worker keeps this pid (exec below): /anymodel cleanup leaves the directory of a running worker alone.
echo $$ > "$dir/pid"
IFS= read -r key
exec 3<>"$dir/in"
# In the background: a long first message would fill the FIFO before the worker reads it. A background job's standard
# input is /dev/null, so it reads ours from fd 5.
exec 5<&0
cat <&5 >&3 5<&- &
exec 5<&-
if [ -n "$key" ]; then
  printf %s "$key" > "$dir/key" &
  exec 4<"$dir/key"
  rm -f "$dir/key"
  key=
fi
exec "$@" <&3 3<&-
