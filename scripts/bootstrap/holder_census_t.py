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
entries are untracked. HOLDER_DEEP=1 (with HOLDER_SCAN=1) walks tracked AND untracked
RC objects from each root (`D <objects> <bytes> <root> <type>`, unreached ones as LEAK);
HOLDER_DEEP_LAST=<substr>[,<substr>...] walks the matching roots last, giving the group's
EXCLUSIVE share. HOLDER_DEEP_PATH=<type> [HOLDER_DEEP_PATH_ROOT=<root>] prints sampled
discovery chains (`P <root>: <- type <- ...`).
HOLDER_SCAN=1 adds a
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

# Linux has no malloc-zone introspection (the mach block below is #if'd out
# there), so the heap scan enumerates a registry maintained by wrappers the
# transform injects in place of the emitted C's six allocator macros — every
# Yo allocation (RC objects via __yo_rc_alloc -> __yo_malloc, buffers,
# aligned) goes through them, and census-side tables use libc calloc directly
# so they never enter the registry.
if sys.platform == "linux":
    # Only the FIRST allocator block counts: the emitted C also carries the
    # other allocators' runtime sources as embedded string literals, whose
    # in-text #define lines must not be captured (they name functions this
    # emission never defines).
    blk = re.search(r"// Using \w+ allocator\n(#define __yo_\w+ \w+\n)+", src)
    defs = dict(re.findall(r"#define (__yo_(?:malloc|calloc|realloc|free|aligned_alloc|aligned_free)) (\w+)", blk.group(0))) if blk else {}
    want = {"__yo_malloc", "__yo_calloc", "__yo_realloc", "__yo_free", "__yo_aligned_alloc", "__yo_aligned_free"}
    if set(defs) != want:
        raise SystemExit("holder census on Linux needs the emitted C's allocator #define block "
                         "(system or mimalloc spelling); found: %r" % sorted(defs))
    rhs_m, rhs_c = defs["__yo_malloc"], defs["__yo_calloc"]
    rhs_r, rhs_f = defs["__yo_realloc"], defs["__yo_free"]
    rhs_aa, rhs_af = defs["__yo_aligned_alloc"], defs["__yo_aligned_free"]
    blk_end = blk.end()
    assert re.search(r"#define __yo_aligned_free \w+\n$", src[:blk_end]), "allocator block must end on the __yo_aligned_free define"
    trk = """
#if !defined(__APPLE__)
/* Linux heap enumeration for the holder census: the emitted C defines the six
   __yo_* allocator macros at the top of the file; these wrappers replace them
   and record every live block with its exact size. */
#include <stddef.h>
#define __HO_TCAP (1u << 27)
#define __HO_TRK_TOMB ((void*)1)
static void** __ho_trk_k; static size_t* __ho_trk_v; static size_t __ho_trk_n, __ho_trk_t;
static size_t __ho_trk_h(void* p) { size_t x = (size_t)p >> 4; x ^= x >> 17; x *= 0x9E3779B97F4A7C15ull; return (size_t)(x >> 37) & (__HO_TCAP - 1); }
static void __ho_trk_init(void) { if (!__ho_trk_k) { __ho_trk_k = (void**)calloc(__HO_TCAP, sizeof(void*)); __ho_trk_v = (size_t*)calloc(__HO_TCAP, sizeof(size_t)); } }
static void __ho_trk_put(void* p, size_t sz);
/* Deletion leaves tombstones (linear probing), so a long alloc/free churn
   fills the table with them even at a small live count; rebuild from the
   live entries then. An unbounded probe on a full table is how the first
   Linux census run spun for 40 CPU-minutes. */
static void __ho_trk_rehash(void) {
  void** ok = __ho_trk_k; size_t* ov = __ho_trk_v;
  __ho_trk_k = (void**)calloc(__HO_TCAP, sizeof(void*)); __ho_trk_v = (size_t*)calloc(__HO_TCAP, sizeof(size_t));
  __ho_trk_n = 0; __ho_trk_t = 0;
  if (ok) {
    for (size_t j = 0; j < (size_t)__HO_TCAP; j++) { void* k = ok[j]; if (k && k != __HO_TRK_TOMB) __ho_trk_put(k, ov[j]); }
    free(ok); free(ov);
  }
}
static void __ho_trk_put(void* p, size_t sz) {
  if (!p) return; __ho_trk_init();
  if ((__ho_trk_n + __ho_trk_t) * 4 >= (size_t)__HO_TCAP * 3) __ho_trk_rehash();
  if ((__ho_trk_n + __ho_trk_t) * 4 >= (size_t)__HO_TCAP * 3) return;
  size_t i = __ho_trk_h(p); while (__ho_trk_k[i]) { if (__ho_trk_k[i] == p) { __ho_trk_v[i] = sz; return; } i = (i + 1) & (__HO_TCAP - 1); }
  __ho_trk_k[i] = p; __ho_trk_v[i] = sz; __ho_trk_n++;
}
static void __ho_trk_del(void* p) { if (!p || !__ho_trk_k) return; size_t i = __ho_trk_h(p); while (__ho_trk_k[i]) { if (__ho_trk_k[i] == p) { __ho_trk_k[i] = __HO_TRK_TOMB; __ho_trk_v[i] = 0; __ho_trk_n--; __ho_trk_t++; return; } i = (i + 1) & (__HO_TCAP - 1); } }
#undef __yo_malloc
#undef __yo_calloc
#undef __yo_realloc
#undef __yo_free
#undef __yo_aligned_alloc
#undef __yo_aligned_free
static void* __yo_malloc(size_t n) { void* p = %s(n); __ho_trk_put(p, n); return p; }
static void* __yo_calloc(size_t a, size_t b) { void* p = %s(a, b); __ho_trk_put(p, a * b); return p; }
static void* __yo_realloc(void* q, size_t n) { void* p = %s(q, n); if (p) { if (p != q) __ho_trk_del(q); __ho_trk_put(p, n); } else if (n == 0) __ho_trk_del(q); return p; }
static void __yo_free(void* q) { __ho_trk_del(q); %s(q); }
static void* __yo_aligned_alloc(size_t a, size_t n) { void* p = %s(a, n); __ho_trk_put(p, n); return p; }
static void __yo_aligned_free(void* q) { __ho_trk_del(q); %s(q); }
#endif
""" % (rhs_m, rhs_c, rhs_r, rhs_f, rhs_aa, rhs_af)
    src = src[:blk_end] + trk + src[blk_end:]

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
# HOLDER_DEEP container layouts: ArrayList-like (`_ptr`/`_length`) and
# HashMap-like (`ctrl`/`data`/`capacity`) structs, by dispose fn.
al_rows, hm_rows = [], []
for d, b in sorted(disp.items()):
    body = struct_body.get(b, "")
    st = "struct %s_struct" % b
    if re.search(r"\* _ptr;", body) and re.search(r"\bsize_t _length;", body):
        al_rows.append("  { (void*)%s, offsetof(%s, _ptr), offsetof(%s, _length), sizeof(*((%s*)0)->_ptr) }" % (d, st, st, st))
    elif re.search(r"\buint8_t\* ctrl;", body) and re.search(r"\* data;", body) and re.search(r"\bsize_t capacity;", body):
        hm_rows.append("  { (void*)%s, offsetof(%s, ctrl), offsetof(%s, data), offsetof(%s, capacity), sizeof(*((%s*)0)->data) }" % (d, st, st, st, st))
al_c = ",\n".join(al_rows) or "  { 0, 0, 0, 0 }"
hm_c = ",\n".join(hm_rows) or "  { 0, 0, 0, 0, 0 }"
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
static void __ho_count_internal_v(void* p, void* _child_traverse) { (void)_child_traverse; __ho_count_internal(p); }
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
static void __ho_visit(void* p, void* _child_traverse) { (void)_child_traverse; __ho_push(p); }
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
#if defined(__APPLE__)
#include <malloc/malloc.h>
#include <mach/mach.h>
#include <mach-o/getsect.h>
#include <mach-o/dyld.h>
#endif
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
static void __ho_rec_block(char* b, size_t sz) {
  {
    /* the census's own tables and the GC scratch buffer list every object */
    if (b == (char*)__ho_seen || b == (char*)__ho_un_k || b == (char*)__ho_stack || b == (char*)__ho_raw_k || b == (char*)__ho_scan_skip) return;
#ifdef __HS_PRESENT
    if (b == (char*)__hs_t) return; /* alloc_site_census_t.py's table lists every instrumented object */
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
#if defined(__APPLE__)
static void __ho_rec(task_t t, void* ctx, unsigned type, vm_range_t* r, unsigned n) {
  for (unsigned k = 0; k < n; k++) __ho_rec_block((char*)r[k].address, r[k].size);
}
static kern_return_t __ho_reader(task_t t, vm_address_t a, vm_size_t s, void** out) { *out = (void*)a; return KERN_SUCCESS; }
#endif
static void __ho_scan_heap(FILE* f) {
  __ho_hold_by = (long long*)calloc((size_t)%(nb)d * %(nb)d, sizeof(long long));
  __ho_hist_t = (long long*)calloc((size_t)%(nb)d * 4, sizeof(long long));
  __ho_raw_by = (long long*)calloc(%(nb)d, sizeof(long long));
  __ho_hits = (unsigned*)calloc(__HO_UCAP, sizeof(unsigned));
  __ho_raw_k = (void**)calloc(__HO_RCAP, sizeof(void*));
  for (size_t d = 0; d < sizeof(__ho_disp_fns) / sizeof(__ho_disp_fns[0]); d++) (void)__ho_slot(__ho_disp_fns[d]);
#if defined(__APPLE__)
  vm_address_t* zones = NULL; unsigned nz = 0;
  malloc_get_all_zones(mach_task_self(), __ho_reader, &zones, &nz);
  for (__ho_pass = 0; __ho_pass < 2; __ho_pass++)
    for (unsigned z = 0; z < nz; z++) {
      malloc_zone_t* zone = (malloc_zone_t*)zones[z];
      if (zone && zone->introspect && zone->introspect->enumerator)
        zone->introspect->enumerator(mach_task_self(), NULL, MALLOC_PTR_IN_USE_RANGE_TYPE, zones[z], __ho_reader, __ho_rec);
    }
#else
  /* Linux: no malloc-zone introspection. The registry the tracking wrappers
     injected at the top of this file IS the in-use block list, with exact
     sizes; census-side tables use libc calloc directly and never enter it. */
  for (__ho_pass = 0; __ho_pass < 2; __ho_pass++)
    for (size_t ti = 0; __ho_trk_k && ti < __HO_TCAP; ti++) {
      void* k = __ho_trk_k[ti];
      if (!k || k == __HO_TRK_TOMB) continue;
      __ho_rec_block((char*)k, __ho_trk_v[ti]);
    }
#endif
  /* Non-heap holders: the exiting thread's live stack (exit() runs deep inside
     the program, so its frames' locals still own references) and the main
     image's writable data (value-typed globals). A hit here is NOT a leak. */
  {
    long long stack_hits = 0, data_hits = 0;
    void** lo = (void**)__builtin_frame_address(0);
#if defined(__APPLE__)
    void** hi = (void**)pthread_get_stackaddr_np(pthread_self());
#else
    pthread_attr_t __ho_pa; void* __ho_sb; size_t __ho_ss;
    extern int pthread_getattr_np(unsigned long, pthread_attr_t*); /* needs _GNU_SOURCE under -std=c11 */
    pthread_getattr_np(pthread_self(), &__ho_pa);
    pthread_attr_getstack(&__ho_pa, &__ho_sb, &__ho_ss);
    void** hi = (void**)((char*)__ho_sb + __ho_ss);
#endif
    for (void** w = lo; w < hi; w++) { long us = ((size_t)*w & 7) ? -1 : __ho_un_slot(*w); if (us >= 0) { __ho_hits[us]++; stack_hits++; } }
#if defined(__APPLE__)
    const struct mach_header_64* mh = (const struct mach_header_64*)_dyld_get_image_header(0);
    const char* sects[] = {"__data", "__bss", "__common"};
    for (int k = 0; k < 3; k++) {
      unsigned long sz = 0; uint8_t* d = getsectiondata(mh, "__DATA", sects[k], &sz);
      for (size_t j = 0; d && j + sizeof(void*) <= sz; j += sizeof(void*)) { void* v = *(void**)(d + j); long us = ((size_t)v & 7) ? -1 : __ho_un_slot(v); if (us >= 0) { __ho_hits[us]++; data_hits++; } }
    }
#else
    /* the whole writable image: __data_start.._end covers data+bss+common */
    {
      extern char __data_start[]; extern char _end[];
      size_t sz = (size_t)((char*)&_end - (char*)__data_start);
      for (size_t j = 0; j + sizeof(void*) <= sz; j += sizeof(void*)) { void* v = *(void**)((char*)__data_start + j); long us = ((size_t)v & 7) ? -1 : __ho_un_slot(v); if (us >= 0) { __ho_hits[us]++; data_hits++; } }
    }
#endif
    fprintf(f, "S non-heap-holder-words stack:%%lld data:%%lld\n", stack_hits, data_hits);
  }
  long long hist[4] = {0, 0, 0, 0};
#ifdef __HS_PRESENT
  /* zero-hit leak roots: no heap word points at them — a missing release. */
  for (size_t i = 0; i < __HO_UCAP; i++) if (__ho_un_k[i] && __ho_hits[i] == 0) {
    __yo_ref_header_t* h = (__yo_ref_header_t*)__ho_un_k[i];
    if ((long long)h->ref_count > (long long)__ho_un_c[i]) __hs_mark(h);
  }
  if (!getenv("HOLDER_DEEP")) { __hs_marks_done = 1; __hs_dump(); } /* deep mode marks more, then dumps */
#endif
  for (size_t i = 0; i < __HO_UCAP; i++) if (__ho_un_k[i]) { unsigned h = __ho_hits[i]; hist[h > 3 ? 3 : h]++; int ts = __ho_slot_peek((void*)((__yo_ref_header_t*)__ho_un_k[i])->dispose_fn); if (ts >= 0) __ho_hist_t[(size_t)ts * 4 + (h > 3 ? 3 : h)]++; }
  fprintf(f, "S hits-per-unreached-object 0:%%lld 1:%%lld 2:%%lld 3+:%%lld internal-words:%%lld raw-words:%%lld raw-blocks:%%zu\n", hist[0], hist[1], hist[2], hist[3], __ho_hold_internal, __ho_hold_raw, __ho_raw_n);
  for (int c = 0; c < 8; c++) if (__ho_raw_sz[c]) fprintf(f, "S raw-holder-size<=%%d %%lld\n", 64 << (2 * c), __ho_raw_sz[c]);
  for (int h = 0; h < %(nb)d; h++) for (int t = 0; t < %(nb)d; t++) if (__ho_hold_by[(size_t)h * %(nb)d + t]) fprintf(f, "X %%lld %%s <- %%s\n", __ho_hold_by[(size_t)h * %(nb)d + t], __ho_types[t], __ho_types[h]);
  for (int t = 0; t < %(nb)d; t++) { long long* q = &__ho_hist_t[(size_t)t * 4]; if (q[0] + q[1] + q[2] + q[3]) fprintf(f, "T %%s hits 0:%%lld 1:%%lld 2:%%lld 3+:%%lld\n", __ho_types[t], q[0], q[1], q[2], q[3]); }
  for (int t = 0; t < %(nb)d; t++) if (__ho_raw_by[t]) fprintf(f, "Y %%lld %%s\n", __ho_raw_by[t], __ho_types[t]);
  fprintf(f, "Y-raw %%lld Y-unknown %%lld\n", __ho_raw_raw, __ho_raw_unk);
}

/* HOLDER_DEEP=1 (with HOLDER_SCAN=1): retention through UNTRACKED objects.
   Walks every RC object (tracked or not) from each pointer global in
   declaration order, then the image's data as "<other-data>". An edge is a
   word equal to the START of an in-use block whose +8 word is a known
   dispose_fn (an RC header). A tracked object's children come from its traverse_fn
   (precise); an untracked object is scanned conservatively: ArrayList storage only up to
   _length and HashMap data only in live slots, so buffer slack's stale
   words add no edges. Rows: `D <objects> <bytes> <root> <type>`, bytes =
   the object's block plus its container storage; RC objects no root
   reaches are attributed to LEAK. */
#include <stddef.h>
typedef struct { void* fn; size_t off_ptr, off_len, esz; } __hd_al_t;
typedef struct { void* fn; size_t off_ctrl, off_data, off_cap, esz; } __hd_hm_t;
static const __hd_al_t __hd_al[] = {
%(al_c)s
};
static const __hd_hm_t __hd_hm[] = {
%(hm_c)s
};
#define __HD_BCAP (1u << 25)
static void** __hd_bk; static size_t* __hd_bs; static int* __hd_br; static long* __hd_par; static long __hd_cur = -1; static size_t __hd_bn;
static void** __hd_st; static size_t __hd_sp, __hd_head, __hd_scap;
static long long* __hd_cnt; static long long* __hd_bytes;
static size_t __hd_h(void* p) { size_t x = (size_t)p >> 4; x ^= x >> 17; x *= 0x9E3779B97F4A7C15ull; return (x >> 25) & (__HD_BCAP - 1); }
static long __hd_find(void* p) { size_t i = __hd_h(p); while (__hd_bk[i]) { if (__hd_bk[i] == p) return (long)i; i = (i + 1) & (__HD_BCAP - 1); } return -1; }
static void __hd_rec_block(void* b, size_t bsz) {
  {
    if (b == (void*)__ho_seen || b == (void*)__ho_un_k || b == (void*)__ho_stack || b == (void*)__ho_raw_k || b == (void*)__ho_scan_skip || b == (void*)__hd_bk || b == (void*)__hd_bs || b == (void*)__hd_br || b == (void*)__hd_st || b == (void*)__hd_par) return;
#ifdef __HS_PRESENT
    if (b == (void*)__hs_t) return; /* alloc_site_census_t.py's table lists every instrumented object */
#endif
    if (__hd_bn * 4 >= (size_t)__HD_BCAP * 3) return;
    size_t i = __hd_h(b); while (__hd_bk[i]) i = (i + 1) & (__HD_BCAP - 1);
    __hd_bk[i] = b; __hd_bs[i] = bsz; __hd_br[i] = -1; __hd_bn++;
  }
}
#if defined(__APPLE__)
static void __hd_rec(task_t t, void* ctx, unsigned type, vm_range_t* r, unsigned n) {
  for (unsigned k = 0; k < n; k++) __hd_rec_block((void*)r[k].address, r[k].size);
}
#endif
static int __hd_rc_slot(long bi) { if (bi < 0 || __hd_bs[bi] < 16) return -1; return __ho_slot_peek(*(void**)((char*)__hd_bk[bi] + 8)); }
static void __hd_push(void* v, int root) {
  if (((size_t)v & 7) || (size_t)v < 4096) return;
  long i = __hd_find(v); if (i < 0 || __hd_br[i] >= 0) return;
  if (__hd_rc_slot(i) < 0) return;
  __hd_br[i] = root; __hd_par[i] = __hd_cur;
  if (__hd_sp == __hd_scap) { __hd_scap = __hd_scap ? __hd_scap * 2 : 1 << 20; __hd_st = (void**)realloc(__hd_st, __hd_scap * sizeof(void*)); }
  __hd_st[__hd_sp++] = (void*)(size_t)i;
}
static int __hd_root;
static void __hd_visit(void* p, void* _child_traverse) { (void)_child_traverse; __hd_push(p, __hd_root); }
static void __hd_scan_range(void* lo, size_t bytes, int root) {
  void** w = (void**)lo; size_t nw = bytes / sizeof(void*);
  for (size_t j = 0; j < nw; j++) __hd_push(w[j], root);
}
/* breadth-first, so HOLDER_DEEP_PATH chains are shortest paths */
static void __hd_drain(int root) {
  while (__hd_head < __hd_sp) {
    long bi = (long)(size_t)__hd_st[__hd_head++];
    __hd_cur = bi;
    char* b = (char*)__hd_bk[bi]; void* fn = *(void**)(b + 8);
    int s = __ho_slot_peek(fn);
    long long bytes = (long long)__hd_bs[bi];
    /* A TRACKED object's traverse_fn visits exactly its RC children, which
       is precise for enums whose union tail may hold a previous occupant's
       stale words; only untracked objects are scanned conservatively. */
    if ((((__yo_rc_prefix_t*)b)->gc_flags & __YO_GC_TRACKED) && ((__yo_ref_header_t*)b)->traverse_fn) {
      __hd_root = root;
      ((__yo_ref_header_t*)b)->traverse_fn(b, __hd_visit);
      /* the container storage bytes still count toward this object */
      for (size_t a = 0; a < sizeof(__hd_al) / sizeof(__hd_al[0]); a++) if (__hd_al[a].fn == fn) { char* ptr = *(char**)(b + __hd_al[a].off_ptr); long pi = ptr ? __hd_find(ptr) : -1; if (pi >= 0) bytes += (long long)__hd_bs[pi]; break; }
      for (size_t a = 0; a < sizeof(__hd_hm) / sizeof(__hd_hm[0]); a++) if (__hd_hm[a].fn == fn) { uint8_t* ctrl = *(uint8_t**)(b + __hd_hm[a].off_ctrl); char* data = *(char**)(b + __hd_hm[a].off_data); long ci = ctrl ? __hd_find(ctrl) : -1, di = data ? __hd_find(data) : -1; if (ci >= 0) bytes += (long long)__hd_bs[ci]; if (di >= 0) bytes += (long long)__hd_bs[di]; break; }
      if (s >= 0) { __hd_cnt[(size_t)root * %(nb)d + s]++; __hd_bytes[(size_t)root * %(nb)d + s] += bytes; }
      continue;
    }
    __hd_scan_range(b + 16, __hd_bs[bi] > 16 ? __hd_bs[bi] - 16 : 0, root);
    for (size_t a = 0; a < sizeof(__hd_al) / sizeof(__hd_al[0]); a++) if (__hd_al[a].fn == fn) {
      char* ptr = *(char**)(b + __hd_al[a].off_ptr); size_t len = *(size_t*)(b + __hd_al[a].off_len);
      if (ptr && len) { long pi = __hd_find(ptr); if (pi >= 0) { size_t used = len * __hd_al[a].esz; if (used > __hd_bs[pi]) used = __hd_bs[pi]; __hd_scan_range(ptr, used, root); bytes += (long long)__hd_bs[pi]; } }
      break;
    }
    for (size_t a = 0; a < sizeof(__hd_hm) / sizeof(__hd_hm[0]); a++) if (__hd_hm[a].fn == fn) {
      uint8_t* ctrl = *(uint8_t**)(b + __hd_hm[a].off_ctrl); char* data = *(char**)(b + __hd_hm[a].off_data); size_t cap = *(size_t*)(b + __hd_hm[a].off_cap);
      if (ctrl && data) {
        long ci = __hd_find(ctrl), di = __hd_find(data);
        if (ci >= 0) bytes += (long long)__hd_bs[ci];
        if (di >= 0) { bytes += (long long)__hd_bs[di]; for (size_t k = 0; k < cap && (k + 1) * __hd_hm[a].esz <= __hd_bs[di]; k++) if (ctrl[k] < 0x80) __hd_scan_range(data + k * __hd_hm[a].esz, __hd_hm[a].esz, root); }
      }
      break;
    }
    if (s >= 0) { __hd_cnt[(size_t)root * %(nb)d + s]++; __hd_bytes[(size_t)root * %(nb)d + s] += bytes; }
  }
  __hd_sp = __hd_head = 0;
}
static void __ho_deep(FILE* f) {
  __hd_bk = (void**)calloc(__HD_BCAP, sizeof(void*)); __hd_bs = (size_t*)calloc(__HD_BCAP, sizeof(size_t)); __hd_br = (int*)calloc(__HD_BCAP, sizeof(int)); __hd_par = (long*)calloc(__HD_BCAP, sizeof(long));
  __hd_cnt = (long long*)calloc((size_t)(%(nr)d + 2) * %(nb)d, sizeof(long long)); __hd_bytes = (long long*)calloc((size_t)(%(nr)d + 2) * %(nb)d, sizeof(long long));
#if defined(__APPLE__)
  vm_address_t* zones = NULL; unsigned nz = 0;
  malloc_get_all_zones(mach_task_self(), __ho_reader, &zones, &nz);
  for (unsigned z = 0; z < nz; z++) {
    malloc_zone_t* zone = (malloc_zone_t*)zones[z];
    if (zone && zone->introspect && zone->introspect->enumerator)
      zone->introspect->enumerator(mach_task_self(), NULL, MALLOC_PTR_IN_USE_RANGE_TYPE, zones[z], __ho_reader, __hd_rec);
  }
#else
  for (size_t ti = 0; __ho_trk_k && ti < __HO_TCAP; ti++) {
    void* k = __ho_trk_k[ti];
    if (!k || k == __HO_TRK_TOMB) continue;
    __hd_rec_block(k, __ho_trk_v[ti]);
  }
#endif
  /* HOLDER_DEEP_LAST=<substring>: walk the matching roots LAST, so what they
     reach is what ONLY they retain (their exclusive share). */
  const char* last = getenv("HOLDER_DEEP_LAST");
  for (int pass = 0; pass < 2; pass++)
    for (int r = 0; r < %(nr)d; r++) {
      int is_last = 0;
      if (last) { const char* q = last; while (*q) { const char* e = strchr(q, ','); size_t n = e ? (size_t)(e - q) : strlen(q); char buf[128]; if (n >= sizeof buf) n = sizeof buf - 1; memcpy(buf, q, n); buf[n] = 0; if (n && strstr(__ho_roots[r], buf)) { is_last = 1; break; } q += n; if (*q == ',') q++; } }
      if (is_last != pass) continue;
      __hd_cur = -1; __hd_push(*(void* const*)__ho_root_addrs[r], r); __hd_drain(r);
    }
#if defined(__APPLE__)
  const struct mach_header_64* mh = (const struct mach_header_64*)_dyld_get_image_header(0);
  const char* sects[] = {"__data", "__bss", "__common"};
  for (int k = 0; k < 3; k++) {
    unsigned long sz = 0; uint8_t* d = getsectiondata(mh, "__DATA", sects[k], &sz);
    for (size_t j = 0; d && j + sizeof(void*) <= sz; j += sizeof(void*)) __hd_push(*(void**)(d + j), %(nr)d);
  }
#else
  {
    extern char __data_start[]; extern char _end[];
    size_t sz = (size_t)((char*)&_end - (char*)__data_start);
    for (size_t j = 0; j + sizeof(void*) <= sz; j += sizeof(void*)) __hd_push(*(void**)((char*)__data_start + j), %(nr)d);
  }
#endif
  __hd_drain(%(nr)d);
  for (size_t i = 0; i < __HD_BCAP; i++) if (__hd_bk[i] && __hd_br[i] < 0) {
    int s = __hd_rc_slot((long)i); if (s < 0) continue;
    __hd_cnt[(size_t)(%(nr)d + 1) * %(nb)d + s]++; __hd_bytes[(size_t)(%(nr)d + 1) * %(nb)d + s] += (long long)__hd_bs[i];
  }
  /* Split the unreached RC objects: does ANY heap word point at them? A hit
     from a block the walk did not follow (a raw block that is not container
     storage, or an unreached RC object) names a holder kind the walk is
     blind to; zero hits means a missing release. Rows:
     `K <type> zero:<n> hit:<n>` and `KH <words> <target type> <- <holder>`. */
  {
    long long* kz = (long long*)calloc(%(nb)d, sizeof(long long)); long long* kh = (long long*)calloc(%(nb)d, sizeof(long long));
    unsigned* hits = (unsigned*)calloc(__HD_BCAP, sizeof(unsigned));
    long long* holder = (long long*)calloc((size_t)(%(nb)d + 9) * %(nb)d, sizeof(long long));
    for (size_t i = 0; i < __HD_BCAP; i++) if (__hd_bk[i]) {
      void** w = (void**)__hd_bk[i]; size_t nw = __hd_bs[i] / sizeof(void*);
      int hs = __hd_rc_slot((long)i); int hrow;
      if (hs >= 0) hrow = hs; else { size_t sz = __hd_bs[i]; int c = 0; while (sz > 64 && c < 8) { sz >>= 2; c++; } hrow = %(nb)d + c; }
      for (size_t j = 0; j < nw; j++) {
        void* v = w[j]; if (((size_t)v & 7) || (size_t)v < 4096) continue;
        long t = __hd_find(v); if (t < 0 || __hd_br[t] >= 0 || (size_t)t == i) continue;
        int ts = __hd_rc_slot(t); if (ts < 0) continue;
        hits[t]++; holder[(size_t)hrow * %(nb)d + ts]++;
      }
    }
    for (size_t i = 0; i < __HD_BCAP; i++) if (__hd_bk[i] && __hd_br[i] < 0) {
      int ts = __hd_rc_slot((long)i); if (ts < 0) continue;
      if (hits[i]) kh[ts]++; else {
        kz[ts]++;
#ifdef __HS_PRESENT
        __hs_mark(__hd_bk[i]); /* zero-hit unreached: alloc_site_census_t.py dumps its site/event log */
#endif
      }
    }
#ifdef __HS_PRESENT
    __hs_marks_done = 1; __hs_dump();
#endif
    for (int t = 0; t < %(nb)d; t++) if (kz[t] + kh[t] > 100) fprintf(f, "K %%s zero:%%lld hit:%%lld\n", __ho_types[t], kz[t], kh[t]);
    for (int h = 0; h < %(nb)d + 9; h++) for (int t = 0; t < %(nb)d; t++) { long long c = holder[(size_t)h * %(nb)d + t]; if (c > 100) { if (h < %(nb)d) fprintf(f, "KH %%lld %%s <- %%s\n", c, __ho_types[t], __ho_types[h]); else fprintf(f, "KH %%lld %%s <- raw<=%%d\n", c, __ho_types[t], 64 << (2 * (h - %(nb)d))); } }
  }
  /* HOLDER_DEEP_PATH=<type substring> [HOLDER_DEEP_PATH_ROOT=<root substring>]:
     print the discovery chain (types, object -> root) of up to 12 objects of
     that type — the path along which a root retains them. */
  const char* pt = getenv("HOLDER_DEEP_PATH"); const char* pr = getenv("HOLDER_DEEP_PATH_ROOT");
  if (pt) {
    int shown = 0;
    for (size_t i = 0; i < __HD_BCAP && shown < 12; i++) {
      if (!__hd_bk[i] || __hd_br[i] < 0 || __hd_br[i] >= %(nr)d) continue;
      int s0 = __hd_rc_slot((long)i); if (s0 < 0 || !strstr(__ho_types[s0], pt)) continue;
      if (pr && !strstr(__ho_roots[__hd_br[i]], pr)) continue;
      if ((i * 2654435761u) %% 97 != 0) continue; /* sample */
      fprintf(f, "P %%s:", __ho_roots[__hd_br[i]]);
      long c = (long)i; int depth = 0;
      while (c >= 0 && depth < 40) { int sc = __hd_rc_slot(c); fprintf(f, " <- %%s", sc >= 0 ? __ho_types[sc] : "?"); c = __hd_par[c]; depth++; }
      fprintf(f, "\n"); shown++;
    }
  }
  for (int r = 0; r < %(nr)d + 2; r++) for (int t = 0; t < %(nb)d; t++) if (__hd_cnt[(size_t)r * %(nb)d + t])
    fprintf(f, "D %%lld %%lld %%s %%s\n", __hd_cnt[(size_t)r * %(nb)d + t], __hd_bytes[(size_t)r * %(nb)d + t], r < %(nr)d ? __ho_roots[r] : (r == %(nr)d ? "<other-data>" : "LEAK"), __ho_types[t]);
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
    if (h->traverse_fn) h->traverse_fn(h, __ho_count_internal_v);
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
  if (getenv("HOLDER_SCAN") && getenv("HOLDER_DEEP")) __ho_deep(f);
%(len_c)s
  fclose(f);
}
__attribute__((destructor)) static void __ho_census_atexit(void) {
  for (__yo_thread_gc_state_t* g = __yo_all_thread_gcs; g != NULL; g = g->next) __ho_census(g);
}
""" % dict(nb=nb, nr=nr, labels=labels_c, roots=roots_c, ptrs=root_ptrs, cases=cases, dump=dump_path, disp_fns=disp_fns_c, len_c=len_c, al_c=al_c, hm_c=hm_c)

cl = "static void __yo_cleanup_thread_gc() {"
pos = src.find("\n" + cl)
assert pos >= 0
src = src[:pos + 1] + "static void __ho_census(void* st);\n" + cl + "\n  __ho_census((void*)__yo_current_thread_gc);" + src[pos + 1 + len(cl):]
src = src + code
Path(out_path).write_text(src)
print("types:", nb, "roots:", nr)
