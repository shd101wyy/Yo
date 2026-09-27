"""Peak-composition histogram: what is live at each memory high-water mark.

plans/EVALUATOR_MEMORY_REDUCTION.md Phase 0 step 2. The holder census
(holder_census_t.py) attributes what is RETAINED at exit; this tool answers
the other half — the SHAPE of the growth: live-bytes marks along the run
(rate-limited), plus the final composition by size class and by allocation
site. Every allocation through the emitted C's six `__yo_*` allocator macros
is tracked (address -> size + return address; the Linux macro-wrapping
technique from holder_census_t.py).

Usage:
  python3 scripts/bootstrap/peak_histogram.py IN.c OUT.c peak_dump.txt
  clang -std=c11 -fno-strict-aliasing -fwrapv -w -O1 $(pkg-config --cflags --libs openssl) \\
        OUT.c -o yo_peak -lm
  ./yo_peak check src/main.yo --std-path ./std       # writes peak_dump.txt
Dump rows:
  `M <seq> <live_bytes> <live_objects> <total_allocs>`  a recorded growth mark
  `C <label> <objects> <bytes>`   exit composition by size class
                                  (label = class width in bytes, or >N)
  `A <rank> <bytes> <objects> <ra0-hex>`  exit top sites by live bytes
  `# base <hex>`  PIE load base — shift ra0 by it, then
  `addr2line -e yo_peak -f -C <ra0-base>` names the site (or map through
  scripts/bootstrap/fid_name_map.py when the emission carried
  YO_DEBUG_FN_ORIGIN=1).
Env: PEAK_PCT (mark growth %, default 2), PEAK_GAP_S (min seconds between
marks, default 5), PEAK_TOP (sites ranked, default 30).
"""
import re, sys
from pathlib import Path

src_path, out_path, dump_path = sys.argv[1], sys.argv[2], sys.argv[3]
src = Path(src_path).read_text()

blk = re.search(r"// Using \w+ allocator\n(#define __yo_\w+ \w+\n)+", src)
defs = dict(re.findall(r"#define (__yo_(?:malloc|calloc|realloc|free|aligned_alloc|aligned_free)) (\w+)", blk.group(0))) if blk else {}
want = {"__yo_malloc", "__yo_calloc", "__yo_realloc", "__yo_free", "__yo_aligned_alloc", "__yo_aligned_free"}
if set(defs) != want:
    raise SystemExit("peak histogram needs the emitted C's allocator #define block; found: %r" % sorted(defs))
rhs_m, rhs_c = defs["__yo_malloc"], defs["__yo_calloc"]
rhs_r, rhs_f = defs["__yo_realloc"], defs["__yo_free"]
rhs_aa, rhs_af = defs["__yo_aligned_alloc"], defs["__yo_aligned_free"]

code = r"""
#if !defined(__APPLE__)
/* Linux heap tracking for the peak histogram: the emitted C routes every
   allocation through these six macros; the wrappers maintain the live set
   (address -> size + return address), record live-bytes marks as it grows,
   and dump the exit composition. Degrade-once when the live set alone fills
   the table — never rehash per allocation (holder_census_t.py has the
   5-CPU-hour failure mode this avoids). */
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#define __PH_TCAP (1u << 27)
#define __PH_TOMB ((void*)1)
static void** __ph_k; static size_t* __ph_v; static void** __ph_ra;
static size_t __ph_n, __ph_t, __ph_allocs; static int __ph_degraded;
static unsigned long long __ph_live_bytes;
static size_t __ph_h(void* p) { size_t x = (size_t)p >> 4; x ^= x >> 17; x *= 0x9E3779B97F4A7C15ull; return (size_t)(x >> 37) & (__PH_TCAP - 1); }
static void __ph_init(void) { if (!__ph_k) { __ph_k = (void**)calloc(__PH_TCAP, sizeof(void*)); __ph_v = (size_t*)calloc(__PH_TCAP, sizeof(size_t)); __ph_ra = (void**)calloc(__PH_TCAP, sizeof(void*)); } }
static void __ph_put(void* p, size_t sz, void* ra);
static void __ph_rehash(void) {
  void** ok = __ph_k; size_t* ov = __ph_v; void** ora = __ph_ra;
  __ph_k = (void**)calloc(__PH_TCAP, sizeof(void*)); __ph_v = (size_t*)calloc(__PH_TCAP, sizeof(size_t)); __ph_ra = (void**)calloc(__PH_TCAP, sizeof(void*));
  __ph_n = 0; __ph_t = 0;
  if (ok) { for (size_t j = 0; j < (size_t)__PH_TCAP; j++) { void* k = ok[j]; if (k && k != __PH_TOMB) __ph_put(k, ov[j], ora[j]); } free(ok); free(ov); free(ora); }
}
static void __ph_put(void* p, size_t sz, void* ra) {
  if (!p) return; __ph_init();
  if ((__ph_n + __ph_t) * 4 >= (size_t)__PH_TCAP * 3) {
    if (!__ph_degraded) { __ph_rehash(); if ((__ph_n + __ph_t) * 4 >= (size_t)__PH_TCAP * 3) __ph_degraded = 1; }
    if (__ph_degraded) return;
  }
  size_t i = __ph_h(p); while (__ph_k[i]) { if (__ph_k[i] == p) { __ph_live_bytes += sz; __ph_live_bytes -= __ph_v[i]; __ph_v[i] = sz; __ph_ra[i] = ra; return; } i = (i + 1) & (__PH_TCAP - 1); }
  __ph_k[i] = p; __ph_v[i] = sz; __ph_ra[i] = ra; __ph_n++; __ph_live_bytes += sz;
}
static void __ph_del(void* p) {
  if (!p || !__ph_k) return;
  size_t i = __ph_h(p); while (__ph_k[i]) { if (__ph_k[i] == p) { __ph_live_bytes -= __ph_v[i]; __ph_k[i] = __PH_TOMB; __ph_v[i] = 0; __ph_ra[i] = 0; __ph_n--; __ph_t++; return; } i = (i + 1) & (__PH_TCAP - 1); }
}
/* ---- growth marks ---- */
#define __PH_MAXMARKS 300
#define __PH_TOPN 10
typedef struct { size_t width; unsigned long long bytes, objs; } __ph_cls_t;
typedef struct { void* ra; unsigned long long bytes, objs; } __ph_siterow_t;
static __ph_cls_t __ph_mark_cls[__PH_MAXMARKS][__PH_TOPN];
static __ph_siterow_t __ph_mark_sites[__PH_MAXMARKS][__PH_TOPN];
/* site aggregation: open-addressed ra -> {bytes, count}; distinct return
   addresses are bounded by the number of allocation call sites (thousands) */
#define __PH_SCAP (1u << 16)
typedef struct { void* ra; unsigned long long bytes; size_t cnt; } __ph_site_t;
static __ph_site_t __ph_sites[__PH_SCAP]; static size_t __ph_nsites;
static size_t __ph_sh(void* ra) { size_t x = (size_t)ra >> 3; x ^= x >> 17; x *= 0x9E3779B97F4A7C15ull; return (size_t)(x >> 40) & (__PH_SCAP - 1); }
static void __ph_site_add(void* ra, size_t sz) {
  size_t i = __ph_sh(ra);
  while (__ph_sites[i].ra && __ph_sites[i].ra != ra) i = (i + 1) & (__PH_SCAP - 1);
  if (!__ph_sites[i].ra) { if (__ph_nsites < __PH_SCAP - 1) __ph_nsites++; __ph_sites[i].ra = ra; }
  __ph_sites[i].bytes += sz; __ph_sites[i].cnt++;
}
static int __ph_site_cmp(const void* a, const void* b) {
  const __ph_site_t* x = a; const __ph_site_t* y = b;
  if (x->bytes > y->bytes) return -1; if (x->bytes < y->bytes) return 1; return 0;
}
static size_t __ph_class_width(size_t sz);
static unsigned long long __ph_mark_bytes[__PH_MAXMARKS];
static unsigned long long __ph_mark_objs[__PH_MAXMARKS];
static unsigned long long __ph_mark_allocs[__PH_MAXMARKS];
static int __ph_nmarks;
static unsigned long long __ph_last_snap_ns;
static unsigned long long __ph_now_ns(void) { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return (unsigned long long)ts.tv_sec * 1000000000ull + ts.tv_nsec; }
static int __ph_env_pct(void) { const char* e = getenv("PEAK_PCT"); return e ? atoi(e) : 2; }
static long __ph_env_gap_s(void) { const char* e = getenv("PEAK_GAP_S"); return e ? atol(e) : 5; }
static void __ph_snapshot_if_mark(void) {
  int pct = __ph_env_pct();
  if (__ph_nmarks >= __PH_MAXMARKS) pct = 10; /* thin late growth */
  unsigned long long thresh = __ph_nmarks ? __ph_mark_bytes[__ph_nmarks - 1] / 100 * (unsigned long long)(100 + pct) : 1;
  if (__ph_live_bytes < thresh) return;
  unsigned long long now = __ph_now_ns();
  if (__ph_nmarks && (long)((now - __ph_last_snap_ns) / 1000000000ull) < __ph_env_gap_s()) return;
  if (__ph_nmarks >= __PH_MAXMARKS) return;
  __ph_last_snap_ns = now;
  int m = __ph_nmarks++;
  __ph_mark_bytes[m] = __ph_live_bytes; __ph_mark_objs[m] = __ph_n; __ph_mark_allocs[m] = __ph_allocs;
  /* ONE registry sweep builds this mark's size-class table and site table,
     then insertion into the per-mark top-N slots (no nested scans). */
  {
    #define __PH_WCAP2 512
    static size_t w_key[__PH_WCAP2]; static unsigned long long w_obj[__PH_WCAP2], w_byte[__PH_WCAP2];
    memset(w_key, 0, sizeof(w_key)); memset(w_obj, 0, sizeof(w_obj)); memset(w_byte, 0, sizeof(w_byte));
    memset(__ph_sites, 0, sizeof(__ph_sites)); __ph_nsites = 0;
    for (size_t i = 0; i < (size_t)__PH_TCAP; i++) {
      void* k = __ph_k ? __ph_k[i] : NULL;
      if (!k || k == __PH_TOMB) continue;
      size_t w = __ph_class_width(__ph_v[i]);
      size_t j = (w >> 4) & (__PH_WCAP2 - 1);
      while (w_key[j] && w_key[j] != w) j = (j + 1) & (__PH_WCAP2 - 1);
      if (!w_key[j]) w_key[j] = w;
      w_obj[j]++; w_byte[j] += __ph_v[i];
      __ph_site_add(__ph_ra[i], __ph_v[i]);
    }
    memset(__ph_mark_cls[m], 0, sizeof(__ph_mark_cls[m]));
    for (size_t j = 0; j < __PH_WCAP2; j++) if (w_key[j]) {
      for (int t = 0; t < __PH_TOPN; t++) {
        if (w_byte[j] > __ph_mark_cls[m][t].bytes) {
          for (int u = __PH_TOPN - 1; u > t; u--) __ph_mark_cls[m][u] = __ph_mark_cls[m][u - 1];
          __ph_mark_cls[m][t].width = w_key[j]; __ph_mark_cls[m][t].bytes = w_byte[j]; __ph_mark_cls[m][t].objs = w_obj[j];
          break;
        }
      }
    }
    qsort(__ph_sites, __PH_SCAP, sizeof(__ph_site_t), __ph_site_cmp);
    memset(__ph_mark_sites[m], 0, sizeof(__ph_mark_sites[m]));
    for (int t = 0; t < __PH_TOPN && t < (int)__PH_SCAP && __ph_sites[t].ra; t++) {
      __ph_mark_sites[m][t].ra = __ph_sites[t].ra;
      __ph_mark_sites[m][t].bytes = __ph_sites[t].bytes;
      __ph_mark_sites[m][t].objs = __ph_sites[t].cnt;
    }
  }
}
#undef __yo_malloc
#undef __yo_calloc
#undef __yo_realloc
#undef __yo_free
#undef __yo_aligned_alloc
#undef __yo_aligned_free
__attribute__((noinline)) static void* __yo_malloc(size_t n) { void* p = %(rhs_m)s(n); if (p) { __ph_allocs++; __ph_put(p, n, __builtin_return_address(0)); __ph_snapshot_if_mark(); } return p; }
__attribute__((noinline)) static void* __yo_calloc(size_t a, size_t b) { void* p = %(rhs_c)s(a, b); if (p) { __ph_allocs++; __ph_put(p, a * b, __builtin_return_address(0)); __ph_snapshot_if_mark(); } return p; }
__attribute__((noinline)) static void* __yo_realloc(void* q, size_t n) { void* p = %(rhs_r)s(q, n); if (p) { if (p != q) __ph_del(q); __ph_put(p, n, __builtin_return_address(0)); __ph_snapshot_if_mark(); } else if (n == 0) __ph_del(q); return p; }
__attribute__((noinline)) static void __yo_free(void* q) { if (q) __ph_del(q); %(rhs_f)s(q); }
__attribute__((noinline)) static void* __yo_aligned_alloc(size_t a, size_t n) { void* p = %(rhs_aa)s(a, n); if (p) { __ph_allocs++; __ph_put(p, n, __builtin_return_address(0)); __ph_snapshot_if_mark(); } return p; }
__attribute__((noinline)) static void __yo_aligned_free(void* q) { if (q) __ph_del(q); %(rhs_af)s(q); }
/* size class: 16 B buckets for 16..4096 (label = width), then powers of two
   (label = > lower bound). Returns the class label's numeric width, or 0 for
   the >max bucket. */
static size_t __ph_class_width(size_t sz) {
  if (sz == 0) return 16;
  if (sz <= 4096) return ((sz + 15) / 16) * 16;
  size_t b = 8192;
  while (sz > b && b < (1ull << 32)) b <<= 1;
  return b; /* label rendered as "> b/2" by the caller */
}
__attribute__((destructor)) static void __ph_dump_atexit(void);
static void __ph_dump_atexit(void) {
  FILE* f = fopen("%(dump)s", "w"); if (!f) return;
  {
    char exe[512] = {0}; ssize_t ne = readlink("/proc/self/exe", exe, sizeof(exe) - 1);
    FILE* mf = fopen("/proc/self/maps", "r"); char mline[1024];
    while (ne > 0 && mf && fgets(mline, sizeof(mline), mf)) {
      unsigned long long s, off; char perms[8]; char path[600] = "";
      if (sscanf(mline, "%%llx-%%*x %%7s %%llx %%*s %%*s %%599s", &s, perms, &off, path) >= 3 &&
          off == 0 && path[0] == '/' && strncmp(path, exe, (size_t)ne) == 0) { fprintf(f, "# base %%llx\n", s); break; }
    }
    if (mf) fclose(mf);
  }
  fprintf(f, "# marks %%d live_bytes_at_exit %%llu degraded %%d total_allocs %%llu\n", __ph_nmarks, __ph_live_bytes, __ph_degraded, __ph_allocs);
  for (int m = 0; m < __ph_nmarks; m++) {
    fprintf(f, "M %%d %%llu %%llu %%llu\n", m, __ph_mark_bytes[m], __ph_mark_objs[m], __ph_mark_allocs[m]);
    for (int t = 0; t < __PH_TOPN; t++) if (__ph_mark_cls[m][t].width)
      fprintf(f, "C %%d %%zu %%llu %%llu\n", m, __ph_mark_cls[m][t].width, __ph_mark_cls[m][t].objs, __ph_mark_cls[m][t].bytes);
    for (int t = 0; t < __PH_TOPN; t++) if (__ph_mark_sites[m][t].ra)
      fprintf(f, "A %%d %%d %%llu %%llu %%p\n", m, t, __ph_mark_sites[m][t].bytes, __ph_mark_sites[m][t].objs, __ph_mark_sites[m][t].ra);
  }
  /* exit composition: one registry pass feeds both the size-class histogram
     (up to 256+33 distinct widths, hashed into a small table) and the site
     table — no nested scans. */
  {
    #define __PH_WCAP 512
    static size_t w_key[__PH_WCAP]; static unsigned long long w_obj[__PH_WCAP], w_byte[__PH_WCAP];
    for (size_t i = 0; i < (size_t)__PH_TCAP; i++) {
      void* k = __ph_k ? __ph_k[i] : NULL;
      if (!k || k == __PH_TOMB) continue;
      size_t w = __ph_class_width(__ph_v[i]);
      size_t j = (w >> 4) & (__PH_WCAP - 1);
      while (w_key[j] && w_key[j] != w) j = (j + 1) & (__PH_WCAP - 1);
      if (!w_key[j]) w_key[j] = w;
      w_obj[j]++; w_byte[j] += __ph_v[i];
      __ph_site_add(__ph_ra[i], __ph_v[i]);
    }
    for (size_t j = 0; j < __PH_WCAP; j++) if (w_key[j])
      fprintf(f, "C %%zu %%llu %%llu\n", w_key[j], w_obj[j], w_byte[j]);
  }
  {
    int top = 30; { const char* e = getenv("PEAK_TOP"); if (e) top = atoi(e); }
    qsort(__ph_sites, __PH_SCAP, sizeof(__ph_site_t), __ph_site_cmp);
    for (int r = 0; r < top && r < (int)__PH_SCAP && __ph_sites[r].ra; r++)
      fprintf(f, "A %%d %%llu %%zu %%p\n", r, __ph_sites[r].bytes, __ph_sites[r].cnt, __ph_sites[r].ra);
  }
  fclose(f);
}
#endif
""" % dict(rhs_m=rhs_m, rhs_c=rhs_c, rhs_r=rhs_r, rhs_f=rhs_f, rhs_aa=rhs_aa, rhs_af=rhs_af, dump=dump_path)

anchor_end = blk.end()
src = src[:anchor_end] + code + src[anchor_end:]
Path(out_path).write_text(src)
print("peak histogram injected")
