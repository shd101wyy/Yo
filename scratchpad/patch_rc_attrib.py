#!/usr/bin/env python3
"""Attribute decr_rc traffic to CALL SITES via sampled return addresses.

10.8e9 calls/run makes per-call bookkeeping impossible, so sample 1-in-64 into a
fixed open-addressed table keyed by __builtin_return_address(0). decr_rc is
forced noinline so the return address IS the emitting call site. The report
prints slide-relative addresses; symbolize with:

    atos -o <binary> -l <load_addr>   (both printed in the report header)
"""
import sys

src, dst = sys.argv[1], sys.argv[2]
text = open(src).read()

TABLE = """
/* ---- decr_rc call-site attribution (scratchpad/patch_rc_attrib.py) ---- */
#include <mach-o/dyld.h>
#define __YO_RA_BITS 18
#define __YO_RA_SIZE (1u << __YO_RA_BITS)
#define __YO_RA_SAMPLE 63u   /* sample 1 in 64 */
static unsigned long long __yo_ra_key[__YO_RA_SIZE];
static unsigned long long __yo_ra_cnt[__YO_RA_SIZE];
static unsigned long long __yo_ra_tick = 0, __yo_ra_lost = 0;

static void __yo_ra_note(void* ra) {
  unsigned long long k = (unsigned long long)ra;
  unsigned long long h = (k * 0x9E3779B97F4A7C15ULL) >> (64 - __YO_RA_BITS);
  for (unsigned i = 0; i < 16; i++) {
    unsigned long long idx = (h + i) & (__YO_RA_SIZE - 1);
    if (__yo_ra_key[idx] == k) { __yo_ra_cnt[idx]++; return; }
    if (__yo_ra_key[idx] == 0) { __yo_ra_key[idx] = k; __yo_ra_cnt[idx] = 1; return; }
  }
  __yo_ra_lost++;
}

__attribute__((destructor)) static void __yo_ra_report(void) {
  /* selection-sort the top N by count */
  enum { TOPN = 40 };
  unsigned long long bk[TOPN], bc[TOPN];
  for (int i = 0; i < TOPN; i++) { bk[i] = 0; bc[i] = 0; }
  unsigned long long total = 0;
  for (unsigned i = 0; i < __YO_RA_SIZE; i++) {
    if (!__yo_ra_key[i]) continue;
    total += __yo_ra_cnt[i];
    unsigned long long k = __yo_ra_key[i], c = __yo_ra_cnt[i];
    for (int j = 0; j < TOPN; j++) {
      if (c > bc[j]) {
        unsigned long long tk = bk[j], tc = bc[j];
        bk[j] = k; bc[j] = c; k = tk; c = tc;
      }
    }
  }
  const struct mach_header* mh = _dyld_get_image_header(0);
  fprintf(stderr, "\\n[RA] binary_load_addr=%p sampled=%llu lost=%llu (1-in-%u)\\n",
          (void*)mh, total, __yo_ra_lost, __YO_RA_SAMPLE + 1);
  for (int i = 0; i < TOPN && bc[i]; i++) {
    fprintf(stderr, "[RA] %6.2f%%  est_calls=%-14llu  addr=0x%llx\\n",
            100.0 * bc[i] / (total ? total : 1),
            bc[i] * (unsigned long long)(__YO_RA_SAMPLE + 1), bk[i]);
  }
}
/* ----------------------------------------------------------------------- */
"""

ANCHOR = "static _Thread_local int __yo_gc_collecting = 0;"
assert ANCHOR in text
text = text.replace(ANCHOR, ANCHOR + "\n" + TABLE, 1)

# noinline so __builtin_return_address(0) is the real emitting call site.
OLD = """static inline void __yo_decr_rc(void* ptr) {
  if (ptr == NULL) return;
  __yo_ref_header_t* header = (__yo_ref_header_t*)ptr;
"""
NEW = """__attribute__((noinline)) static void __yo_decr_rc(void* ptr) {
  if ((++__yo_ra_tick & __YO_RA_SAMPLE) == 0) __yo_ra_note(__builtin_return_address(0));
  if (ptr == NULL) return;
  __yo_ref_header_t* header = (__yo_ref_header_t*)ptr;
"""
assert text.count(OLD) == 1
text = text.replace(OLD, NEW, 1)
text = text.replace(
    "static inline void __yo_decr_rc(void* ptr); // Decrement reference count",
    "__attribute__((noinline)) static void __yo_decr_rc(void* ptr); // Decrement reference count",
    1,
)

open(dst, "w").write(text)
print(f"attributed -> {dst}")
