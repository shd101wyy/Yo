# A capturing closure's type satisfies `where(T <: Send)`, so `arc(f)` and `Channel(typeof(f))` pass `yo check` with a non-Send capture

**Found:** 2026-09-25, parallelism-soundness audit (`plans/PARALLELISM_SOUNDNESS.md`, finding P-3).
**Status:** FIXED 2026-09-26 (`plans/PARALLELISM_SOUNDNESS.md` Phase 4). Was: OPEN. **Class:** `yo check` accepts a program that violates the `Send` model; the
C compiler rejects the emitted code, so there is no runtime hole TODAY — but the rejection is
an accident of codegen (a capture-struct typedef mismatch), not a rule, and the next codegen
fix in that area turns this into a data race.
**Measured:** yo 0.2.41 seed against the develop tree's `std`, macOS arm64.

## Repro

`issues/repros/closure-through-arc-passes-check.yo`:

```rust
main :: (fn() -> unit)({
  items := ArrayList(i32).new();
  (f : Impl(Fn() -> unit)) = (
    () => {
      items.push(i32(1));
    }
  );
  a := arc(f);                       // Arc(V) requires V <: (Send, Acyclic) — accepted
  t := Thread(unit).spawn((io : Io) => {
    g := a.*;
    g();
    ()
  });
  items.push(i32(2));
  t.join();
});
```

`issues/repros/closure-through-channel-passes-check.yo` is the same through
`Channel(typeof(f)).new(usize(1))` + `ch.send(f)`. Both: `yo check` green; `yo compile` fails in
clang with `incompatible pointer types returning '__yo_t_… *' from a function with result type
'__yo_t_… *'` (two different capture-struct typedefs for the one closure).

For contrast, the spawn-boundary check does the right thing: the same `f` captured directly by
the spawn closure is rejected ("Captured variable 'cb' (type Impl : (Fn(Io) -> unit)) does not
implement Send"), and a struct field holding it (`Holder(typeof(g))(f : g)`) is rejected too.

## Mechanism (READ, partly)

`where(V <: Send)` on `Arc` / `Channel` is discharged by `type_implements_trait` on the closure's
type. `src/evaluator/trait_checking.yo` ~900 has an explicit arm: a `.Func` type answers `Send`
and `Acyclic` with `direct_true`, with the comment that "a closure's state is judged where it is
captured" and "a capturing closure cannot flow into a bare `fn` slot". The second claim is true
for `fn` PARAMETER slots; it is not true for a generic type parameter `V` instantiated from
`typeof(f)` / an argument's type, which is how `arc(f)` and `Channel(typeof(f))` reach it. (What
`Type.impls(typeof(f), Send)` answers directly could not be observed: `comptime_print` inside a
fn body is silent under `check`.)

The spawn-boundary check is per-CAPTURE (`validate_capture_trait_requirements`, resolved
through `_capture_judgement_type` to the closure's capture struct); the where-clause check never
sees the capture struct.

## Fix direction

A closure type is `Send` iff its capture struct is (Rust's auto-trait rule), everywhere — not
only at the capture site. In `trait_checking.yo` the `.Func` arm must resolve a closure value's
capture struct (the same `get_closure_capture_info(func_id)` lookup
`_capture_judgement_type` uses) and judge THAT; a bare fn pointer with no capture info stays
`direct_true`. Then `arc(f)` and `Channel(typeof(f))` are rejected with the standard E0602
"does not implement required trait Send". Regression: both repros as `comptime_expect_error`
in `tests/thread_safety.test.yo`, plus an over-rejection canary (`arc` of a closure over an
`AtomicI32` stays green).

## Fix (2026-09-26, rule D4)

The hole was one line upstream of the `.Func` arm the fix direction named:
`validate_where_constraints_for_call` (`src/evaluator/calls/helper.yo`) enforced marker bounds
only against FULLY CONCRETE bound types, and a closure's type is an `Impl(Fn(...))` SomeT, so
`where(V <: Send)` was never checked for one at all. Now a bound type that is a closure's SomeT
is judged by its capture struct — resolved with `_capture_judgement_type`, the same resolution
the spawn-boundary check uses, falling back to the closure value bound to that type in the
callee env (`_closure_value_bound_at_type`) — and no capture struct means it captures nothing and
holds trivially. The `.Func` arm of `trait_checking.yo` (a bare fn pointer: Send) stays.

Tests: `tests/parallelism_soundness.test.yo` — `arc(f)` and a generic `where(T <: Send)` over a
closure capturing an `ArrayList` are rejected; the canary (a closure over an `AtomicI32`
satisfies the bound, and `arc()` of it runs on a thread, which needed P-26) passes.
