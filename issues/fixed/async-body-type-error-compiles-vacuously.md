# A type error inside an `io.async` closure body compiles vacuously (runs nothing, exits 0)

- **Status**: FIXED 2026-09-02 (#390 — poison gates at both io.async emitters)
- **Found**: 2026-09-02 (STD API audit, handover §0c scoping)
- **Family**: def-eval trial swallow → silent codegen hollowing. Siblings:
  `issues/fixed/trait-default-awaiting-self-async-method-emits-hollow-fn.md`
  (C22 `_sync_fut_t` class), `issues/fixed/self-hosted-compile-swallows-undefined-call.md`,
  `issues/fixed/wrong-arity-call-silently-accepted-version-install-broken.md` (its
  async-SM follow-up section).

## The error

There is NO error — that is the bug. `yo check` passes, `yo compile`
succeeds, and the binary runs to completion (rc=0) having executed none of
the async closure's body.

## Minimal reproducer

```rust
{ yield } :: import("std/async");
open(import("std/fmt"));

do_bad :: (fn(io : Io) -> Impl(Future(unit, Io)))(
  io.async((io : Io) => { b := (i32(1) && i32(2)); println(b.to_string()); })
);

main :: (fn(io : Io) -> unit)({
  io.await(do_bad(io), io);
});
export(main);
```

`i32(1) && i32(2)` is a type error (`Expected bool type for "and" argument`).
Expected: a compile error. Actual (measured on the develop-era binary
2026-09-02): `check` rc=0, `compile` rc=0, the binary runs rc=0 and prints
nothing. The good twin (`true && false`) prints `false`, proving the harness
shape itself is sound.

A variant with the type error AFTER an `io.await` in the body (await first,
`b := (i32(1) && i32(2));` second) behaves identically — it also routes to
the sync-future fallback, because the await analysis is only stamped when the
whole body trial succeeds.

## Root cause

`_trial_eval_anon_body` (src/evaluator/values/anonymous_function.yo) swallows
every error from the def-time trial of a closure body — the deliberate
deferred-generic deferral family. For a body whose error is real (not a
missing-generic deferral), nothing ever re-raises it: the re-run at the call
site fails the same way and is swallowed again. The body block therefore
never completes evaluation and never receives `ExprInfo`.

Codegen then routes the `io.async` call by await analysis: absent analysis →
`generate_io_async_sync_call` (the `_sync_fut_t` class). That emitter happily
synthesizes a future whose resume calls the closure's C function — a function
whose body statements were all skipped as unevaluated. The future runs
nothing and completes.

(An earlier probe with the type error inside a trait `?=` default's
`io.async` body fails differently — noisily, at the C level, with
`use of undeclared identifier` on the hollowed trait type — so that shape is
not silent and is out of scope here.)

## Fix

Poison gates at both `io.async` emitters (src/codegen/exprs/async.yo):
`generate_io_async_sync_call` and `generate_async_block` (the FSM path) call
`codegen_fatal` when the closure's body block carries no `ExprInfo` — the
same "a diagnostic the C compiler can skip is not a diagnostic" stance as
`codegen_fatal_expr`. The diagnostic points at the body's source position:

```
yo: error: tmp/poison_sync.yo:8:25: this `io.async` closure's body was never fully evaluated — an error inside it was deferred at definition time and never re-checked, so the emitted sync-future future would run nothing and silently complete.
Fix the error inside the body. Common causes: a type error the deferred trial swallowed, a forward reference (move the definition above its use), or a call with the wrong argument count.
```

Verified: both repro shapes now fail with the diagnostic; the good twin, a
VALID dead (uncalled) `io.async` closure, and nested `io.async` closures all
still compile and run correctly (no false positives — a valid body's def-time
trial succeeds even when the closure is never called).

The FSM-path gate's fire branch has no reproducer yet (every repro routes to
the sync path once the body trial fails); it is kept as the same invariant,
exercised silent by every valid FSM async in the suite.
