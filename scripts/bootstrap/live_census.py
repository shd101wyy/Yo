"""Live-object census of the emitted C: constructions minus disposals per type.

Injects a counter at the top of every `__yo_new_*` constructor (+1) and every
`*___dispose` (-1 for the type it disposes), then dumps the net per type at
exit. live[type] * sizeof(type) = the retained bytes of that type.
"""
import re
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else "/tmp/re/s1r9.c"
OUT = sys.argv[2] if len(sys.argv) > 2 else "/tmp/re/s1live.c"
MAP = "/tmp/re/live_map.txt"
COUNTS = "/tmp/re/live_counts.txt"

src = open(SRC).read()

# type name (Yo) for each mangled struct/enum
tyname = {}
for m in re.finditer(
    r"struct (__yo_(?:struct|enum)_yo\w+_id_\d+)_struct \{ // ([^:\n]{0,200}?) :", src
):
    tyname[m.group(1)] = m.group(2).strip()

slots = {}          # mangled base -> counter index
labels = []


def slot_for(base):
    if base not in slots:
        slots[base] = len(labels)
        labels.append(tyname.get(base, base))
    return slots[base]


# 1. constructors: +1
def ctor_repl(m):
    head, name = m.group(0), m.group(1)
    mm = re.match(r"(__yo_new___yo_(?:struct|enum)_yo\w+_id_\d+)", name)
    base = mm.group(1)[len("__yo_new_"):] if mm else name
    return head + "\n  __yo_live_n[%d]++;" % slot_for(base)


src, n_ctor = re.subn(
    r"static __yo_(?:struct|enum)_\w+\* (__yo_new_\w+)\([^)]*\) \{", ctor_repl, src
)

# 2. dispose: -1.  `static void fn_yoXXX_id_N___dispose(TYPE* self)` — the
#    parameter type names the disposed type.
def disp_repl(m):
    head, ptype = m.group(0), m.group(2)
    return head + "\n  __yo_live_n[%d]--;" % slot_for(ptype)


src, n_disp = re.subn(
    r"static (?:inline )?(?:__attribute__\(\(always_inline\)\) )?void (fn_yo[a-f0-9]+_id_\d+___dispose)\((__yo_(?:struct|enum)_yo\w+_id_\d+)\*[^)]*\) \{",
    disp_repl,
    src,
)

n = len(labels)
prelude = (
    "\n#include <stdio.h>\n"
    "static long long __yo_live_n[%d];\n"
    "__attribute__((destructor)) static void __yo_live_dump(void) {\n"
    '  FILE* f = fopen("%s", "w");\n'
    "  if (!f) return;\n"
    "  for (int i = 0; i < %d; i++) if (__yo_live_n[i]) "
    'fprintf(f, "%%lld %%d\\n", __yo_live_n[i], i);\n'
    "  fclose(f);\n"
    "}\n"
) % (n, COUNTS, n)

first = src.find("__yo_live_n[")
ins = src.rfind("\n\n", 0, first)
if ins < 0:
    ins = src.rfind("\n", 0, first)
src = src[:ins] + prelude + src[ins:]
open(OUT, "w").write(src)
with open(MAP, "w") as f:
    for i, lab in enumerate(labels):
        f.write("%d\t%s\n" % (i, lab))
print("ctors: %d  disposes: %d  types: %d" % (n_ctor, n_disp, n))
