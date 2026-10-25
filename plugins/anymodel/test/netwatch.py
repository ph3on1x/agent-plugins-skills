# Record every socket the local workers and their children open, polling lsof every 50 ms.
# usage: python3 -I netwatch.py <out.txt> [max_seconds=300]
# Ends 3 s after the last worker exits (once one was seen) or at max_seconds. Only the workers of $ANYMODEL_TEST_DIR
# count (their cwd is its work dir): other anymodel sessions may run alongside.
import os, subprocess, sys, time

out, limit = sys.argv[1], float(sys.argv[2]) if len(sys.argv) > 2 else 300
seen, t0, last_worker = {}, time.time(), None


WORK = os.path.realpath(os.path.join(os.environ.get('ANYMODEL_TEST_DIR') or os.path.join(os.environ.get('TMPDIR', '/tmp'), 'anymodel-test'), 'work'))


def ours(pids):
    if not pids:
        return []
    out = subprocess.run(['lsof', '-a', '-d', 'cwd', '-Fn', '-p', ','.join(pids)], capture_output=True, text=True).stdout
    mine, pid = [], None
    for f in out.splitlines():
        if f.startswith('p'):
            pid = f[1:]
        elif f.startswith('n') and os.path.realpath(f[1:]) == WORK:
            mine.append(pid)
    return mine


def tree(roots):
    pids, todo = set(roots), list(roots)
    while todo:
        r = subprocess.run(['pgrep', '-P', todo.pop()], capture_output=True, text=True)
        for child in r.stdout.split():
            if child not in pids:
                pids.add(child)
                todo.append(child)
    return pids


while time.time() - t0 < limit:
    roots = ours(subprocess.run(['pgrep', '-f', '--', '--setting-sources=project,local'], capture_output=True, text=True).stdout.split())
    if roots:
        last_worker = time.time()
        r = subprocess.run(['lsof', '-n', '-P', '-a', '-i', '-p', ','.join(tree(roots))], capture_output=True, text=True)
        for line in r.stdout.splitlines()[1:]:
            f = line.split()
            seen.setdefault((f[0], f[1], f[7], ' '.join(f[8:])), round(time.time() - t0, 2))
    elif last_worker and time.time() - last_worker > 3:
        break
    time.sleep(0.05)
with open(out, 'w') as fh:
    for (cmd, pid, proto, name), at in sorted(seen.items(), key=lambda kv: kv[1]):
        fh.write(f'{at}s {cmd} pid={pid} {proto} {name}\n')
print(f'netwatch: {len(seen)} sockets, workers seen: {last_worker is not None}')
