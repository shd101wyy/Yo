"""Exit heap walk over every TRACKED object (the GC's intrusive list).

plans/EVALUATOR_MEMORY_REDUCTION.md §0.5. Run on top of live_census_t.py's
output (or a fresh emission). Only objects with the 56 B tracked header are on
the GC list; untracked (16 B header) types are invisible to this walk.

Per tracked type: live count; for ArrayList-shaped types a length histogram
(0 / 1 / 2 / 3-4 / 5-8 / >8) and summed capacity; for TypeValue a per-variant
count plus, for SomeT / Func / DynT, how many of their lists are empty.

Usage:
  yo compile src/main.yo --emit-c-to /tmp/re/fresh.c --skip-c-compiler --std-path ./std --optimize 2
  python3 scripts/bootstrap/live_census_t.py /tmp/re/fresh.c /tmp/re/c1.c /tmp/re/census_dump.txt
  python3 scripts/bootstrap/heap_walk_census_t.py /tmp/re/c1.c /tmp/re/c2.c /tmp/re/heap_dump.txt
  clang -std=c11 -fno-strict-aliasing -fwrapv -w -O1 -I$(brew --prefix openssl@3)/include \
        -o /tmp/re/yo_census /tmp/re/c2.c -L$(brew --prefix openssl@3)/lib -lssl -lcrypto -lm
  /tmp/re/yo_census check src/main.yo --std-path ./std   # writes heap_dump.txt at exit
Rows: `T <live> <type>` (+ length histogram for ArrayList shapes),
`V <live> <TypeValue variant>`, `E <count> <Variant.list>` (empty lists).
HC_MIN=<n> lowers the 1,000,000-tracked-object threshold for small programs.
"""
import re, sys
from pathlib import Path

src_path, out_path, dump_path = sys.argv[1], sys.argv[2], sys.argv[3]
src = Path(src_path).read_text()

# ---- type names (struct comment) and ArrayList shape --------------------------
tyname, arraylist = {}, set()
for m in re.finditer(r"struct (__yo_t_?\d+)_struct \{ // ([^\n]*)\n((?:  [^\n]*\n){1,6})\};", src):
    base, comment, body = m.group(1), m.group(2), m.group(3)
    tyname[base] = comment.replace("(reference counted)", "").strip()
    if re.search(r"^  __yo_ref_header_t header;.*\n  [^\n]*\*\* _ptr;\n  size_t _length;\n  size_t _capacity;\n$", body, re.M):
        arraylist.add(base)

# ---- TypeValue: the ref enum with a SomeT variant ctor --------------------------
anchor = sys.argv[4] if len(sys.argv) > 4 else "SomeT"
m = re.search(r"static (__yo_t_?\d+)\* __yo_new_\1_%s\(" % anchor, src)
tv = m.group(1)
tv_up = tv.upper()
em = re.search(r"typedef enum \{\n((?:  %s_\w+ = \d+,?\n)+)\} %s_tag;" % (re.escape(tv_up), re.escape(tv)), src)
variants = [re.match(r"  %s_(\w+) = (\d+)" % re.escape(tv_up), l).group(1) for l in em.group(1).splitlines()]

# ---- dispose_fn -> base ---------------------------------------------------------
disp = {}
for m in re.finditer(r"static (__yo_t_?\d+)\* __yo_new_\1(?:_\w+)?\([^)]*\) \{(.*?)\n\}", src, re.S):
    d = re.search(r"header\.dispose_fn = \(void\(\*\)\(void\*\)\)(yo_id_\d+);", m.group(2))
    if d:
        disp.setdefault(d.group(1), m.group(1))
bases = sorted(set(disp.values()))
slot = {b: i for i, b in enumerate(bases)}
n = len(bases)
al_flags = ",".join("1" if b in arraylist else "0" for b in bases)

def field_len(var, field):
    return "((%s*)o)->data.%s.%s->_length" % (tv, var, field)

somet_fields = ["required_trait_types", "required_trait_levels", "negative_trait_types", "negative_trait_levels", "resolved_concrete"]
func_fields = ["forall_types", "param_types", "implicit_types", "where_types", "variadic_types"]
dyn_fields = ["required_trait_types", "required_trait_levels", "negative_trait_types", "negative_trait_levels"]
struct_fields = ["field_labels", "field_types", "type_arguments"]
groups = [("SomeT", somet_fields), ("Func", func_fields), ("DynT", dyn_fields), ("Struct", struct_fields)]

tv_tag = {v: i for i, v in enumerate(variants)}
empty_code = []
k = 0
empty_labels = []
for var, fields in groups:
    vu = var.upper()
    if vu not in tv_tag:
        continue
    lines = []
    for f in fields:
        lines.append("      if (%s == 0) __hc_empty[%d]++;" % (field_len(var, f), k))
        empty_labels.append("%s.%s" % (var, f))
        k += 1
    empty_code.append("    if (tg == %d) {\n%s\n    }" % (tv_tag[vu], "\n".join(lines)))
n_empty = k

cases = "\n".join("  if (fn == (void*)%s) return %d;" % (d, slot[b]) for d, b in sorted(disp.items()))
labels_c = ",\n".join('  "%s %s"' % (b, tyname.get(b, b).replace('"', "'").replace("\\", "/")[:150]) for b in bases)
vlabels_c = ",".join('"%s"' % v for v in variants)
elabels_c = ",".join('"%s"' % e for e in empty_labels)

walker = r"""
/* ---- heap walk census (tmp instrument) ---- */
#include <stdio.h>
static const char* __hc_labels[%(n)d] = {
%(labels)s
};
static const char __hc_is_al[%(n)d] = {%(al)s};
static const char* __hc_vlabels[%(nv)d] = {%(vlabels)s};
static const char* __hc_elabels[%(ne)d] = {%(elabels)s};
static long long __hc_live[%(n)d], __hc_len[%(n)d][6], __hc_cap[%(n)d], __hc_unknown, __hc_tv[%(nv)d], __hc_empty[%(ne)d];
static int __hc_done = 0;
static int __hc_slot(void* fn) {
%(cases)s
  return -1;
}
static void __hc_walk(__yo_ref_header_t* head) {
  for (__yo_ref_header_t* h = head; h != NULL; h = h->gc_next) {
    int s = __hc_slot((void*)h->dispose_fn);
    if (s < 0) { __hc_unknown++; continue; }
    __hc_live[s]++;
    void* o = (void*)h;
    if (__hc_is_al[s]) {
      size_t len = ((size_t*)((char*)o + sizeof(__yo_ref_header_t)))[1];
      size_t cap = ((size_t*)((char*)o + sizeof(__yo_ref_header_t)))[2];
      int b = len == 0 ? 0 : len == 1 ? 1 : len == 2 ? 2 : len <= 4 ? 3 : len <= 8 ? 4 : 5;
      __hc_len[s][b]++; __hc_cap[s] += (long long)cap;
    }
    if (s == %(tvslot)d) {
      int tg = (int)((%(tv)s*)o)->tag;
      if (tg >= 0 && tg < %(nv)d) __hc_tv[tg]++;
%(empty)s
    }
  }
}
static void __hc_dump(void) {
  FILE* f = fopen("%(dump)s", "w"); if (!f) return;
  fprintf(f, "# unknown-dispose tracked objects: %%lld\n", __hc_unknown);
  for (int i = 0; i < %(n)d; i++) if (__hc_live[i]) {
    fprintf(f, "T %%lld %%s", __hc_live[i], __hc_labels[i]);
    if (__hc_is_al[i]) fprintf(f, " | len0 %%lld len1 %%lld len2 %%lld len3-4 %%lld len5-8 %%lld len>8 %%lld cap %%lld", __hc_len[i][0], __hc_len[i][1], __hc_len[i][2], __hc_len[i][3], __hc_len[i][4], __hc_len[i][5], __hc_cap[i]);
    fprintf(f, "\n");
  }
  for (int i = 0; i < %(nv)d; i++) if (__hc_tv[i]) fprintf(f, "V %%lld %%s\n", __hc_tv[i], __hc_vlabels[i]);
  for (int i = 0; i < %(ne)d; i++) fprintf(f, "E %%lld %%s\n", __hc_empty[i], __hc_elabels[i]);
  fclose(f);
}
static void __hc_census_state(void* st) {
  __yo_thread_gc_state_t* gc = (__yo_thread_gc_state_t*)st;
  if (__hc_done || gc == NULL || (long long)gc->tracked_count < (getenv("HC_MIN") ? atoll(getenv("HC_MIN")) : 1000000)) return;
  __hc_done = 1;
  __hc_walk(gc->tracked_objects);
  __hc_dump();
}
__attribute__((destructor)) static void __hc_census_atexit(void) {
  for (__yo_thread_gc_state_t* g = __yo_all_thread_gcs; g != NULL; g = g->next) __hc_census_state(g);
}
""" % dict(n=n, labels=labels_c, al=al_flags, nv=len(variants), vlabels=vlabels_c, ne=max(n_empty, 1),
           elabels=elabels_c or '""', cases=cases, tvslot=slot[tv], tv=tv, empty="\n".join(empty_code), dump=dump_path)

# forward decl near the top of the cleanup fn; call at its entry
fwd = "static void __hc_census_state(void* st);\n"
cl = "static void __yo_cleanup_thread_gc() {"
pos = src.find("\n" + cl)
assert pos >= 0
src = src[:pos + 1] + fwd + cl + "\n  __hc_census_state((void*)__yo_current_thread_gc);" + src[pos + 1 + len(cl):]
src = src + walker
Path(out_path).write_text(src)
print("types:", n, "arraylist-shaped:", sum(1 for b in bases if b in arraylist), "TypeValue:", tv, "variants:", len(variants), "empty probes:", n_empty)
