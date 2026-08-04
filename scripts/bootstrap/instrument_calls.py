"""Full call-count profile of the emitted C.

/tmp/re/s1in.c -> /tmp/re/s1prof.c  (+ /tmp/re/prof_map.txt)

- every named `fn_yo<mod>_id_<n>_<name>(...) {` definition gets an entry counter
- every textual CALL of a chosen constructor gets its own site counter
At exit, counts are dumped to /tmp/re/prof_counts.txt as "count idx".
"""

import re

SRC = "/tmp/re/s1in.c"
OUT = "/tmp/re/s1prof.c"
MAP = "/tmp/re/prof_map.txt"

CTORS = {
    "__yo_new___yo_struct_yoc10a5ffb_id_9": "CTOR:Variable",
    "__yo_new___yo_struct_yo51ba7706_id_1299": "CTOR:ArrayList(EvalValue)",
    "__yo_new___yo_struct_yoceebd0e9_id_35": "CTOR:Token",
    "__yo_new___yo_struct_yoc10a5ffb_id_61": "CTOR:Frame",
    "__yo_new___yo_struct_yoc10a5ffb_id_116": "CTOR:Environment",
}

src = open(SRC).read()
labels = []

# ---------- 1. function entry counters ----------
fndef = re.compile(
    r"^((?:__attribute__\(\([^)]*\)\)\s*)?static\s[^;{}]*?\b(fn_yo[a-f0-9]+_id_\d+_[a-z_][a-z_0-9]*)\([^;{}]*\)\s*\{)",
    re.M,
)


def fn_repl(m):
    labels.append("FN:" + m.group(2))
    return m.group(1) + "\n  __yo_prof_n[%d]++;" % (len(labels) - 1)


src, nfn = fndef.subn(fn_repl, src)

# ---------- 2. constructor call-site counters ----------
line_starts = [0]
for i, ch in enumerate(src):
    if ch == "\n":
        line_starts.append(i + 1)
lines = src.split("\n")


def line_of(off):
    lo, hi = 0, len(line_starts) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if line_starts[mid] <= off:
            lo = mid
        else:
            hi = mid - 1
    return lo + 1


pattern = re.compile(r"\b(" + "|".join(re.escape(k) for k in CTORS) + r")\(")
out = []
pos = 0
nsite = 0
for m in pattern.finditer(src):
    name, start = m.group(1), m.start()
    prefix = src[max(0, start - 60):start]
    if re.search(r"static\s+[\w*\s]+$", prefix) and "=" not in prefix:
        continue  # the definition itself
    ln = line_of(start)
    # nearest enclosing named function, searching backwards
    encl = "?"
    for j in range(ln - 1, max(0, ln - 6000), -1):
        mm = re.search(r"\b(fn_yo[a-f0-9]+_id_\d+_[a-z_][a-z_0-9]*)\([^;]*\)\s*\{\s*$", lines[j])
        if mm:
            encl = mm.group(1)
            break
    labels.append("%s@%s:L%d" % (CTORS[name], encl, ln))
    out.append(src[pos:start])
    out.append("(__yo_prof_n[%d]++, %s)(" % (len(labels) - 1, name))
    pos = m.end()
    nsite += 1
out.append(src[pos:])
src = "".join(out)

n = len(labels)
prelude = (
    "\n#include <stdio.h>\n"
    "static unsigned long long __yo_prof_n[%d];\n"
    "__attribute__((destructor)) static void __yo_prof_dump(void) {\n"
    '  FILE* f = fopen("/tmp/re/prof_counts.txt", "w");\n'
    "  if (!f) return;\n"
    "  for (int i = 0; i < %d; i++) if (__yo_prof_n[i]) "
    'fprintf(f, "%%llu %%d\\n", __yo_prof_n[i], i);\n'
    "  fclose(f);\n"
    "}\n"
) % (n, n)

# insert the counter array before the first instrumented construct
first = src.find("__yo_prof_n[")
ins = src.rfind("\n\n", 0, first)
if ins < 0:
    ins = src.rfind("\n", 0, first)
src = src[:ins] + prelude + src[ins:]
open(OUT, "w").write(src)

with open(MAP, "w") as f:
    for i, lab in enumerate(labels):
        f.write("%d\t%s\n" % (i, lab))

print("functions:", nfn, "ctor sites:", nsite, "total counters:", n)
