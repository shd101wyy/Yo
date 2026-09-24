"""Holder census: which module-level global retains the live objects at exit.

plans/EVALUATOR_MEMORY_REDUCTION.md Phase 0 step 3c. Every pointer-typed
module-level global of the emitted C (`static __yo_tN* <name>_m<hash>; //
module-level mutable variable`) is a root. Just before the thread's GC
teardown disposes everything, the instrumented binary walks from each root
through the objects' own `traverse_fn`s (iterative DFS, one global visited
set) and attributes each TRACKED object to the FIRST root that reaches it, per
type. First-reach attribution is order-dependent for shared subgraphs (roots
are walked in declaration order), so read it as "who holds this population",
and compare two runs (e.g. 1 vs 5 LSP rounds) to find the root that grows.
Untracked objects (16 B header) have no traverse_fn and are not counted.

Usage:
  python3 scripts/bootstrap/holder_census_t.py IN.c OUT.c holders_dump.txt
  clang -std=c11 -fno-strict-aliasing -fwrapv -w -O1 -I$(brew --prefix openssl@3)/include \\
        -o yo_holders OUT.c -L$(brew --prefix openssl@3)/lib -lssl -lcrypto -lm
  ./yo_holders check src/main.yo --std-path ./std        # writes holders_dump.txt
Dump rows: `H <objects> <root global> <type>`; `R <objects> <external refs> <type>` for
the LEAK ROOTS among the unreached (refcount above what the unreached set itself
explains — held by an untracked object or a missing release); `U <objects> <type>` for tracked
objects no root reaches (held only by locals / leaked). `L <length> <root>` rows give
each container global's length (size for maps) — the only view of registries whose
entries are untracked. HOLDER_SCAN=1 adds a
conservative heap scan: `X <words> <target> <- <holder>` = RC objects of <holder> (reached or
untracked) pointing at unreached <target> objects, `T <type> hits` = per-type hit histogram, `Y` = holders of the raw buffers that do
(`S` rows: per-object hit histogram; 0 hits = no pointer anywhere, a missing release). HOLDER_MIN=<n> lowers the
1,000,000-tracked-object threshold for small runs; HOLDER_COLLECT=1 runs the full
cycle collector first (what then stays unreached is a refcount leak, not cycle garbage).
"""
import re, sys
from pathlib import Path

src_path, out_path, dump_path = sys.argv[1], sys.argv[2], sys.argv[3]
src = Path(src_path).read_text()

tyname = {}
for m in re.finditer(r"struct (__yo_t_?\d+)_struct \{ // ([^\n]*)", src):
    tyname[m.group(1)] = m.group(2).replace("(reference counted)", "").strip()
disp = {}
for m in re.finditer(r"static (__yo_t_?\d+)\* __yo_new_\1(?:_\w+)?\([^)]*\) \{(.*?)\n\}", src, re.S):
    d = re.search(r"header\.dispose_fn = \(void\(\*\)\(void\*\)\)(yo_id_\d+);", m.group(2))
    if d:
        disp.setdefault(d.group(1), m.group(1))
bases = sorted(set(disp.values()))
slot = {b: i for i, b in enumerate(bases)}
roots = re.findall(r"^static (__yo_t_?\d+)\* (\w+_m\d+); // module-level mutable variable$", src, re.M)
roots = [(t, n) for t, n in roots if t in slot or True]
nb, nr = len(bases), len(roots)
# Container length per root global (`L <length> <root>` rows): the element
# type may be UNTRACKED (no traverse_fn), which the H rows cannot see into,
# so a registry that grows by untracked entries shows up only here.
struct_body = {}
for m in re.finditer(r"struct (__yo_t_?\d+)_struct \{ // [^\n]*\n(.*?)\n\};", src, re.S):
    struct_body[m.group(1)] = m.group(2)
len_exprs = []
for i, (t, n) in enumerate(roots):
    body = struct_body.get(t, "")
    if re.search(r"\bsize_t _length;", body):
        len_exprs.append((i, "(long long)((%s*)p)->_length" % t))
    elif re.search(r"\bsize_t size;", body):
        len_exprs.append((i, "(long long)((%s*)p)->size" % t))
len_c = "\n".join("  { void* p = *(void* const*)__ho_root_addrs[%d]; if (p) fprintf(f, \"L %%lld %%s\\n\", %s, __ho_roots[%d]); }" % (i, e, i) for i, e in len_exprs)

labels_c = ",\n".join('  "%s"' % tyname.get(b, b).replace('"', "'").replace("\\", "/")[:120] for b in bases)
roots_c = ",\n".join('  "%s"' % n for _, n in roots)
root_ptrs = ",\n".join("  (void*)&%s" % n for _, n in roots)
disp_fns_c = ",\n".join("  (void*)%s" % d for d in sorted(disp))
cases = "\n".join("  if (fn == (void*)%s) return %d;" % (d, slot[b]) for d, b in sorted(disp.items()))

code = r"""
/* ---- holder census (tmp instrument) ---- */
#include <stdio.h>
static const char* __ho_types[%(nb)d] = {
%(labels)s
};
static const char* __ho_roots[%(nr)d] = {
%(roots)s
};
static void* const __ho_root_addrs[%(nr)d] = {
%(ptrs)s
};
static int __ho_slot_linear(void* fn) {
%(cases)s
  return -1;
}
/* dispose_fn -> type slot, memoised in a small open-addressing table (the
   linear chain above costs ~%(nb)d compares per object on a 20 M-object walk) */
#define __HO_SCAP 4096
static void* __ho_sk[__HO_SCAP]; static int __ho_sv[__HO_SCAP];
static int __ho_slot(void* fn) {
  size_t i = (((size_t)fn >> 3) * 0x9E3779B97F4A7C15ull >> 52) & (__HO_SCAP - 1);
  while (__ho_sk[i]) { if (__ho_sk[i] == fn) return __ho_sv[i]; i = (i + 1) & (__HO_SCAP - 1); }
  __ho_sk[i] = fn; __ho_sv[i] = __ho_slot_linear(fn); return __ho_sv[i];
}
#define __HO_CAP (1u << 26)
static void** __ho_seen;
static void** __ho_stack; static size_t __ho_sp, __ho_scap;
static long long* __ho_count;   /* [root][type] */
static int __ho_done = 0;
#define __HO_UCAP (1u << 25)
static size_t __ho_un_n;
static void** __ho_un_k; static unsigned* __ho_un_c;
static long long* __ho_ext; static long long* __ho_extn;
static size_t __ho_uh(void* p) { size_t x = (size_t)p >> 4; x ^= x >> 17; x *= 0x9E3779B97F4A7C15ull; return (x >> 20) & (__HO_UCAP - 1); }
static void __ho_un_add(void* p) {
  if (!__ho_un_k) { __ho_un_k = (void**)calloc(__HO_UCAP, sizeof(void*)); __ho_un_c = (unsigned*)calloc(__HO_UCAP, sizeof(unsigned)); }
  if (__ho_un_n * 4 >= (size_t)__HO_UCAP * 3) return; /* table 75%% full: stop recording (counts become a lower bound) */
  size_t i = __ho_uh(p); while (__ho_un_k[i] && __ho_un_k[i] != p) i = (i + 1) & (__HO_UCAP - 1);
  if (!__ho_un_k[i]) { __ho_un_k[i] = p; __ho_un_n++; }
}
static void __ho_count_internal(void* p) {
  if (!p || !__ho_un_k) return;
  size_t i = __ho_uh(p); while (__ho_un_k[i]) { if (__ho_un_k[i] == p) { __ho_un_c[i]++; return; } i = (i + 1) & (__HO_UCAP - 1); }
}
static size_t __ho_seen_n;
static int __ho_seen_add(void* p) {
  if (__ho_seen_n * 4 >= (size_t)__HO_CAP * 3) return 0; /* 75%% full: treat as seen (walk stays finite) */
  size_t x = (size_t)p >> 4; x ^= x >> 17; x *= 0x9E3779B97F4A7C15ull; size_t i = (x >> 20) & (__HO_CAP - 1);
  while (__ho_seen[i]) { if (__ho_seen[i] == p) return 0; i = (i + 1) & (__HO_CAP - 1); }
  __ho_seen[i] = p; __ho_seen_n++; return 1;
}
static void __ho_push(void* p) {
  if (!p) return;
  if (!(((__yo_rc_prefix_t*)p)->gc_flags & __YO_GC_TRACKED)) return;
  if (!__ho_seen_add(p)) return;
  if (__ho_sp == __ho_scap) { __ho_scap = __ho_scap ? __ho_scap * 2 : 1 << 20; __ho_stack = (void**)realloc(__ho_stack, __ho_scap * sizeof(void*)); }
  __ho_stack[__ho_sp++] = p;
}
static void __ho_visit(void* p) { __ho_push(p); }
static void __ho_walk_from(int r, void* p) {
  __ho_push(p);
  while (__ho_sp) {
    __yo_ref_header_t* h = (__yo_ref_header_t*)__ho_stack[--__ho_sp];
    int s = __ho_slot((void*)h->dispose_fn);
    if (s >= 0) __ho_count[(size_t)r * %(nb)d + s]++;
    if (h->traverse_fn) h->traverse_fn(h, __ho_visit);
  }
}

/* HOLDER_SCAN=1: conservative heap scan. Every in-use malloc block is read
   word by word; a word equal to a leak root's address is a holder the
   traverse functions do not see. Holders are classified by the RC header's
   dispose_fn at +8 (an RC object of a known type), else as a raw block
   (an ArrayList/HashMap buffer), whose own holders a second pass names. */
#include <malloc/malloc.h>
#include <mach/mach.h>
#include <mach-o/getsect.h>
#include <mach-o/dyld.h>
#include <pthread.h>
static void* __ho_scan_skip;
static long long* __ho_hold_by; static long long* __ho_hist_t;   /* [type] words in RC objects of that type */
static long long __ho_hold_raw, __ho_hold_internal, __ho_raw_sz[8];
static unsigned* __ho_hits;       /* per unreached slot: holder words found */
#define __HO_RCAP (1u << 22)
static void** __ho_raw_k; static size_t __ho_raw_n; static int __ho_pass;
static long long* __ho_raw_by; static long long __ho_raw_raw, __ho_raw_unk;
static size_t __ho_rh(void* p) { size_t x = (size_t)p >> 4; x ^= x >> 17; x *= 0x9E3779B97F4A7C15ull; return (x >> 30) & (__HO_RCAP - 1); }
static int __ho_raw_has(void* p) { size_t i = __ho_rh(p); while (__ho_raw_k[i]) { if (__ho_raw_k[i] == p) return 1; i = (i + 1) & (__HO_RCAP - 1); } return 0; }
static void __ho_raw_put(void* p) { if (__ho_raw_n * 4 >= (size_t)__HO_RCAP * 3) return; size_t i = __ho_rh(p); while (__ho_raw_k[i]) { if (__ho_raw_k[i] == p) return; i = (i + 1) & (__HO_RCAP - 1); } __ho_raw_k[i] = p; __ho_raw_n++; }
static long __ho_un_slot(void* p) { size_t i = __ho_uh(p); while (__ho_un_k[i]) { if (__ho_un_k[i] == p) return (long)i; i = (i + 1) & (__HO_UCAP - 1); } return -1; }
/* Scanned blocks hold arbitrary words at +8: look them up WITHOUT inserting
   (a memo insert per garbage word filled the table and hung the probe loop).
   The memo is pre-filled with every known dispose_fn before the scan. */
static void* const __ho_disp_fns[] = {
%(disp_fns)s
};
static int __ho_slot_peek(void* fn) {
  size_t i = (((size_t)fn >> 3) * 0x9E3779B97F4A7C15ull >> 52) & (__HO_SCAP - 1);
  while (__ho_sk[i]) { if (__ho_sk[i] == fn) return __ho_sv[i]; i = (i + 1) & (__HO_SCAP - 1); }
  return -1;
}
static int __ho_block_type(char* b, size_t sz) {
  if (sz < 16) return -1;
  return __ho_slot_peek(*(void**)(b + 8));
}
static void __ho_rec(task_t t, void* ctx, unsigned type, vm_range_t* r, unsigned n) {
  for (unsigned k = 0; k < n; k++) {
    char* b = (char*)r[k].address; size_t sz = r[k].size;
    /* the census's own tables and the GC scratch buffer list every object */
    if (b == (char*)__ho_seen || b == (char*)__ho_un_k || b == (char*)__ho_stack || b == (char*)__ho_raw_k || b == (char*)__ho_scan_skip) continue;
#ifdef __HS_PRESENT
    if (b == (char*)__hs_t) continue; /* alloc_site_census_t.py's table lists every instrumented object */
#endif
    void** w = (void**)b; size_t nw = sz / sizeof(void*);
    if (__ho_pass == 0) {
      int holder_is_unreached = -1;
      for (size_t j = 0; j < nw; j++) {
        void* v = w[j];
        if (((size_t)v & 7) || (size_t)v < 4096) continue;
        long us = __ho_un_slot(v);
        if (us < 0) continue;
        if (holder_is_unreached < 0) holder_is_unreached = __ho_un_slot(b) >= 0;
        if (holder_is_unreached) { __ho_hold_internal++; continue; }
        __ho_hits[us]++;
        int ht = __ho_block_type(b, sz);
        int tt = __ho_slot_peek((void*)((__yo_ref_header_t*)v)->dispose_fn);
        if (ht >= 0 && tt >= 0) __ho_hold_by[(size_t)ht * %(nb)d + tt]++;
        else { __ho_hold_raw++; int c = 0; size_t s2 = sz; while (s2 > 64 && c < 7) { s2 >>= 2; c++; } __ho_raw_sz[c]++; __ho_raw_put(b); }
      }
    } else {
      for (size_t j = 0; j < nw; j++) {
        void* v = w[j];
        if (((size_t)v & 7) || (size_t)v < 4096 || !__ho_raw_has(v)) continue;
        int ht = __ho_block_type(b, sz);
        if (ht >= 0) __ho_raw_by[ht]++; else if (__ho_raw_has(b)) __ho_raw_raw++; else __ho_raw_unk++;
      }
    }
  }
}
static kern_return_t __ho_reader(task_t t, vm_address_t a, vm_size_t s, void** out) { *out = (void*)a; return KERN_SUCCESS; }
static void __ho_scan_heap(FILE* f) {
  __ho_hold_by = (long long*)calloc((size_t)%(nb)d * %(nb)d, sizeof(long long));
  __ho_hist_t = (long long*)calloc((size_t)%(nb)d * 4, sizeof(long long));
  __ho_raw_by = (long long*)calloc(%(nb)d, sizeof(long long));
  __ho_hits = (unsigned*)calloc(__HO_UCAP, sizeof(unsigned));
  __ho_raw_k = (void**)calloc(__HO_RCAP, sizeof(void*));
  for (size_t d = 0; d < sizeof(__ho_disp_fns) / sizeof(__ho_disp_fns[0]); d++) (void)__ho_slot(__ho_disp_fns[d]);
  vm_address_t* zones = NULL; unsigned nz = 0;
  malloc_get_all_zones(mach_task_self(), __ho_reader, &zones, &nz);
  for (__ho_pass = 0; __ho_pass < 2; __ho_pass++)
    for (unsigned z = 0; z < nz; z++) {
      malloc_zone_t* zone = (malloc_zone_t*)zones[z];
      if (zone && zone->introspect && zone->introspect->enumerator)
        zone->introspect->enumerator(mach_task_self(), NULL, MALLOC_PTR_IN_USE_RANGE_TYPE, zones[z], __ho_reader, __ho_rec);
    }
  /* Non-heap holders: the exiting thread's live stack (exit() runs deep inside
     the program, so its frames' locals still own references) and the main
     image's writable data (value-typed globals). A hit here is NOT a leak. */
  {
    long long stack_hits = 0, data_hits = 0;
    void** lo = (void**)__builtin_frame_address(0);
    void** hi = (void**)pthread_get_stackaddr_np(pthread_self());
    for (void** w = lo; w < hi; w++) { long us = ((size_t)*w & 7) ? -1 : __ho_un_slot(*w); if (us >= 0) { __ho_hits[us]++; stack_hits++; } }
    const struct mach_header_64* mh = (const struct mach_header_64*)_dyld_get_image_header(0);
    const char* sects[] = {"__data", "__bss", "__common"};
    for (int k = 0; k < 3; k++) {
      unsigned long sz = 0; uint8_t* d = getsectiondata(mh, "__DATA", sects[k], &sz);
      for (size_t j = 0; d && j + sizeof(void*) <= sz; j += sizeof(void*)) { void* v = *(void**)(d + j); long us = ((size_t)v & 7) ? -1 : __ho_un_slot(v); if (us >= 0) { __ho_hits[us]++; data_hits++; } }
    }
    fprintf(f, "S non-heap-holder-words stack:%%lld data:%%lld\n", stack_hits, data_hits);
  }
  long long hist[4] = {0, 0, 0, 0};
#ifdef __HS_PRESENT
  /* zero-hit leak roots: no heap word points at them — a missing release. */
  for (size_t i = 0; i < __HO_UCAP; i++) if (__ho_un_k[i] && __ho_hits[i] == 0) {
    __yo_ref_header_t* h = (__yo_ref_header_t*)__ho_un_k[i];
    if ((long long)h->ref_count > (long long)__ho_un_c[i]) __hs_mark(h);
  }
  __hs_marks_done = 1; __hs_dump();
#endif
  for (size_t i = 0; i < __HO_UCAP; i++) if (__ho_un_k[i]) { unsigned h = __ho_hits[i]; hist[h > 3 ? 3 : h]++; int ts = __ho_slot_peek((void*)((__yo_ref_header_t*)__ho_un_k[i])->dispose_fn); if (ts >= 0) __ho_hist_t[(size_t)ts * 4 + (h > 3 ? 3 : h)]++; }
  fprintf(f, "S hits-per-unreached-object 0:%%lld 1:%%lld 2:%%lld 3+:%%lld internal-words:%%lld raw-words:%%lld raw-blocks:%%zu\n", hist[0], hist[1], hist[2], hist[3], __ho_hold_internal, __ho_hold_raw, __ho_raw_n);
  for (int c = 0; c < 8; c++) if (__ho_raw_sz[c]) fprintf(f, "S raw-holder-size<=%%d %%lld\n", 64 << (2 * c), __ho_raw_sz[c]);
  for (int h = 0; h < %(nb)d; h++) for (int t = 0; t < %(nb)d; t++) if (__ho_hold_by[(size_t)h * %(nb)d + t]) fprintf(f, "X %%lld %%s <- %%s\n", __ho_hold_by[(size_t)h * %(nb)d + t], __ho_types[t], __ho_types[h]);
  for (int t = 0; t < %(nb)d; t++) { long long* q = &__ho_hist_t[(size_t)t * 4]; if (q[0] + q[1] + q[2] + q[3]) fprintf(f, "T %%s hits 0:%%lld 1:%%lld 2:%%lld 3+:%%lld\n", __ho_types[t], q[0], q[1], q[2], q[3]); }
  for (int t = 0; t < %(nb)d; t++) if (__ho_raw_by[t]) fprintf(f, "Y %%lld %%s\n", __ho_raw_by[t], __ho_types[t]);
  fprintf(f, "Y-raw %%lld Y-unknown %%lld\n", __ho_raw_raw, __ho_raw_unk);
}
static void __ho_census(void* st) {
  __yo_thread_gc_state_t* gc = (__yo_thread_gc_state_t*)st;
  long long min = getenv("HOLDER_MIN") ? atoll(getenv("HOLDER_MIN")) : 1000000;
  if (__ho_done || gc == NULL || (long long)gc->tracked_count < min) return;
  __ho_done = 1;
  /* HOLDER_COLLECT=1: run the full cycle collector first, so what stays
     unreached is a refcount leak rather than cyclic garbage awaiting a pass. */
  if (getenv("HOLDER_COLLECT")) { size_t before = gc->tracked_count; __yo_gc_collect(); fprintf(stderr, "[holders] full collect: tracked %%zu -> %%zu\n", before, gc->tracked_count); }
  __ho_seen = (void**)calloc(__HO_CAP, sizeof(void*));
  __ho_count = (long long*)calloc((size_t)(%(nr)d + 1) * %(nb)d, sizeof(long long));
  for (int r = 0; r < %(nr)d; r++) {
    void* p = *(void* const*)__ho_root_addrs[r];
    if (p) __ho_walk_from(r, p);
  }
  /* tracked objects no root reached */
  size_t nun = 0;
  for (__yo_ref_header_t* h = gc->tracked_objects; h; h = h->gc_next) {
    if (__ho_seen_add(h)) { int s = __ho_slot((void*)h->dispose_fn); if (s >= 0) __ho_count[(size_t)%(nr)d * %(nb)d + s]++; __ho_un_add(h); nun++; }
  }
  /* Leak roots: an unreached object whose refcount exceeds the references
     from the rest of the unreached set is held by something no traverse
     sees (an untracked holder, or a missing release). */
  for (size_t i = 0; i < __HO_UCAP; i++) if (__ho_un_k[i]) {
    __yo_ref_header_t* h = (__yo_ref_header_t*)__ho_un_k[i];
    if (h->traverse_fn) h->traverse_fn(h, __ho_count_internal);
  }
  __ho_ext = (long long*)calloc(%(nb)d, sizeof(long long));
  __ho_extn = (long long*)calloc(%(nb)d, sizeof(long long));
  for (size_t i = 0; i < __HO_UCAP; i++) if (__ho_un_k[i]) {
    __yo_ref_header_t* h = (__yo_ref_header_t*)__ho_un_k[i];
    long long ext = (long long)h->ref_count - (long long)__ho_un_c[i];
    int s = __ho_slot((void*)h->dispose_fn);
    if (ext > 0 && s >= 0) { __ho_extn[s]++; __ho_ext[s] += ext; }
  }
  FILE* f = fopen("%(dump)s", "w"); if (!f) return;
  for (int r = 0; r < %(nr)d; r++) for (int t = 0; t < %(nb)d; t++) {
    long long c = __ho_count[(size_t)r * %(nb)d + t];
    if (c) fprintf(f, "H %%lld %%s %%s\n", c, __ho_roots[r], __ho_types[t]);
  }
  for (int t = 0; t < %(nb)d; t++) { long long c = __ho_count[(size_t)%(nr)d * %(nb)d + t]; if (c) fprintf(f, "U %%lld %%s\n", c, __ho_types[t]); }
  for (int t = 0; t < %(nb)d; t++) if (__ho_extn && __ho_extn[t]) fprintf(f, "R %%lld %%lld %%s\n", __ho_extn[t], __ho_ext[t], __ho_types[t]);
  if (getenv("HOLDER_SCAN")) { __ho_scan_skip = (void*)gc->gc_white; __ho_scan_heap(f); }
%(len_c)s
  fclose(f);
}
__attribute__((destructor)) static void __ho_census_atexit(void) {
  for (__yo_thread_gc_state_t* g = __yo_all_thread_gcs; g != NULL; g = g->next) __ho_census(g);
}
""" % dict(nb=nb, nr=nr, labels=labels_c, roots=roots_c, ptrs=root_ptrs, cases=cases, dump=dump_path, disp_fns=disp_fns_c, len_c=len_c)

cl = "static void __yo_cleanup_thread_gc() {"
pos = src.find("\n" + cl)
assert pos >= 0
src = src[:pos + 1] + "static void __ho_census(void* st);\n" + cl + "\n  __ho_census((void*)__yo_current_thread_gc);" + src[pos + 1 + len(cl):]
src = src + code
Path(out_path).write_text(src)
print("types:", nb, "roots:", nr)
