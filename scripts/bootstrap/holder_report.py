"""Summarize a holder-census dump (holder_census_t.py's holders_dump.txt).

Groups the H (first-reach holder), U (unreached) and R (leak-root) rows by
type, prints the largest holders and the leak-root composition the §3.1
LEAK-group analysis reads. Usage:

  python3 scripts/bootstrap/holder_report.py holders_dump.txt [TOP]
"""
import sys
from collections import defaultdict

path = sys.argv[1]
top = int(sys.argv[2]) if len(sys.argv) > 2 else 15

by_holder = defaultdict(int)   # root -> objects
by_type_u = defaultdict(int)   # type  -> unreached objects
by_type_r = defaultdict(lambda: [0, 0])  # type -> [objects, external refs]
hdr = {}
for line in open(path):
    f = line.split()
    if not f:
        continue
    if f[0] == "#":
        hdr[f[1] if len(f) > 1 else "?"] = " ".join(f[2:])
        continue
    if f[0] == "H":
        # H <objects> <root> <type>
        by_holder[(f[2], f[3])] = by_holder.get((f[2], f[3]), 0) + int(f[1])
    elif f[0] == "U" and len(f) >= 3:
        by_type_u[f[2]] += int(f[1])
    elif f[0] == "R" and len(f) >= 4:
        r = by_type_r[f[3]]
        r[0] += int(f[1])
        r[1] += int(f[2])

print("== header:", hdr or "(none)")
tot_h = sum(by_holder.values())
print(f"== objects reached from roots: {tot_h} across {len(by_holder)} (root,type) pairs; top {top}:")
for (root, ty), n in sorted(by_holder.items(), key=lambda kv: -kv[1])[:top]:
    print(f"  {n:>10,}  {root}  ::  {ty}")
tu = sum(by_type_u.values())
print(f"== U (no root reaches): {tu:,} objects; top {top} by type:")
for ty, n in sorted(by_type_u.items(), key=lambda kv: -kv[1])[:top]:
    print(f"  {n:>10,}  {ty}")
tr = sum(v[0] for v in by_type_r.values())
if tr:
    print(f"== R (leak roots: rc above what the unreached set explains): {tr:,} objects / {sum(v[1] for v in by_type_r.values()):,} external refs; top {top}:")
    for ty, (n, x) in sorted(by_type_r.items(), key=lambda kv: -kv[1][0])[:top]:
        print(f"  {n:>10,}  (+{x:,} refs)  {ty}")
