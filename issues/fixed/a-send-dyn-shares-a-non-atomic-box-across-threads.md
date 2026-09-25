# A `Dyn(Trait, Send)` shares a non-atomic `Box` across threads

**Found:** 2026-09-25, on PR #902's CI (`ThreadSanitizer (sync primitives — Linux/Clang)`), once
the io_uring false positive (`tsan-reports-a-race-between-two-threads-io-uring-rings.md`) was
out of the way.
**Status:** FIXED 2026-09-25. **Class:** soundness hole (a data race on a reference count in a
program the compiler accepts as thread-safe). The v0.2.42 seed has it too.

## Symptom

```
FAIL tests/parallelism_soundness.test.yo rc=1 spawns=5 tsan_reports=1
    WARNING: ThreadSanitizer: data race
      Write of size 1 at 0x721000002504 by thread T6:
      Previous read of size 1 at 0x721000002504 by thread T1:
      Location is heap block of size 64 at 0x721000002500 allocated by thread T1:
        #3 yo_id_..._Impl____Fn______unit__..._capture_...
    SUMMARY: ThreadSanitizer: data race ... in __yo_gc_add_root
```

The block is the payload of a `Dyn(Fn() -> unit, Send)`. Offset 4 is the RC header's
`gc_flags` byte, which `__yo_decr_rc` writes when it makes an object a cycle-root candidate.

## Repro

```rust
(k : Impl(Fn() -> unit)) = (() => { hits.fetch_add(i32(1), MemoryOrder.AcqRel); (); });
(d : Dyn(Fn() -> unit, Send)) = dyn(k);
ta := Thread(unit).spawn((io : Io) => { d(); () });
tb := Thread(unit).spawn((io : Io) => { d(); () });
d();
ta.join();
tb.join();
```

`yo check` passes. Each thread's copy of `d` retains and releases the same payload.

## Cause

A `Dyn` is a fat pointer `{data, vtable}`, and `data` is a reference-counted object that every
copy shares. `dyn(v)` of a value type auto-boxes it with `box(v)`, a `Box(T)`, and every dup and
drop of a `Dyn` called the non-atomic `__yo_incr_rc` / `__yo_decr_rc` on `data`.

Rule D9 checked that the concrete value is `Send` (for a closure: its captures and the
code it reaches). It did not check the payload the `Dyn` shares. A `Send` bound means copies of
the value live on several threads at once, so its payload's count is written from several
threads. A plain `Box` count cannot take that. An explicit `dyn(box(k))` had the same hole.

## Fix

- **`dyn(v)` into a `Send` Dyn boxes with `arc`** (`src/evaluator/values/dyn.yo`, both the
  executing and the non-executing path). The payload is an `Arc(T)`, an atomic reference object.
  `Arc` gets the same name stamp as `Box` in the CTFE memo (`src/evaluator/calls/comptime_fn.yo`),
  so `is_boxed_type` (`src/types/guards.yo`) recognizes it and the vtable wrappers unbox it.
- **A `Send` Dyn rejects a non-atomic reference payload.** `dyn(box(k))` into
  `Dyn(Fn() -> unit, Send)` fails with "... its payload must be atomically reference counted, and
  Box(...) is not: pass the value itself (`dyn(...)` boxes it with `arc`) or `arc(v)`."
- **A Dyn's payload count goes through its vtable.** The vtable carries `__yo_retain` /
  `__yo_release` slots right after `__yo_type_id`: `__yo_incr_rc_atomic` / `__yo_decr_rc_atomic`
  for an atomic payload, `__yo_incr_rc` / `__yo_decr_rc` otherwise
  (`src/codegen/functions/dyn.yo`, `src/codegen/types/generation.yo`). Every dup and drop of a Dyn
  (`drop_dup.yo`, the async state-machine fields in `async.yo`, the ref-target `downcast.yo`, the
  generated `__yo_dup_` / `__yo_drop_` functions) calls `__yo_dyn_retain` / `__yo_dyn_release`
  (`src/codegen/functions/gc_runtime.yo`). The payload type, not the Dyn type, picks the
  operation. So `Dyn(T)` and `Dyn(T, Send)` over one concrete type get separate vtables: an
  atomic payload's impl key has the suffix `_A` (`src/codegen/exprs/dyn.yo`).

## Regression tests

`tests/parallelism_soundness.test.yo`:

- `comptime_expect_error` on `dyn(box(k))` into `Dyn(Fn() -> unit, Send)`. It compiled before the
  fix.
- "a Dyn(Fn, Send) shared by two threads and the spawner". It is in the TSan thread corpus
  (`scripts/tsan-thread-corpus.sh`), which reported the race above before the fix.
