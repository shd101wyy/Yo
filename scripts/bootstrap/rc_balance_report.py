"""Per-function refcount balance of the objects still live at exit.

plans/EVALUATOR_MEMORY_REDUCTION.md §0.19. Input: the dump of a binary built
from `alloc_site_census_t.py IN.c OUT.c dump.txt <LABEL> --rc-balance`
(compiled with -g -fno-omit-frame-pointer). Every incr/decr of a target
object is counted per call site; a disposed object's counts fold into the
FREED histogram (the control group), a surviving one's into the LIVE
histogram. This sums both per C function (mapped to Yo names through the
fidmap) and prints the functions whose live net is non-zero.

Read it as: a freed object's net is exactly -1 (constructed at 1, died at
0), so a function that retains the leaked objects shows a positive live net
while the freed objects' net at the same function is ~0 — a reference taken
there that no path releases. Pairs that cancel across two functions
(an owned argument dup'd by the caller and dropped by the callee) show up
with opposite signs in both columns.

Usage: python3 scripts/bootstrap/rc_balance_report.py dump.txt <binary> fidmap.tsv [TOP]
  (fidmap from scripts/bootstrap/fid_name_map.py on the YO_DEBUG_FN_ORIGIN=1 C)
"""
import collections, os, subprocess, sys

dump, binary, fidmap = sys.argv[1:4]
top = int(sys.argv[4]) if len(sys.argv) > 4 else 40
lines = open(dump).read().split("\n")
base = int(lines[0].split()[-1], 16)
fm = {}
for l in open(fidmap):
    f = l.rstrip("\n").split("\t")
    if len(f) >= 3:
        fm[f[0]] = f[2] + "@" + os.path.basename(f[1])
rows = [l.split() for l in lines if l.startswith("B ")]
addrs = sorted({r[3] for r in rows})
sym = {}
for i in range(0, len(addrs), 400):
    chunk = addrs[i:i + 400]
    link = [hex(int(a, 16) - base) for a in chunk]
    out = subprocess.run(["addr2line", "-e", os.path.abspath(binary), "-f"] + link,
                         capture_output=True, text=True).stdout.split("\n")
    for a, fn in zip(chunk, out[0::2]):
        sym[a] = fm.get(fn, fn)
hdr = next(l for l in lines if l.startswith("# balance")).split()
n_live, n_freed = int(hdr[3]), int(hdr[5])
by_fn = collections.defaultdict(lambda: [0, 0])
for r in rows:
    fn = sym.get(r[3], r[3])
    by_fn[fn][0] += int(r[1])
    by_fn[fn][1] += int(r[2])
print(" ".join(hdr))
print("live net | freed net | live per object | function  (%d live, %d freed)" % (n_live, n_freed))
shown = 0
for fn, (lv, fr) in sorted(by_fn.items(), key=lambda kv: -abs(kv[1][0])):
    if lv == 0:
        continue
    print(f"{lv:>8} {fr:>10} {lv / max(n_live, 1):>8.2f}  {fn}")
    shown += 1
    if shown >= top:
        break
