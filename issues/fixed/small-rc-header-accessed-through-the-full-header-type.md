# A small RC header is read through the full 56-byte header type (UB)

**Status: FIXED 2026-09-23** (branch `safe-mode-5-ubsan`, `plans/SAFE_MODE.md`
§14 R6, the first finding of the UBSan acceptance run).

## Symptom

A self-built compiler compiled with `--sanitize undefined` aborted 2.4 s into
`yo check ./src`, on the first reference-count increment:

```
yo-ubsan.c:50093:11: runtime error: member access within address 0x000104e87210
with insufficient space for an object of type '__yo_ref_header_t'
    #0 0x00010490dc40 in __yo_main_thread_entry+0xc0
SUMMARY: UndefinedBehaviorSanitizer: undefined-behavior yo-ubsan.c:50093:11
```

Line 50093 is `header->ref_count++` in `__yo_incr_rc`.

## Root cause

The RC header split (`plans/backlog/RC_HEADER_SPLIT.md`) gives
cycle-incapable, non-atomic types a 16-byte `__yo_ref_header_small_t`, which
is a strict prefix of the 56-byte `__yo_ref_header_t`. The code that sees
both layouts cast every object to `__yo_ref_header_t*` and, by design,
touched only the prefix fields on untracked objects. That code is
`__yo_incr_rc`/`__yo_decr_rc`, the atomic pair, the borrow checks, the
`rc()` builtin, and every GC visitor's `TRACKED` test.

Touching only prefix fields does not make it defined. A member access through
an lvalue of struct type requires the object to be at least that large. On
a 16-byte allocation, `((__yo_ref_header_t*)p)->ref_count` is undefined
behavior. The C compiler may assume the full 56 bytes are dereferenceable,
and UBSan's object-size check reports it. It is harmless on every compiler
Yo targets today, but it is exactly the kind of latent UB that safe mode's
Promise A rules out.

## Fix

A layout-agnostic view, `__yo_rc_prefix_t`, is defined in both header
layouts. In cycle-GC mode it is the small header; in lightweight mode there
is only one header, so it is that header. Every access that can see an
untracked object now reads through `__yo_rc_prefix_t*`:

- `__yo_incr_rc` / `__yo_decr_rc` (the untracked fast path)
- the atomic pair
- `__yo_borrow_*`
- `rc()` (`src/codegen/exprs/rc_fns.yo`)

`__yo_gc_unregister` and all six GC visitors test `TRACKED` through the prefix
*before* casting to the full header. `__yo_gc_scan_visitor` and
`__yo_gc_gather_white_visitor` previously cast without testing at all; the
test is behavior-preserving there, because an untracked object never carries
the `TRIAL_DELETED`/`GARBAGE` marks those functions check. Paths reached only
by tracked objects (`__yo_decr_rc_tracked`, register, the root lists) keep the
full header. `__yo_gc_register` is emitted only for cycle-capable types, which
are exactly the full-header types.

## Regression test

Two tests in `tests/internal/gc_runtime_atomics.test.yo` check the emitted
runtime text directly. The first checks that the prefix-only functions never
cast to `__yo_ref_header_t*`. The second checks that each visitor's `TRACKED`
test through the prefix precedes its full-header cast. Both fail on the old
template text. The end-to-end oracle is the UBSan run of a self-built
compiler over `yo check ./src`.
