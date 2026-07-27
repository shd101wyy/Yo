#!/usr/bin/env python3
"""Split __yo_decr_rc into an always-inline fast path + outlined slow path.

Experiment harness for plans/PERF_BORROW_ELISION.md: patches an ALREADY-EMITTED
yo-self .c file so the hypothesis (call overhead + cross-call register spills at
~254k decr_rc sites dominate) can be A/B'd without a 10-minute s1 rebuild.
"""
import re
import sys

src, dst = sys.argv[1], sys.argv[2]
text = open(src).read()

# 1. Forward declaration: announce the outlined slow path too.
FWD = "static inline void __yo_decr_rc(void* ptr); // Decrement reference count"
assert text.count(FWD) >= 1, "forward decl not found"
text = text.replace(
    FWD,
    "static void __yo_decr_rc_slow(void* ptr); // Decrement reference count (outlined slow path)\n"
    "__attribute__((always_inline)) static inline void __yo_decr_rc(void* ptr); "
    "// Decrement reference count",
    1,
)

# 2. Definition: rename the full body to the slow path and prepend the fast path.
DEF = "static inline void __yo_decr_rc(void* ptr) {"
i = text.index(DEF)
FAST = """__attribute__((always_inline)) static inline void __yo_decr_rc(void* ptr) {
  // FAST PATH (inlined at every call site): untracked object whose refcount is
  // not about to hit zero — a pure header decrement. Everything else (NULL,
  // last reference, GC-tracked) defers to the outlined slow path so the common
  // case costs no call, no register spills across the call, and no icache miss.
  if (ptr == NULL) return;
  __yo_ref_header_t* __yo_h = (__yo_ref_header_t*)ptr;
  uint32_t __yo_rc = __yo_h->ref_count;
  if (__builtin_expect(__yo_rc > 1 && !(__yo_h->gc_flags & __YO_GC_TRACKED), 1)) {
    __yo_h->ref_count = __yo_rc - 1;
    return;
  }
  __yo_decr_rc_slow(ptr);
}

static void __yo_decr_rc_slow(void* ptr) {"""
text = text[:i] + FAST + text[i + len(DEF):]

open(dst, "w").write(text)
print(f"patched -> {dst}")
