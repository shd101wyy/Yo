"""Aggregate the refcount event logs of leaked objects.

plans/EVALUATOR_MEMORY_REDUCTION.md §0.8. Input: the dump of a binary built
from alloc_site_census_t.py IN.c OUT.c dump.txt <LABEL> --rc-events, then
holder_census_t.py OUT.c OUT2.c holders.txt, compiled with
-g -fno-omit-frame-pointer, run with
HOLDER_MIN=<n> HOLDER_SCAN=1 HOLDER_COLLECT=1 HS_ONLY_MARKED=1 HS_MIN=999999999999.
The marked objects are the leak roots no heap word, stack word or global
points at — a missing release. For each, the dump keeps its first and last 8
incr(+)/decr(-) events as site/caller/caller's-caller; this prints the most
common first-8 and last-8 windows with the frames mapped to Yo names.
An increment with no matching decrement across the window is the leak.

Usage: python3 scripts/bootstrap/rc_event_report.py dump.txt <binary> fidmap.tsv [TOP]
"""
import collections, re, subprocess, sys

dump, binary, fidmap = sys.argv[1], sys.argv[2], sys.argv[3]
top = int(sys.argv[4]) if len(sys.argv) > 4 else 4
lines = open(dump).read().split("\n")
base = lines[0].split()[-1]
rows = [l for l in lines if l.startswith("E ")]
addrs = sorted({a for l in rows for a in re.findall(r"0x[0-9a-f]+", l)})
sym = {}
for i in range(0, len(addrs), 400):
    chunk = addrs[i:i + 400]
    out = subprocess.run(["atos", "-o", binary, "-l", base] + chunk, capture_output=True, text=True).stdout.split("\n")
    sym.update(zip(chunk, out))
names = {}
for l in open(fidmap):
    f, loc, name = l.rstrip("\n").split("\t")
    names[f] = name

def nm(a):
    if a in ("0x0", "(nil)"):
        return "-"
    fn = sym.get(a, a).split(" ")[0]
    return names.get(fn, fn)

def event(e):
    return e[0] + "/".join(nm(x) for x in e[1:].split("/"))

first, last, rcs = collections.Counter(), collections.Counter(), collections.Counter()
for l in rows:
    parts = l.split("|")
    head = parts[0].split()
    rcs[head[3]] += 1
    first["\n    ".join(event(e) for e in parts[1].split())] += 1
    if int(head[2]) > 8:
        last["\n    ".join(event(e) for e in parts[2].split())] += 1
print("leaked objects:", len(rows), " remaining refcounts:", rcs.most_common(5))
print("== most common FIRST-8 windows")
for s, c in first.most_common(top):
    print("%d:\n    %s" % (c, s))
print("== most common LAST-8 windows")
for s, c in last.most_common(top):
    print("%d:\n    %s" % (c, s))
