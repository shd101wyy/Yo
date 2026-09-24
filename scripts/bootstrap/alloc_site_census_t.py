"""Allocation-site attribution for the objects still live at exit.

plans/EVALUATOR_MEMORY_REDUCTION.md §0.5 (this is what found the
`f(match(...))` argument leak). For every constructor of the selected types
(tracked OR untracked), the instrumented binary records obj -> (return address
depth 0, depth 1) in an open-addressing side table, clears the entry in the
type's dispose function, and at exit histograms the surviving entries by
(type, variant tag for ref enums, ra0, ra1). Because the table itself is the
live set, untracked (16 B header) types are covered, unlike the heap walk.
macOS-only as written (`_dyld_get_image_header` for the ASLR base).

Usage:
  python3 scripts/bootstrap/alloc_site_census_t.py IN.c OUT.c sites_dump.txt LABEL [LABEL...]
    LABEL matches a type's struct comment (`Variable`, `ArrayList(usize)`), or
    `TypeValue` (the compiler's ref enum, found by its SomeT constructor).
  clang -std=c11 -fno-strict-aliasing -fwrapv -w -O1 -fno-omit-frame-pointer \\
        -I$(brew --prefix openssl@3)/include -o yo_sites OUT.c \\
        -L$(brew --prefix openssl@3)/lib -lssl -lcrypto -lm
  ./yo_sites check src/main.yo --std-path ./std       # writes sites_dump.txt at exit
  python3 scripts/bootstrap/fid_name_map.py IN.c fidmap.tsv
  python3 scripts/bootstrap/alloc_site_report.py sites_dump.txt yo_sites fidmap.tsv
Dump rows: `S <live> <type label> <tag or -1> <ra0> <ra1> <summed capacity>` (capacity
is 0 for non-ArrayList types); line 1 is the image base.
IN.c may already carry live_census_t.py / heap_walk_census_t.py instrumentation.
"""
import re, sys
from pathlib import Path

src_path, out_path, dump_path = sys.argv[1], sys.argv[2], sys.argv[3]
labels = sys.argv[4:] or ["TypeValue"]
src = Path(src_path).read_text()

tyname = {}
for m in re.finditer(r"struct (__yo_t_?\d+)_struct \{ // ([^\n]*)", src):
    tyname[m.group(1)] = m.group(2).replace("(reference counted)", "").strip()

def base_for(label):
    if label == "TypeValue":
        return re.search(r"static (__yo_t_?\d+)\* __yo_new_\1_SomeT\(", src).group(1)
    exact = [b for b, n in tyname.items() if n == label or n.startswith(label + " :") or n.endswith(": " + label)]
    if len(exact) != 1:
        raise SystemExit("label %r matched %r" % (label, exact))
    return exact[0]

bases = [base_for(l) for l in labels]
def is_arraylist(base):
    m = re.search(r"struct %s_struct \{ // [^\n]*\n((?:  [^\n]*\n){1,6})\};" % re.escape(base), src)
    return bool(m and re.search(r"\*\* _ptr;\n  size_t _length;\n  size_t _capacity;\n$", m.group(1)))
al_flags = ",".join("1" if is_arraylist(b) else "0" for b in bases)
n_ctor_total = 0
for k, (label, base) in enumerate(zip(labels, bases)):
    is_enum = re.search(r"\n  %s_tag tag;\n" % re.escape(base), src) is not None
    tag_expr = "(int)obj->tag" if is_enum else "-1"
    pat = re.compile(r"\nstatic (%s\* __yo_new_%s(?:_\w+)?\([^)]*\)) \{(.*?)\n  return obj;\n\}" % (base, base), re.S)
    def repl(m, k=k, tag_expr=tag_expr):
        return ("\n__attribute__((noinline)) static %s {%s\n  __hs_put(obj, %d, %s, __builtin_return_address(0), __builtin_return_address(1));\n  return obj;\n}"
                % (m.group(1), m.group(2), k, tag_expr))
    src, n_ctor = pat.subn(repl, src)
    n_ctor_total += n_ctor
    d = re.search(r"static %s\* __yo_new_%s(?:_\w+)?\([^)]*\) \{.*?header\.dispose_fn = \(void\(\*\)\(void\*\)\)(yo_id_\d+);" % (base, base), src, re.S)
    if not d or n_ctor == 0:
        raise SystemExit("no ctor/dispose for %s (%s)" % (label, base))
    dpat = re.compile(r"\nstatic (?:inline )?void %s\(%s\* (\w+)\) \{" % (d.group(1), base))
    src, n_disp = dpat.subn(lambda m: m.group(0) + "\n  __hs_del(%s);" % m.group(1), src)
    if n_disp != 1:
        raise SystemExit("dispose fn for %s matched %d times" % (label, n_disp))
    print("instrumented", label, base, "ctors:", n_ctor)

label_list = ",".join('"%s"' % l.replace('"', "'") for l in labels)
table = r"""
#include <mach-o/dyld.h>
#include <stdio.h>
typedef struct { void* k; void* a0; void* a1; int ty; int tag; } __hs_e;
#define __HS_CAP (1u << 26)
static __hs_e* __hs_t;
static void* const __HS_TOMB = (void*)1;
static const char* __hs_labels[] = {%(labels)s};
static inline size_t __hs_h(void* p) { size_t x = (size_t)p >> 4; x ^= x >> 17; x *= 0x9E3779B97F4A7C15ull; return (x >> 20) & (__HS_CAP - 1); }
static void __hs_put(void* k, int ty, int tag, void* a0, void* a1) {
  if (!__hs_t) __hs_t = (__hs_e*)calloc(__HS_CAP, sizeof(__hs_e));
  size_t i = __hs_h(k);
  while (__hs_t[i].k != NULL && __hs_t[i].k != __HS_TOMB && __hs_t[i].k != k) i = (i + 1) & (__HS_CAP - 1);
  __hs_t[i].k = k; __hs_t[i].ty = ty; __hs_t[i].tag = tag; __hs_t[i].a0 = a0; __hs_t[i].a1 = a1;
}
static void __hs_del(void* k) {
  if (!__hs_t) return;
  size_t i = __hs_h(k);
  while (__hs_t[i].k != NULL) { if (__hs_t[i].k == k) { __hs_t[i].k = __HS_TOMB; return; } i = (i + 1) & (__HS_CAP - 1); }
}
typedef struct { void* a0; void* a1; int ty; int tag; long long n; long long cap; } __hs_s;
static const char __hs_is_al[] = {%(al)s};
#define __HS_SCAP (1u << 20)
static __hs_s* __hs_sites;
__attribute__((destructor)) static void __hs_dump(void) {
  if (!__hs_t) return;
  __hs_sites = (__hs_s*)calloc(__HS_SCAP, sizeof(__hs_s));
  for (size_t j = 0; j < __HS_CAP; j++) {
    __hs_e* e = &__hs_t[j];
    if (e->k == NULL || e->k == __HS_TOMB) continue;
    size_t i = (((size_t)e->a0 * 31u) ^ ((size_t)e->a1 * 7u) ^ ((size_t)e->ty << 8) ^ (size_t)(e->tag + 1)) & (__HS_SCAP - 1);
    while (__hs_sites[i].n && !(__hs_sites[i].a0 == e->a0 && __hs_sites[i].a1 == e->a1 && __hs_sites[i].ty == e->ty && __hs_sites[i].tag == e->tag)) i = (i + 1) & (__HS_SCAP - 1);
    __hs_sites[i].a0 = e->a0; __hs_sites[i].a1 = e->a1; __hs_sites[i].ty = e->ty; __hs_sites[i].tag = e->tag; __hs_sites[i].n++;
    if (__hs_is_al[e->ty]) __hs_sites[i].cap += (long long)((size_t*)((char*)e->k + sizeof(__yo_ref_header_t)))[2];
  }
  FILE* f = fopen("%(dump)s", "w"); if (!f) return;
  fprintf(f, "# base %%p\n", (void*)_dyld_get_image_header(0));
  for (size_t i = 0; i < __HS_SCAP; i++) if (__hs_sites[i].n)
    fprintf(f, "S %%lld %%s %%d %%p %%p %%lld\n", __hs_sites[i].n, __hs_labels[__hs_sites[i].ty], __hs_sites[i].tag, __hs_sites[i].a0, __hs_sites[i].a1, __hs_sites[i].cap);
  fclose(f);
}
""" % dict(labels=label_list, dump=dump_path, al=al_flags)
inc = src.find("#include")
eol = src.find("\n", inc)
src = src[:eol + 1] + "static void __hs_put(void* k, int ty, int tag, void* a0, void* a1);\nstatic void __hs_del(void* k);\n" + src[eol + 1:] + table
Path(out_path).write_text(src)
print("ctors instrumented:", n_ctor_total)
