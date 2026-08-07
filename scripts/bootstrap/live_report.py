"""Rank the retained (live-at-exit) heap by type: live count x sizeof."""
import re
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else "/tmp/re/s1r9.c"
src = open(SRC).read()

label_of = {}
for m in re.finditer(
    r"struct (__yo_(?:struct|enum)_yo\w+_id_\d+)_struct \{ // ([^:\n]{0,200}?) :", src
):
    label_of[m.group(1)] = m.group(2).strip()

size_of_label = {}
for line in open("/tmp/re/sizes.txt"):
    p = line.split()
    if len(p) != 2:
        continue
    lab = label_of.get(p[0], p[0])
    size_of_label.setdefault(lab, int(p[1]))

names = {}
for line in open("/tmp/re/live_map.txt"):
    idx, lab = line.rstrip("\n").split("\t", 1)
    names[int(idx)] = lab

rows = []
for line in open("/tmp/re/live_counts.txt"):
    p = line.split()
    if len(p) != 2:
        continue
    cnt, idx = int(p[0]), int(p[1])
    lab = names.get(idx, "?%d" % idx)
    sz = size_of_label.get(lab, 0)
    rows.append((cnt * sz, cnt, sz, lab))

rows.sort(reverse=True)
tot = sum(r[0] for r in rows if r[0] > 0)
print("total retained (positive net) = %.2f GB" % (tot / 1e9))
print("%12s %12s %6s  %s" % ("bytes", "live", "size", "type"))
top = int(sys.argv[2]) if len(sys.argv) > 2 else 30
for b, c, s, lab in rows[:top]:
    print("%12.1f %12d %6d  %s" % (b / 1e6, c, s, lab[:80]))
print("... (MB in the first column)")
