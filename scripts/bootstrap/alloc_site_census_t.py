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
--rc-events (a trailing flag) also hooks __yo_incr_rc/__yo_decr_rc (made noinline) and keeps,
per object, the first and last 8 refcount events as (site, caller, caller's caller); with
HS_ONLY_MARKED=1 the dump then carries `E <type> <events> rc=<n> alloc=<ra0> <ra1> | first | last`
rows for the marked leak roots — scripts/bootstrap/rc_event_report.py aggregates them (build
with -g -fno-omit-frame-pointer). This is what found the HashMap rehash leak
(issues/fixed/cond-unit-arm-statement-is-dropped.md).
Dump rows: `S <live> <type label> <tag or -1> <ra0> <ra1> <summed capacity> <ra2> <ra3> <ra4>`
(capacity is 0 for non-ArrayList types; ra2..ra4 come from the frame-record chain, so
build with -fno-omit-frame-pointer); line 1 is the image base.
IN.c may already carry live_census_t.py / heap_walk_census_t.py instrumentation. Apply
holder_census_t.py AFTER this one with HOLDER_SCAN=1 HS_ONLY_MARKED=1 HS_MIN=<huge> to dump
only the allocation sites of the leak roots nothing in the heap points at.
"""
import re, sys
from pathlib import Path

src_path, out_path, dump_path = sys.argv[1], sys.argv[2], sys.argv[3]
labels = [a for a in sys.argv[4:] if not a.startswith("--")] or ["TypeValue"]
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
#define __HS_PRESENT 1
#define __HS_NEV 8
typedef struct { void* k; void* a0; void* a1; void* a2; void* a3; void* a4; int ty; int tag; int marked;
  /* RC_EVENTS mode: first and last __HS_NEV incr(+)/decr(-) sites */
  unsigned nev; void* first[__HS_NEV]; void* last[__HS_NEV]; void* first2[__HS_NEV][2]; void* last2[__HS_NEV][2]; signed char fd[__HS_NEV]; signed char ld[__HS_NEV]; } __hs_e;
#define __HS_CAP (1u << %(cap_bits)d)
static __hs_e* __hs_t;
static void* const __HS_TOMB = (void*)1;
static const char* __hs_labels[] = {%(labels)s};
static inline size_t __hs_h(void* p) { size_t x = (size_t)p >> 4; x ^= x >> 17; x *= 0x9E3779B97F4A7C15ull; return (x >> 20) & (__HS_CAP - 1); }
static void __hs_put(void* k, int ty, int tag, void* a0, void* a1) {
  if (!__hs_t) __hs_t = (__hs_e*)calloc(__HS_CAP, sizeof(__hs_e));
  size_t i = __hs_h(k);
  while (__hs_t[i].k != NULL && __hs_t[i].k != __HS_TOMB && __hs_t[i].k != k) i = (i + 1) & (__HS_CAP - 1);
  __hs_t[i].k = k; __hs_t[i].marked = 0; __hs_t[i].nev = 0; __hs_t[i].ty = ty; __hs_t[i].tag = tag; __hs_t[i].a0 = a0; __hs_t[i].a1 = a1;
  /* frames 2..4 through the frame-record chain: fp[0] = caller's fp, fp[1] = return address */
  void** fp = (void**)__builtin_frame_address(1);
  void* deep[3] = {0, 0, 0};
  for (int d = 0; d < 3 && fp; d++) {
    void** next = (void**)fp[0];
    if (!next || next <= fp) break;
    deep[d] = next[1];
    fp = next;
  }
  __hs_t[i].a2 = deep[0]; __hs_t[i].a3 = deep[1]; __hs_t[i].a4 = deep[2];
}
/* holder_census_t.py marks the leak roots it finds; HS_ONLY_MARKED=1 then
   restricts the dump to them (allocation sites of leaked objects only). */
static int __hs_marks_done = 0;
static void __hs_mark(void* k) {
  if (!__hs_t) return;
  size_t i = __hs_h(k);
  while (__hs_t[i].k != NULL) { if (__hs_t[i].k == k) { __hs_t[i].marked = 1; return; } i = (i + 1) & (__HS_CAP - 1); }
}
__attribute__((noinline)) static void __hs_ev(void* k, void* site, int d) {
  if (!__hs_t) return;
  size_t i = __hs_h(k);
  while (__hs_t[i].k != NULL) {
    if (__hs_t[i].k == k) {
      __hs_e* e = &__hs_t[i];
      /* two more frames through the frame-record chain (build with -fno-omit-frame-pointer):
         __hs_ev <- __yo_incr_rc/__yo_decr_rc <- site fn <- caller <- caller's caller */
      void* up[2] = {0, 0};
      void** fp = (void**)__builtin_frame_address(1);
      if (fp) { void** f2 = (void**)fp[0]; if (f2 && f2 > fp) { up[0] = f2[1]; void** f3 = (void**)f2[0]; if (f3 && f3 > f2) up[1] = f3[1]; } }
      if (e->nev < __HS_NEV) { e->first[e->nev] = site; e->fd[e->nev] = (signed char)d; e->first2[e->nev][0] = up[0]; e->first2[e->nev][1] = up[1]; }
      e->last[e->nev %% __HS_NEV] = site; e->ld[e->nev %% __HS_NEV] = (signed char)d; e->last2[e->nev %% __HS_NEV][0] = up[0]; e->last2[e->nev %% __HS_NEV][1] = up[1];
      e->nev++;
      return;
    }
    i = (i + 1) & (__HS_CAP - 1);
  }
}
static void __hs_del(void* k) {
  if (!__hs_t) return;
  size_t i = __hs_h(k);
  while (__hs_t[i].k != NULL) { if (__hs_t[i].k == k) { __hs_t[i].k = __HS_TOMB; return; } i = (i + 1) & (__HS_CAP - 1); }
}
typedef struct { void* a0; void* a1; void* a2; void* a3; void* a4; int ty; int tag; long long n; long long cap; } __hs_s;
static const char __hs_is_al[] = {%(al)s};
#define __HS_SCAP (1u << 20)
static __hs_s* __hs_sites;
static int __hs_dumped = 0;
/* Runs at the START of the thread's GC teardown (which disposes every tracked
   object and, through them, their untracked children) and as a destructor
   fallback — whichever comes first sees the live set. */
__attribute__((destructor)) static void __hs_dump(void) {
  if (!__hs_t || __hs_dumped) return;
  if (getenv("HS_ONLY_MARKED") && !__hs_marks_done) return; /* wait for holder_census_t.py's marks */
  __hs_dumped = 1;
  __hs_sites = (__hs_s*)calloc(__HS_SCAP, sizeof(__hs_s));
  for (size_t j = 0; j < __HS_CAP; j++) {
    __hs_e* e = &__hs_t[j];
    if (e->k == NULL || e->k == __HS_TOMB) continue;
    if (getenv("HS_ONLY_MARKED") && !e->marked) continue;
    size_t i = (((size_t)e->a0 * 31u) ^ ((size_t)e->a1 * 7u) ^ ((size_t)e->a2 * 13u) ^ ((size_t)e->a3 * 17u) ^ ((size_t)e->a4 * 19u) ^ ((size_t)e->ty << 8) ^ (size_t)(e->tag + 1)) & (__HS_SCAP - 1);
    while (__hs_sites[i].n && !(__hs_sites[i].a0 == e->a0 && __hs_sites[i].a1 == e->a1 && __hs_sites[i].a2 == e->a2 && __hs_sites[i].a3 == e->a3 && __hs_sites[i].a4 == e->a4 && __hs_sites[i].ty == e->ty && __hs_sites[i].tag == e->tag)) i = (i + 1) & (__HS_SCAP - 1);
    __hs_sites[i].a0 = e->a0; __hs_sites[i].a1 = e->a1; __hs_sites[i].a2 = e->a2; __hs_sites[i].a3 = e->a3; __hs_sites[i].a4 = e->a4; __hs_sites[i].ty = e->ty; __hs_sites[i].tag = e->tag; __hs_sites[i].n++;
    if (__hs_is_al[e->ty]) __hs_sites[i].cap += (long long)((size_t*)((char*)e->k + sizeof(__yo_ref_header_t)))[2];
  }
  { size_t live = 0; for (size_t j = 0; j < __HS_CAP; j++) if (__hs_t[j].k && __hs_t[j].k != __HS_TOMB) live++; fprintf(stderr, "[holders] alloc-site table: %%zu live entries\n", live); }
  FILE* f = fopen("%(dump)s", "w"); if (!f) return;
  fprintf(f, "# base %%p\n", (void*)_dyld_get_image_header(0));
  for (size_t i = 0; i < __HS_SCAP; i++) if (__hs_sites[i].n)
    fprintf(f, "S %%lld %%s %%d %%p %%p %%lld %%p %%p %%p\n", __hs_sites[i].n, __hs_labels[__hs_sites[i].ty], __hs_sites[i].tag, __hs_sites[i].a0, __hs_sites[i].a1, __hs_sites[i].cap, __hs_sites[i].a2, __hs_sites[i].a3, __hs_sites[i].a4);
  if (getenv("HS_ONLY_MARKED")) {
    long long nrows = 0;
    for (size_t j = 0; j < __HS_CAP && nrows < 200000; j++) {
      __hs_e* e = &__hs_t[j];
      if (e->k == NULL || e->k == __HS_TOMB || !e->marked || e->nev == 0) continue;
      nrows++;
      fprintf(f, "E %%s %%u rc=%%u alloc=%%p %%p |", __hs_labels[e->ty], e->nev, (unsigned)((__yo_rc_prefix_t*)e->k)->ref_count, e->a0, e->a1);
      unsigned nf = e->nev < __HS_NEV ? e->nev : __HS_NEV;
      for (unsigned q = 0; q < nf; q++) fprintf(f, " %%c%%p/%%p/%%p", e->fd[q] > 0 ? '+' : '-', e->first[q], e->first2[q][0], e->first2[q][1]);
      fprintf(f, " |");
      if (e->nev > __HS_NEV) for (unsigned q = 0; q < __HS_NEV; q++) { unsigned r = (e->nev + q) %% __HS_NEV; fprintf(f, " %%c%%p/%%p/%%p", e->ld[r] > 0 ? '+' : '-', e->last[r], e->last2[r][0], e->last2[r][1]); }
      fprintf(f, "\n");
    }
  }
  fclose(f);
}
""" % dict(cap_bits=(22 if "--rc-events" in sys.argv else 25), labels=label_list, dump=dump_path, al=al_flags)
cl = "static void __yo_cleanup_thread_gc() {"
cpos = src.find("\n" + cl)
if cpos >= 0:
    # Only the thread that actually ran the program: an early-exiting helper
    # thread's teardown would otherwise dump an empty table first.
    src = src[:cpos + 1] + "static void __hs_dump(void);\n" + cl + "\n  if (__yo_current_thread_gc && (long long)__yo_current_thread_gc->tracked_count >= (getenv(\"HS_MIN\") ? atoll(getenv(\"HS_MIN\")) : 1000)) __hs_dump();" + src[cpos + 1 + len(cl):]
if "--rc-events" in sys.argv:
    n1 = src.count("static inline void* __yo_incr_rc(void* ptr) {\n  if (ptr == NULL) return NULL;")
    n2 = src.count("static inline void __yo_decr_rc(void* ptr) {\n  if (ptr == NULL) return;")
    src = src.replace("static inline void* __yo_incr_rc(void* ptr) {\n  if (ptr == NULL) return NULL;",
        "__attribute__((noinline)) static void* __yo_incr_rc(void* ptr) {\n  if (ptr == NULL) return NULL;\n  if (__hs_is_target(ptr)) __hs_ev(ptr, __builtin_return_address(0), 1);", 1)
    src = src.replace("static inline void __yo_decr_rc(void* ptr) {\n  if (ptr == NULL) return;",
        "__attribute__((noinline)) static void __yo_decr_rc(void* ptr) {\n  if (ptr == NULL) return;\n  if (__hs_is_target(ptr)) __hs_ev(ptr, __builtin_return_address(0), -1);", 1)
    print("rc-event hooks:", n1, n2)
    disp_fns = []
    for b in bases:
        d = re.search(r"static %s\* __yo_new_%s(?:_\w+)?\([^)]*\) \{.*?header\.dispose_fn = \(void\(\*\)\(void\*\)\)(yo_id_\d+);" % (b, b), src, re.S)
        disp_fns.append(d.group(1))
    tgt = "static int __hs_is_target(void* p) { void* fn = (void*)((__yo_rc_prefix_t*)p)->dispose_fn; return " + " || ".join("fn == (void*)%s" % d for d in disp_fns) + "; }\n"
    src = src + tgt
inc = src.find("#include")
eol = src.find("\n", inc)
src = src[:eol + 1] + "static void __hs_put(void* k, int ty, int tag, void* a0, void* a1);\nstatic void __hs_del(void* k);\nstatic int __hs_is_target(void* p);\nstatic void __hs_ev(void* k, void* site, int d);\n" + src[eol + 1:] + table
Path(out_path).write_text(src)
print("ctors instrumented:", n_ctor_total)
