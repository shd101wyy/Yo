#!/usr/bin/env python3
"""Instrument an emitted yo-self .c with dynamic RC counters.

Answers the question the static call-site counts cannot: at RUNTIME, how many
decr_rc calls happen, what fraction take the untracked fast path, how many
actually free, and how does that compare to incr_rc / allocation traffic.
Prints a report at process exit.
"""
import sys

src, dst = sys.argv[1], sys.argv[2]
text = open(src).read()

COUNTERS = """
/* ---- RC instrumentation (scratchpad/patch_rc_counters.py) ---- */
static unsigned long long __yo_n_decr = 0, __yo_n_decr_fast = 0,
                          __yo_n_decr_free = 0, __yo_n_decr_tracked = 0,
                          __yo_n_incr = 0, __yo_n_alloc = 0;
__attribute__((destructor)) static void __yo_rc_report(void) {
  fprintf(stderr,
    "\\n[RC] decr=%llu (fast=%llu %.1f%%, free=%llu %.1f%%, tracked=%llu %.1f%%)"
    "  incr=%llu  alloc=%llu\\n",
    __yo_n_decr, __yo_n_decr_fast, 100.0*__yo_n_decr_fast/(__yo_n_decr?__yo_n_decr:1),
    __yo_n_decr_free, 100.0*__yo_n_decr_free/(__yo_n_decr?__yo_n_decr:1),
    __yo_n_decr_tracked, 100.0*__yo_n_decr_tracked/(__yo_n_decr?__yo_n_decr:1),
    __yo_n_incr, __yo_n_alloc);
}
/* -------------------------------------------------------------- */
"""

# Counters must be declared before __yo_decr_rc's definition; the GC-state block
# right above it is a stable anchor present in both emitters' output.
ANCHOR = "static _Thread_local int __yo_gc_collecting = 0;"
assert ANCHOR in text
text = text.replace(ANCHOR, ANCHOR + "\n" + COUNTERS, 1)

# decr_rc: total, fast-path (untracked), free, tracked.
OLD_HEAD = """static inline void __yo_decr_rc(void* ptr) {
  if (ptr == NULL) return;
  __yo_ref_header_t* header = (__yo_ref_header_t*)ptr;
"""
NEW_HEAD = """static inline void __yo_decr_rc(void* ptr) {
  if (ptr == NULL) return;
  __yo_ref_header_t* header = (__yo_ref_header_t*)ptr;
  __yo_n_decr++;
  if (!(header->gc_flags & __YO_GC_TRACKED)) __yo_n_decr_fast++; else __yo_n_decr_tracked++;
  if (header->ref_count == 1) __yo_n_decr_free++;
"""
assert text.count(OLD_HEAD) == 1, f"decr head count={text.count(OLD_HEAD)}"
text = text.replace(OLD_HEAD, NEW_HEAD, 1)

OLD_INCR = """static inline void* __yo_incr_rc(void* ptr) {
  if (ptr == NULL) return NULL;
"""
NEW_INCR = """static inline void* __yo_incr_rc(void* ptr) {
  if (ptr == NULL) return NULL;
  __yo_n_incr++;
"""
assert text.count(OLD_INCR) == 1, f"incr head count={text.count(OLD_INCR)}"
text = text.replace(OLD_INCR, NEW_INCR, 1)

# Allocation traffic: the RC allocator entry point.
alloc_head = "static void* __yo_alloc_rc("
i = text.find(alloc_head)
if i >= 0:
    j = text.index("{", i) + 1
    text = text[:j] + "\n  __yo_n_alloc++;" + text[j:]
else:
    sys.stderr.write("warning: __yo_alloc_rc not found; alloc count stays 0\n")

open(dst, "w").write(text)
print(f"instrumented -> {dst}")
