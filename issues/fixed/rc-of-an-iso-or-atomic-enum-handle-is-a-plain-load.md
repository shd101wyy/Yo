# `rc(x)` on an `Iso(T)` or `atomic(ref(enum))` handle is a plain load of a word other threads update atomically

**Found:** 2026-09-25, parallelism-soundness audit (`plans/PARALLELISM_SOUNDNESS.md`, finding P-19;
raised by the runtime sub-audit, verified by reading).
**Status:** FIXED 2026-09-26 (`plans/PARALLELISM_SOUNDNESS.md` Phase 6). Was: OPEN. **Data race** (mixed atomic / non-atomic access to one location is UB under
C11; practically a stale read feeding a `rc(x) == 1` decision).
**Where:** `src/codegen/exprs/rc_fns.yo` ~404-426.

## Mechanism

`rc()` emits the acquire `atomic_load_explicit((_Atomic uint32_t*)&…->ref_count)` only when
`is_atomic_reference_struct_type(arg_type)`; every other RC type — including `.IsoT` (whose
wrapper IS dup'd/dropped with `__yo_incr_rc_atomic` / `__yo_decr_rc_atomic`, `drop_dup.yo`
~268-272, ~553-560) and an `atomic(ref(enum))` — falls to `((__yo_rc_prefix_t*)(x))->ref_count`.
`issues/repros/rc-of-an-iso-handle-is-a-plain-load.yo`: the parent reads `rc(i1)` while the
spawned thread drops its copy with the atomic decrement.

This is the same shape as the fixed `imm` bug the comment above the atomic arm records (an
8-byte load reading garbage), one arm further down.

## Fix direction

Key the arm on "is this type's RC atomic" — the predicate `drop_dup.yo` already uses to pick the
atomic incr/decr (`Iso`, atomic struct, atomic enum) — instead of on the struct case alone, so
`rc()` and the RC ops agree by construction. Once Phase 2 of the plan adds the wrapper
`ref_count == 1` check to `extract`, that check uses the same load. Test:
`tests/iso.test.yo` asserts `rc(i1)` across a spawn (value 1 after join) and the TSan job runs
it.

## Fix (2026-09-26)

`is_atomically_counted_rc_type` (`src/types/guards.yo`) names the three handles `drop_dup.yo`
lowers to the atomic RC ops — atomic reference struct, atomic reference enum, `Iso` — and
`generate_rc_call` (`src/codegen/exprs/rc_fns.yo`) keys its acquire-load arm on it, so `rc()` and
the RC ops agree by construction. Test: `tests/iso.test.yo` "rc() of an Iso handle copied into a
spawned thread reads the atomic count" (the value oracle; the race is the TSan job's).
