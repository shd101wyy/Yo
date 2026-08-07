"""Join the counters dumped by an `instrument_calls.py` build with its map.

    python3 scripts/bootstrap/report_calls.py [TOP] [SUBSTRING-FILTER] \
        [--map PATH] [--counts PATH]

Prints the highest counts first, one line per counter:
`FN:<mangled name>` for function entry counters, `CTOR:<type>@<fn>:L<line>` /
`CALL:<fn>@<fn>:L<line>` for per-call-site counters.
"""

import sys

argv = [a for a in sys.argv[1:]]
map_path = "/tmp/re/prof_map.txt"
counts_path = "/tmp/re/prof_counts.txt"
for flag, default in (("--map", "map_path"), ("--counts", "counts_path")):
    if flag in argv:
        i = argv.index(flag)
        val = argv[i + 1]
        argv = argv[:i] + argv[i + 2:]
        if flag == "--map":
            map_path = val
        else:
            counts_path = val

names = {}
for line in open(map_path):
    idx, lab = line.rstrip("\n").split("\t", 1)
    names[int(idx)] = lab

rows = []
for line in open(counts_path):
    p = line.split()
    if len(p) != 2:
        continue
    rows.append((int(p[0]), names.get(int(p[1]), "?%s" % p[1])))
rows.sort(reverse=True)

top = int(argv[0]) if argv else 60
filt = argv[1] if len(argv) > 1 else None
print("distinct counters fired: %d" % len(rows))
shown = 0
for cnt, lab in rows:
    if filt and filt not in lab:
        continue
    print("%14d  %s" % (cnt, lab))
    shown += 1
    if shown >= top:
        break
