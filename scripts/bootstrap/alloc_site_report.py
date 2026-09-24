"""Symbolize and aggregate an alloc_site_census_t.py dump.

Usage: python3 scripts/bootstrap/alloc_site_report.py sites_dump.txt <instrumented binary> fidmap.tsv [TOP] [--by-capacity]
(--by-capacity ranks ArrayList sites by summed live capacity — buffer slots — instead of object count.)
Prints the top (type, tag, caller) and (type, tag, caller <- caller's caller)
rows by live count. Callers are resolved with `atos` against the dump's image
base, then mapped from `yo_id_*` to `<name>@<file>:<line>` via fid_name_map.py's
table; unmapped symbols print as-is.
"""
import collections, re, subprocess, sys

dump, binary, fidmap = sys.argv[1], sys.argv[2], sys.argv[3]
top = int(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4].isdigit() else 25
lines = open(dump).read().split("\n")
base = lines[0].split()[-1]
rows = [l.split() for l in lines[1:] if l.startswith("S ")]
addrs = sorted({a for r in rows for a in r[4:6] if a != "0x0"})
sym = {}
for i in range(0, len(addrs), 500):
    chunk = addrs[i:i + 500]
    out = subprocess.run(["atos", "-o", binary, "-l", base] + chunk, capture_output=True, text=True).stdout.split("\n")
    sym.update(zip(chunk, out))
names = {}
for l in open(fidmap):
    f, loc, name = l.rstrip("\n").split("\t")
    names[f] = "%s@%s" % (name, loc)

def nm(a):
    if a == "0x0":
        return "-"
    fn = re.sub(r"\s.*", "", sym.get(a, a))
    return names.get(fn, fn)

weight_cap = "--by-capacity" in sys.argv
by1, by2 = collections.Counter(), collections.Counter()
for r in rows:
    n, ty, tag = int(r[1]), r[2], r[3]
    w = int(r[6]) if (weight_cap and len(r) > 6) else n
    by1[(ty, tag, nm(r[4]))] += w
    by2[(ty, tag, nm(r[4]), nm(r[5]))] += w
print("== by (type, tag, caller)")
for k, v in by1.most_common(top):
    print("%10d  %s tag=%s  %s" % (v, k[0], k[1], k[2]))
print("== by (type, tag, caller <- caller's caller)")
for k, v in by2.most_common(top):
    print("%10d  %s tag=%s  %s  <-  %s" % (v, k[0], k[1], k[2], k[3]))
