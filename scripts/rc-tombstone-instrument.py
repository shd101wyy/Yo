#!/usr/bin/env python3
"""Instrument an emitted stage-2 C file with an RC tombstone + event-ring detector.

Usage: python3 scripts/rc-tombstone-instrument.py /tmp/stage2-vNN.c /tmp/stage2-vNN-ts.c
Then:  clang -std=c11 -fno-strict-aliasing -fwrapv -w -O1 /tmp/stage2-vNN-ts.c -o /tmp/s2ts
       YO_MAIN_STACK_MB=16384 /tmp/s2ts check /tmp/t1.yo 2> ts.log
On the first incr/decr of a freed RC object it prints: the USE backtrace, the
FREE backtrace, and the object's full incr/decr history (per-op backtraces from
a 4M-event ring). Frees are QUARANTINED (never reused), so detection is exact
and deterministic without gmalloc. See
issues/yo-self-stage2-unwind-check-coverage.md (drain workflow).
"""
import sys

src = open(sys.argv[1]).read()

detector = r'''
// ===== RC tombstone detector + event ring (debug instrumentation) =====
#include <execinfo.h>
#include <stdlib.h>
#define __YO_TS_CAP (1u<<22)
#define __YO_TS_BTN 8
#define __YO_RG_CAP (1u<<22)
#define __YO_RG_BTN 6
typedef struct { void* p; int op; void* bt[__YO_RG_BTN]; } __yo_rg_ev;
static __yo_rg_ev* __yo_rg;
static unsigned __yo_rg_idx = 0;
static void** __yo_ts_tab;
static void** __yo_ts_fbt;
static int __yo_ts_init_done = 0;
static void __yo_ts_init(void){
  if(__yo_ts_init_done) return;
  __yo_ts_init_done = 1;
  __yo_ts_tab = (void**)calloc(__YO_TS_CAP, sizeof(void*));
  __yo_ts_fbt = (void**)calloc((size_t)__YO_TS_CAP*__YO_TS_BTN, sizeof(void*));
  __yo_rg = (__yo_rg_ev*)calloc(__YO_RG_CAP, sizeof(__yo_rg_ev));
}
static inline unsigned __yo_ts_h(void* p){ unsigned long long x=(unsigned long long)p; x^=x>>33; x*=0xff51afd7ed558ccdULL; x^=x>>33; return (unsigned)(x & (__YO_TS_CAP-1)); }
static void __yo_rg_log(void* p, int op){
  __yo_ts_init();
  __yo_rg_ev* e = &__yo_rg[(__yo_rg_idx++) & (__YO_RG_CAP-1)];
  e->p = p; e->op = op;
  void* bt[__YO_RG_BTN+2]; int n = backtrace(bt, __YO_RG_BTN+2);
  for(int k=0;k<__YO_RG_BTN;k++) e->bt[k] = (k+2<n)? bt[k+2] : NULL;
}
static void __yo_rg_dump(void* p){
  fprintf(stderr, "[RG] history for %p (newest last):\n", p);
  unsigned total = (__yo_rg_idx < __YO_RG_CAP)? __yo_rg_idx : __YO_RG_CAP;
  for(unsigned k=0;k<total;k++){
    unsigned i2 = (__yo_rg_idx - total + k) & (__YO_RG_CAP-1);
    if(__yo_rg[i2].p != p) continue;
    fprintf(stderr, "[RG] op=%s\n", __yo_rg[i2].op==1?"INCR":(__yo_rg[i2].op==2?"DECR":"FREE"));
    backtrace_symbols_fd(__yo_rg[i2].bt, __YO_RG_BTN, 2);
  }
  fprintf(stderr, "[RG] end history\n");
}
static void __yo_ts_bt(const char* what, void* p){
  fprintf(stderr, "[TS] %s %p\n", what, p);
  void* bt[24]; int n = backtrace(bt, 24);
  backtrace_symbols_fd(bt, n, 2);
  fprintf(stderr, "[TS] ----\n");
}
static void __yo_ts_add(void* p){
  __yo_ts_init();
  unsigned i=__yo_ts_h(p);
  while(__yo_ts_tab[i] && __yo_ts_tab[i]!=p) i=(i+1)&(__YO_TS_CAP-1);
  __yo_ts_tab[i]=p;
  void* bt[__YO_TS_BTN+2]; int n = backtrace(bt, __YO_TS_BTN+2);
  for(int k=0;k<__YO_TS_BTN;k++) __yo_ts_fbt[(size_t)i*__YO_TS_BTN+k] = (k+2<n)? bt[k+2] : NULL;
}
static void __yo_ts_check(void* p, const char* op){
  __yo_ts_init();
  unsigned i=__yo_ts_h(p);
  while(__yo_ts_tab[i]){
    if(__yo_ts_tab[i]==p){
      __yo_ts_bt("USE-AFTER-FREE (use site)", p);
      fprintf(stderr, "[TS] freed at:\n");
      backtrace_symbols_fd(&__yo_ts_fbt[(size_t)i*__YO_TS_BTN], __YO_TS_BTN, 2);
      __yo_rg_dump(p);
      abort();
    }
    i=(i+1)&(__YO_TS_CAP-1);
  }
}
#define __yo_ts_free(p) __yo_ts_add(p)
// ===== end detector =====

'''

anchor = 'static inline void __yo_decr_rc(void* ptr) {'
i = src.index(anchor)
src = src[:i] + detector + src[i:]

old_decr = '''static inline void __yo_decr_rc(void* ptr) {
  if (ptr == NULL) return;
  __yo_ref_header_t* header = (__yo_ref_header_t*)ptr;
'''
new_decr = '''static inline void __yo_decr_rc(void* ptr) {
  if (ptr == NULL) return;
  __yo_ts_check(ptr, "DECR");
  __yo_rg_log(ptr, 2);
  __yo_ref_header_t* header = (__yo_ref_header_t*)ptr;
'''
assert old_decr in src
src = src.replace(old_decr, new_decr, 1)

j = src.index(new_decr)
# Bound the decr body by the start of the incr function so a fixed window
# cannot bleed into a following function's __yo_free(ptr) (the decr->incr gap
# shrinks as the emitted fast/tracked paths evolve).
body_end = src.index('static inline void* __yo_incr_rc(void* ptr) {', j)
seg = src[j:body_end]
assert seg.count('__yo_free(ptr);') == 2
seg = seg.replace('__yo_free(ptr);', '__yo_ts_free(ptr);', 2)
src = src[:j] + seg + src[body_end:]

old_incr = '''static inline void* __yo_incr_rc(void* ptr) {
  if (ptr == NULL) return NULL;
  __yo_ref_header_t* header = (__yo_ref_header_t*)ptr;
'''
new_incr = '''static inline void* __yo_incr_rc(void* ptr) {
  if (ptr == NULL) return NULL;
  __yo_ts_check(ptr, "INCR");
  __yo_rg_log(ptr, 1);
  __yo_ref_header_t* header = (__yo_ref_header_t*)ptr;
'''
assert old_incr in src
src = src.replace(old_incr, new_incr, 1)

open(sys.argv[2], 'w').write(src)
print(f"instrumented -> {sys.argv[2]}")
