"""Report for reuse_census_t.py dumps: per-type and per-function reuse ceilings.

Usage: python3 scripts/bootstrap/reuse_report.py <dump.txt> <instrumented.c> [top]
Prints totals (gross constructions, deaths, same-type ceiling, strict same-type
pairs, same-size ceiling), the top types by ceiling and by gross, and the top
functions by same-type ceiling. plans/backlog/PERCEUS_REUSE.md Phase 0 step 2.
"""
import sys
from pathlib import Path
dump, cfile = sys.argv[1], sys.argv[2]
top = int(sys.argv[3]) if len(sys.argv) > 3 else 25
tmap = {int(a): (b, c) for a, b, c in (l.rstrip("\n").split("\t") for l in Path(cfile + ".map").read_text().splitlines())}
fmap = {int(a): b for a, b in (l.rstrip("\n").split("\t") for l in Path(cfile + ".fmap").read_text().splitlines())}
types, fns, header = [], [], ""
for line in Path(dump).read_text().splitlines():
    if line.startswith("#"): header = line; continue
    p = line.split()
    if p[0] == "T": types.append((int(p[1]), int(p[2]), int(p[3]), int(p[4]), int(p[5]), int(p[6]), int(p[7])))
    elif p[0] == "F": fns.append((int(p[1]), int(p[2]), int(p[3]), int(p[4]), int(p[5])))
G = sum(t[1] for t in types); D = sum(t[2] for t in types); C = sum(t[3] for t in types); S = sum(t[4] for t in types)
CS = sum(f[3] for f in fns); CF = sum(f[2] for f in fns); TR = sum(t[6] for t in types)
def pct(a, b): return "%.1f%%" % (100.0 * a / b) if b else "-"
print(header)
print("gross constructions %d  deaths %d\n  intra-activation same-type ceiling %d (%s of gross)   strict (no drop movement) %d (%s)\n  transitive same-type ceiling %d (%s)   transitive same-size ceiling %d (%s)"
      % (G, D, C, pct(C, G), S, pct(S, G), TR, pct(TR, G), CS, pct(CS, G)))
hdr = "(slot gross deaths intra strict transitive sizeof name)"
def trow(t): return "%5d %11d %11d %11d %11d %11d %4d  %s" % (t[0], t[1], t[2], t[3], t[4], t[6], t[5], tmap[t[0]][1][:64])
print("\n== top types by transitive ceiling " + hdr)
for t in sorted(types, key=lambda t: -t[6])[:top]: print(trow(t))
print("\n== top types by gross " + hdr)
for t in sorted(types, key=lambda t: -t[1])[:top]: print(trow(t))
print("\n== top functions by transitive ceiling (fid gross intra same_size transitive cname)")
for f in sorted(fns, key=lambda f: -f[4])[:top]:
    print("%6d %11d %11d %11d %11d  %s" % (f[0], f[1], f[2], f[3], f[4], fmap[f[0]][:80]))
