# Drive one interactive (TUI) session of run.sh --tui through a pty: no tmux, no terminal app.
# usage: python3 -I pty_run.py <tag> <step>...
#   say:<text>    type a prompt and press Enter
#   type:<text>   type text without Enter (to see the @ list)
#   exec:<shell>  run a shell command (to change the session's settings mid-run)
#   settle        wait until the recorder saw this run go quiet for QUIET s, with no request in flight and no local
#                 worker running (max SETTLE s, 300 by default)
#   worker        wait until a local worker process runs (max 120 s)
#   esc | ctrlc | enter   send that key
#   sleep:<s>     keep reading the screen for s seconds
#   ps            print the local worker processes still running
#   kill9         SIGKILL the session, as a crash would
#   gone:<s>      fail the run unless no local worker runs within s seconds
#   wait:<text>   wait until the screen shows text after what the last wait matched (compared with escapes, whitespace
#                 and box borders removed; max 240 s), else fail
# The screen goes to logs/<tag>.pty.txt; at the end the session gets /exit, then SIGKILL.
import json, os, pathlib, pty, re, select, subprocess, sys, time, fcntl, struct, termios

HERE = pathlib.Path(__file__).resolve().parent
D = pathlib.Path(os.environ.get('ANYMODEL_TEST_DIR') or pathlib.Path(os.environ.get('TMPDIR', '/tmp')) / 'anymodel-test')
QUIET = float(os.environ.get('QUIET', '12'))
SETTLE = float(os.environ.get('SETTLE', '300'))
tag, steps = sys.argv[1], sys.argv[2:]
for sub in ('cfg', 'work', 'logs'):
    (D / sub).mkdir(parents=True, exist_ok=True)
cfg = D / 'cfg' / '.claude.json'
state = json.loads(cfg.read_text()) if cfg.exists() else {}
# The one-time auto mode billing notice would block the first prompt.
state.update(hasCompletedOnboarding=True, theme='dark', autoModeClassifierBillingNoticeAcknowledgedAt=int(time.time() * 1000))
state.setdefault('projects', {})[str(D / 'work')] = {'hasTrustDialogAccepted': True, 'allowedTools': []}
cfg.write_text(json.dumps(state))
log = D / 'logs' / 'recorder.jsonl'
screen = open(D / 'logs' / f'{tag}.pty.txt', 'wb')


def requests():
    return sum(1 for line in open(log) if f'"run":"{tag}"' in line) if log.exists() else 0


def inflight():  # the recorder saves a body when a request arrives and logs it when the response ends
    bodies = log.parent / 'recorder.jsonl.bodies'
    # Before its first response ends there is no log yet.
    return bodies.exists() and len(os.listdir(bodies)) > (sum(1 for _ in open(log)) if log.exists() else 0)


def workers():  # this test dir's workers only (their cwd is its work dir): other anymodel sessions may run alongside
    r = subprocess.run(['pgrep', '-fl', '--', '--setting-sources=project,local'], capture_output=True, text=True)
    lines = [line for line in r.stdout.splitlines() if line.strip()]
    if not lines:
        return []
    cwd = subprocess.run(['lsof', '-a', '-d', 'cwd', '-Fn', '-p', ','.join(line.split()[0] for line in lines)], capture_output=True, text=True).stdout
    pids, pid = set(), None
    for f in cwd.splitlines():
        if f.startswith('p'):
            pid = f[1:]
        elif f.startswith('n') and os.path.realpath(f[1:]) == os.path.realpath(D / 'work'):
            pids.add(pid)
    return [line for line in lines if line.split()[0] in pids]


pid, fd = pty.fork()
if pid == 0:
    os.execvp('bash', ['bash', str(HERE / 'run.sh'), '--tui', tag])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 160, 0, 0))


def pump(secs):
    end = time.time() + secs
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                screen.write(os.read(fd, 65536))
                screen.flush()
            except OSError:
                return


mark = 0  # the screen up to here was matched by a wait already


def shown(text):  # the screen after `mark` contains text, escapes, whitespace and box borders removed; its end, or -1
    raw = (D / 'logs' / f'{tag}.pty.txt').read_bytes()
    found = re.sub(r'\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\s|│', '', raw[mark:].decode(errors='replace')).find(text)
    return -1 if found == -1 else len(raw)


def say(text):
    for i in range(0, len(text), 3):  # typed in small bursts: a paste-sized burst arrives bracketed
        os.write(fd, text[i:i + 3].encode())
        pump(0.01)
    pump(0.5)
    os.write(fd, b'\r')


t_start, failed = time.time(), False
stamp = lambda: f'{time.time() - t_start:6.1f}s'
pump(6)
for step in steps:
    name, _, arg = step.partition(':')
    if name == 'say':
        say(arg)
    elif name == 'type':
        os.write(fd, arg.encode())
        pump(3)
    elif name == 'exec':
        subprocess.run(arg, shell=True, check=True)
    elif name == 'settle':
        before, t0, last, seen = requests(), time.time(), time.time(), requests()
        while time.time() - t0 < SETTLE:
            pump(1)
            if requests() != seen or workers() or inflight():
                seen, last = requests(), time.time()
            if seen > before and time.time() - last > QUIET:
                break
        print(f'{stamp()} settle: {requests() - before} requests in {time.time() - t0:.1f}s')
    elif name == 'worker':
        t0 = time.time()
        while not workers() and time.time() - t0 < 120:
            pump(0.5)
        print(f'{stamp()} worker: {len(workers())} running after {time.time() - t0:.1f}s')
    elif name in ('esc', 'ctrlc', 'enter'):
        os.write(fd, {'esc': b'\x1b', 'ctrlc': b'\x03', 'enter': b'\r'}[name])
        print(f'{stamp()} sent {name}')
    elif name == 'sleep':
        pump(float(arg))
    elif name == 'kill9':
        os.kill(pid, 9)
        print(f'{stamp()} sent SIGKILL to the session')
    elif name == 'gone':
        t0 = time.time()
        while workers() and time.time() - t0 < float(arg):
            pump(0.1)
        failed |= bool(workers())
        print(f'{stamp()} gone: {len(workers())} worker(s) after {time.time() - t0:.1f}s')
    elif name == 'wait':
        t0 = time.time()
        while shown(arg) == -1 and time.time() - t0 < 240:
            pump(0.5)
        end = shown(arg)
        failed |= end == -1
        mark = max(mark, end)
        print(f'{stamp()} wait: {"NOT shown" if end == -1 else "shown"} after {time.time() - t0:.1f}s: {arg}')
    elif name == 'ps':
        print(f'{stamp()} ps: {len(workers())} worker(s) {[w[:60] for w in workers()]}')
try:
    say('/exit')
    pump(4)
    os.kill(pid, 9)
except OSError:
    pass
print(f'{stamp()} exited; workers left: {len(workers())}')
sys.exit(1 if failed else 0)
