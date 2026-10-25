# Watches every process's arguments and environment for a key for some seconds (ps every 0.3 s), and lists the pids
# where it appears; never the key itself.
# usage: python3 -I keywatch.py <key file> <seconds> <out file>     exit 1 when the key appeared
import subprocess, sys, time

key = open(sys.argv[1]).read().strip()[:20]
end, seen = time.time() + float(sys.argv[2]), set()
while time.time() < end:
    out = subprocess.run(['ps', 'axwwe', '-o', 'pid=,command='], capture_output=True, text=True).stdout
    seen |= {line.split()[0] for line in out.splitlines() if key in line}
    time.sleep(0.3)
open(sys.argv[3], 'w').write(''.join(f'{p}\n' for p in sorted(seen)))
sys.exit(1 if seen else 0)
