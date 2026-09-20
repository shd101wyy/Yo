"""Live-object census of the emitted C — CURRENT (`__yo_tN`) naming.

Successor to live_census.py (which targets the retired `__yo_struct_yo…_id_N`
names and no longer matches an emission). Injects, per reference type:
  +1 at the entry of every `static __yo_tN* __yo_new___yo_tN[_Variant](...) {`
     constructor DEFINITION (also counts gross constructions), and
  -1 at the entry of the dispose function the constructor installs
     (`obj->header.dispose_fn = (void(*)(void*))yo_id_K;` → `static void yo_id_K(__yo_tN* self) {`).
A destructor dumps one line per type at exit: `live gross sizeof slot`; the
`.map` file next to the output maps slot → `__yo_tN` → Yo type name (from the
`struct __yo_tN_struct { // Name : …` comment). Types whose constructor installs
no dispose_fn are never decremented — their rows are CEILINGS.

Usage:
  yo compile src/main.yo --emit-c --skip-c-compiler --std-path ./std --optimize 2 -o /tmp/re/fresh.c
  python3 scripts/bootstrap/live_census_t.py /tmp/re/fresh.c /tmp/re/census.c /tmp/re/census_dump.txt
  clang -std=c11 -fno-strict-aliasing -fwrapv -w -O1 -I$(brew --prefix openssl@3)/include \
        -o /tmp/re/yo_census /tmp/re/census.c -L$(brew --prefix openssl@3)/lib -lssl -lcrypto -lm
  /tmp/re/yo_census check src/main.yo --std-path ./std      # writes census_dump.txt at exit
  sort -k1,1nr /tmp/re/census_dump.txt | head            # join slot → name via census.c.map

Plan: plans/EVALUATOR_MEMORY_REDUCTION.md Phase 0. Do NOT instrument the
stale yo-out/<triple>/bin/yo.c without checking its version line — it may be
an old emission that rejects today's std.
"""
import re, sys
from pathlib import Path
src_path, out_path, dump_path = sys.argv[1], sys.argv[2], sys.argv[3]
src = Path(src_path).read_text()
# type name for each __yo_tN (struct comment). Ref ENUMS (TypeValue, EvalValue,
# AstExpr) have no `_struct { // Name` comment in the current emission, so their
# rows are labelled by the mangled name; resolve them from the variant ctors
# (`__yo_new___yo_t_N_Atom` = AstExpr, `_UnitVal` = EvalValue, `_Unit` = TypeValue).
tyname = {}
for m in re.finditer(r"struct (__yo_t_?\d+)_struct \{ // ([^\n:]{0,160}?) : ([^\n]{0,160})", src):
    before, after = m.group(2).strip(), m.group(3).strip()
    tyname.setdefault(m.group(1), before if before else after)
slots, labels, sizes_of = {}, [], []
def slot_for(base):
    if base not in slots:
        slots[base] = len(labels); labels.append(tyname.get(base, base)); sizes_of.append(base)
    return slots[base]
disp_to_slot = {}
def ctor_repl(m):
    base, body = m.group(1), m.group(2)
    s = slot_for(base)
    d = re.search(r"header\.dispose_fn = \(void\(\*\)\(void\*\)\)(yo_id_\d+);", body)
    if d: disp_to_slot[d.group(1)] = s
    return "static %s* __yo_new_%s(%s) {\n  __yo_live_n[%d]++; __yo_gross_n[%d]++;%s" % (base, base, m.group(3), s, s, body)
# constructor DEFINITIONS: static __yo_tN* __yo_new___yo_tN(params) { body up to the first line that is just "}" 
pat = re.compile(r"static (__yo_t_?\d+)\* __yo_new_\1(_\w+)?\(([^)]*)\) \{(.*?)\n\}", re.S)
def ctor_repl2(m):
    base, suffix, params, body = m.group(1), m.group(2) or "", m.group(3), m.group(4)
    s = slot_for(base)
    d = re.search(r"header\.dispose_fn = \(void\(\*\)\(void\*\)\)(yo_id_\d+);", body)
    if d: disp_to_slot[d.group(1)] = s
    return "static %s* __yo_new_%s%s(%s) {\n  __yo_live_n[%d]++; __yo_gross_n[%d]++;%s\n}" % (base, base, suffix, params, s, s, body)
src, n_ctor = pat.subn(ctor_repl2, src)
# dispose definitions: static void yo_id_K(__yo_tN* self) {
def disp_repl(m):
    name = m.group(1)
    if name in disp_to_slot:
        return m.group(0) + "\n  __yo_live_n[%d]--;" % disp_to_slot[name]
    return m.group(0)
src, n_disp = re.subn(r"static (?:inline )?void (yo_id_\d+)\(__yo_t_?\d+\* \w+\) \{", disp_repl, src)
n = len(labels)
prelude = ("\n#include <stdio.h>\nstatic long long __yo_live_n[%d]; static long long __yo_gross_n[%d];\n"
  "__attribute__((destructor)) static void __yo_live_dump(void) {\n  FILE* f = fopen(\"%s\", \"w\"); if (!f) return;\n" % (n, n, dump_path))
lines = ["  fprintf(f, \"%%lld %%lld %%zu %d\\n\", __yo_live_n[%d], __yo_gross_n[%d], sizeof(%s));" % (i, i, i, sizes_of[i]) for i in range(n)]
prelude += "\n".join(lines) + "\n  fclose(f);\n}\n"
first = src.find("__yo_live_n[")
ins = src.rfind("\n\n", 0, first)
src = src[:ins] + prelude + src[ins:]
Path(out_path).write_text(src)
Path(out_path + ".map").write_text("".join("%d\t%s\t%s\n" % (i, sizes_of[i], lab) for i, lab in enumerate(labels)))
print("ctors:", n_ctor, "disposes matched:", n_disp, "types:", n, "dispose map:", len(disp_to_slot))
