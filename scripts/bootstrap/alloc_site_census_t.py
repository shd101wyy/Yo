"""Allocation-site attribution for live TypeValue objects (on top of heap_walk_census.py output).

Each TypeValue variant ctor becomes noinline and records (obj -> return address
depth 0 and 1) in an open-addressing side table; the TypeValue dispose fn clears
it; the heap walk histograms live objects by (tag, ra0, ra1).

plans/EVALUATOR_MEMORY_REDUCTION.md §0.5 (found the substitute-path leak).
macOS-only as written (`_dyld_get_image_header` for the ASLR base).

Usage (after heap_walk_census_t.py):
  python3 scripts/bootstrap/alloc_site_census_t.py /tmp/re/c2.c /tmp/re/c3.c /tmp/re/sites_dump.txt
  clang ... -O1 -fno-omit-frame-pointer -o /tmp/re/yo_sites /tmp/re/c3.c ...   (same flags as above)
  /tmp/re/yo_sites check src/main.yo --std-path ./std
  python3 scripts/bootstrap/fid_name_map.py /tmp/re/fresh.c /tmp/re/fidmap.tsv
  # symbolize: atos -o /tmp/re/yo_sites -l <base from the dump's first line> <addrs>, then join
  # the yo_id_ names against fidmap.tsv. Rows: `S <live> <tag> <ra0> <ra1>`.
"""
import re, sys
from pathlib import Path

src_path, out_path, dump_path = sys.argv[1], sys.argv[2], sys.argv[3]
src = Path(src_path).read_text()
tv = re.search(r"static (__yo_t_?\d+)\* __yo_new_\1_SomeT\(", src).group(1)

# ctor definitions: noinline + record before `return obj;`
pat = re.compile(r"\nstatic (%s\* __yo_new_%s_\w+\([^)]*\)) \{(.*?)\n  return obj;\n\}" % (tv, tv), re.S)
def repl(m):
    return "\n__attribute__((noinline)) static %s {%s\n  __hs_put(obj, __builtin_return_address(0), __builtin_return_address(1));\n  return obj;\n}" % (m.group(1), m.group(2))
src, n_ctor = pat.subn(repl, src)
disp = re.search(r"static %s\* __yo_new_%s_\w+\([^)]*\) \{.*?header\.dispose_fn = \(void\(\*\)\(void\*\)\)(yo_id_\d+);" % (tv, tv), src, re.S).group(1)
dpat = re.compile(r"\nstatic (?:inline )?void %s\(%s\* (\w+)\) \{" % (disp, tv))
src, n_disp = dpat.subn(lambda m: m.group(0) + "\n  __hs_del(%s);" % m.group(1), src)
assert n_ctor >= 30 and n_disp == 1, (n_ctor, n_disp)

table = r"""
#include <mach-o/dyld.h>
typedef struct { void* k; void* a0; void* a1; } __hs_e;
#define __HS_CAP (1u << 25)
static __hs_e* __hs_t;
static void* const __HS_TOMB = (void*)1;
static inline size_t __hs_h(void* p) { size_t x = (size_t)p >> 4; x ^= x >> 17; x *= 0x9E3779B97F4A7C15ull; return (x >> 20) & (__HS_CAP - 1); }
static void __hs_put(void* k, void* a0, void* a1) {
  if (!__hs_t) __hs_t = (__hs_e*)calloc(__HS_CAP, sizeof(__hs_e));
  size_t i = __hs_h(k);
  while (__hs_t[i].k != NULL && __hs_t[i].k != __HS_TOMB && __hs_t[i].k != k) i = (i + 1) & (__HS_CAP - 1);
  __hs_t[i].k = k; __hs_t[i].a0 = a0; __hs_t[i].a1 = a1;
}
static __hs_e* __hs_get(void* k) {
  if (!__hs_t) return NULL;
  size_t i = __hs_h(k);
  while (__hs_t[i].k != NULL) { if (__hs_t[i].k == k) return &__hs_t[i]; i = (i + 1) & (__HS_CAP - 1); }
  return NULL;
}
static void __hs_del(void* k) { __hs_e* e = __hs_get(k); if (e) e->k = __HS_TOMB; }
/* site histogram: (tag, a0, a1) -> count */
typedef struct { void* a0; void* a1; int tag; long long n; } __hs_s;
#define __HS_SCAP (1u << 18)
static __hs_s __hs_sites[__HS_SCAP];
static void __hs_count(void* o, int tag) {
  __hs_e* e = __hs_get(o);
  void* a0 = e ? e->a0 : NULL; void* a1 = e ? e->a1 : NULL;
  size_t i = (((size_t)a0 * 31u) ^ ((size_t)a1 * 7u) ^ (size_t)tag) & (__HS_SCAP - 1);
  while (__hs_sites[i].n && !(__hs_sites[i].a0 == a0 && __hs_sites[i].a1 == a1 && __hs_sites[i].tag == tag)) i = (i + 1) & (__HS_SCAP - 1);
  __hs_sites[i].a0 = a0; __hs_sites[i].a1 = a1; __hs_sites[i].tag = tag; __hs_sites[i].n++;
}
static void __hs_dump(void) {
  FILE* f = fopen("%(dump)s", "w"); if (!f) return;
  fprintf(f, "# base %%p\n", (void*)_dyld_get_image_header(0));
  for (size_t i = 0; i < __HS_SCAP; i++) if (__hs_sites[i].n) fprintf(f, "S %%lld %%d %%p %%p\n", __hs_sites[i].n, __hs_sites[i].tag, __hs_sites[i].a0, __hs_sites[i].a1);
  fclose(f);
}
""" % dict(dump=dump_path)

# hook into the heap walk: count per site in the TypeValue branch, dump after
anchor = "      if (tg >= 0 && tg < "
assert src.count(anchor) == 1
src = src.replace(anchor, "      __hs_count(o, tg);\n" + anchor, 1)
src = src.replace("  __hc_dump();\n}", "  __hc_dump();\n  __hs_dump();\n}", 1)
# the table must precede the ctors: put it right before the first ctor definition
first = src.find("\n__attribute__((noinline)) static %s* __yo_new_" % tv)
fwd_pos = src.rfind("\n\n", 0, first)
src = src[:fwd_pos] + "\n" + table + src[fwd_pos:]
Path(out_path).write_text(src)
print("ctors:", n_ctor, "dispose:", disp)
