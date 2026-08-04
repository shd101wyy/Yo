import sys

names = {}
for line in open('/tmp/re/prof_map.txt'):
    idx, lab = line.rstrip('\n').split('\t', 1)
    names[int(idx)] = lab

rows = []
for line in open('/tmp/re/prof_counts.txt'):
    p = line.split()
    if len(p) != 2:
        continue
    rows.append((int(p[0]), names.get(int(p[1]), '?%s' % p[1])))
rows.sort(reverse=True)

top = int(sys.argv[1]) if len(sys.argv) > 1 else 60
filt = sys.argv[2] if len(sys.argv) > 2 else None
print('distinct counters fired: %d' % len(rows))
shown = 0
for cnt, lab in rows:
    if filt and filt not in lab:
        continue
    print('%14d  %s' % (cnt, lab))
    shown += 1
    if shown >= top:
        break
