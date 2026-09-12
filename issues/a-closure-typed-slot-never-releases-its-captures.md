# A closure-typed slot never releases its captures

**Status:** PARTIALLY FIXED 2026-09-12. The drop/dup walk half landed on
`fix/zst-closure-fn-result`; the capture-struct TEMP half is still open — see
"What is left" below.
**Found:** 2026-09-12, measured on the published **v0.2.31** compiler and std —
this is not a regression, it has always been there.
**Class:** the empty-string drop fallback
(memory `empty-string-drop-fallback-class`).

## Symptom

A `Dispose` counter that must read 1 reads 0. Nothing crashes and nothing is
reported: the object simply never dies.

```rust
_dc := AtomicUsize.new(usize(0));
_Tracked :: atomic(ref(struct(tag : i32)));
impl(_Tracked, Dispose(dispose : (fn(self : Self) -> unit)({
  _p := _dc.fetch_add(usize(1), MemoryOrder.AcqRel);
  ()
})));
run_it :: (fn(f : Impl(Fn() -> unit)) -> unit)(f());

{
  tracked := _Tracked(tag : i32(7));
  (inner : Impl(Fn() -> unit)) = (() => { _x := tracked.tag; () });
  run_it(inner);
};
// _dc == 0   ← should be 1
```

Measured on v0.2.31 (`issues/repros/closure-slot-never-releases-captures.yo`):

| shape | disposes | expected | after this fix |
| --- | --- | --- | --- |
| `tracked` used directly, no closure | 1 | 1 | 1 |
| a plain `ref` struct TEMP passed by value | 1 | 1 | 1 |
| `tracked` captured by a closure LOCAL | 0 | 1 | **0 — see "what is left"** |
| a closure LITERAL passed as an argument | 0 | 1 | **0 — see "what is left"** |
| that closure captured by a second closure | 0 | 1 | **0 — see "what is left"** |
| a closure captured by a `Thread(T).spawn` wrapper | 0 | 1 | **1** |

## Root cause

`generate_drop_code_for_value` / `generate_dup_code_for_value`
(`src/codegen/exprs/drop_dup.yo`) gate every RC decision on
`type_contains_rc_type`, which is `false` for a bare `SomeT`. A closure-typed
slot's static type IS a bare `SomeT` — the `Impl(Fn(...))` wrapper — even
though at runtime the slot carries the argument closure's CAPTURE STRUCT, which
is what `get_type_string` renders and what the C code casts through.

So every RC value reached through a closure-typed slot was invisible to both
walks:

* a closure LOCAL hit the top-level gate — `generate_drop_code_for_value`
  returned `""`, the silent fallback, and the scope-end drop released nothing;
* a closure captured BY another closure hit the same gate one level in — the
  containing capture struct's field walk skipped the `cb` field, so the spawn
  wrapper's release (`_emit_capture_drop_lines`,
  `src/codegen/exprs/parallelism.yo`) reached `.sink` and nothing else.

The second shape is how this surfaced: D18's `Thread(T).spawn` wraps the user's
callback in a result-relaying closure, `(io) => { sink.send(cb(io)); () }`, so
`cb` becomes a captured closure and `tests/thread.test.yo`'s three
dispose-counter tests went from 1 to 0. The counter was right and the wrapper
was wrong.

## Fix

One resolution point, used by both walks:

```rust
_resolve_closure_impl_type :: (fn(ty : TypeValue) -> TypeValue)(
  cond(
    (is_some_type(ty) && type_implements_fn(ty)) => resolve_some_type_to_concrete(ty),
    true => ty
  )
);
_contains_rc :: (fn(ty : TypeValue) -> bool)(
  type_contains_rc_type(_resolve_closure_impl_type(ty))
);
```

`_contains_rc` replaces every `type_contains_rc_type` call in the module (12
sites), and both generators resolve at entry. Drop and dup therefore change
together by construction, which is the invariant this class of bug breaks: a
field that is dup'd must be dropped.

Narrow by construction — only an `Impl(Fn)` SomeT resolves. An `Impl(Future)`
keeps its existing arm (an RC decrement on the state-machine handle, not a
field walk) and every other SomeT is untouched.

## Why this direction is the safe one

The change only ADDS releases, so the failure mode it could introduce is a
double free, not a use-after-free — and a double free is loud. The oracle is a
dispose counter asserting **exactly one**, so both directions are caught:
`0` is the leak this fixes, `2` would be the over-release it must not cause.

## What is left — a SECOND defect in the same measurement

The walk fix above is necessary and lands the `Thread(T).spawn` case, but it is
not sufficient for the other three rows, which turn out to be a DIFFERENT bug
sharing the same oracle: **a closure literal's capture-struct temp is never
dropped.**

```c
__capture_closure_…_0 = (…){ .tracked = __yo_incr_rc_atomic(tracked) };  // +1
run_it(__capture_closure_…_0);
__yo_decr_rc_atomic(tracked);                                            // -1 (the LOCAL)
// the temp's +1 is never released
```

Compare the same shape with a plain `ref` struct temp, which is handled
correctly — `take_it(_Tracked(tag : i32(7)))` emits a scope-end
`__yo_decr_rc_atomic` on the temp. The closure literal's capture struct is an
owning temp exactly like it, and does not get one.

This is squarely in the dup/drop area the pitfalls file warns about: the
capture-struct dup must NOT be cancelled against the capturing scope's drop
(`_search_dup_calls` skips closure-definition nodes carrying deferred dups —
`issues/fixed/spawn-closure-captures-never-dropped-leak.md`), because the
capture struct can outlive the capturing scope. The missing piece is the temp's
OWN release on the paths where it does not.

It is pre-existing and reproduces identically on v0.2.29, v0.2.30 and v0.2.31,
so it is not a regression from this work. Its red-first tests are written and
parked (they assert exactly one dispose, so they catch both the leak and an
over-release) — they land with the fix, not before.

**Where the fix goes.** The temp is emitted as a raw C declaration by
`_generate_closure_capture` (`src/codegen/exprs/closures.yo`, the
`__capture_<fid>_<n>` line), entirely outside the evaluator's deferred-drop
bookkeeping — which is why it has no scope-end release *by construction*, while
an ordinary owning temp of the same shape does. Two measurements pin the scope
of the missing case: a plain `ref` struct temp passed by value IS released, and
so is a VALUE struct temp carrying an RC field. Only the capture struct is not.

**Why it is not a one-liner.** The capture struct must NOT be released where it
is MOVED rather than copied. `_generate_spawn_call` is exactly that case — its
own comment says "NO dup is added at the call site to match. The heap copy is a
shallow copy of the call-site struct, so it INHERITS that struct's references"
— and the io.async state machine is another. A release added without
distinguishing those turns this leak into a use-after-free, so the change needs
the dup/drop emit-diff gate plus an OVER-release canary per consumer, not just
the dispose counters.

## Tests

`tests/closure.test.yo`:

* a closure local's captures are disposed exactly once at scope end;
* a closure captured by another closure is disposed exactly once;
* the no-closure baseline still disposes exactly once.

`tests/thread.test.yo`'s three existing spawn dispose-counter tests cover the
`Thread(T)` wrapper shape.
