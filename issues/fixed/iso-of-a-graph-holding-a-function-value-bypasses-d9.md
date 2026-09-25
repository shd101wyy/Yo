# `Iso` over a graph that holds a function, and `Dyn(Fn(...), Send)` of a closure, carried code that reaches a non-Send global to another thread

**Found:** 2026-09-25, probing rule D9 (`plans/reference/PARALLELISM_RULES.md`) for remaining
routes after `issues/fixed/function-values-bypass-the-d1-reach-walk.md`.
**Status:** FIXED 2026-09-25. **Class:** data race from safe code, no diagnostic. Both repros
compiled and ran.

## Repros

- `Iso` over a struct with a function field:
  `_Wrap :: ref(struct(f : (fn() -> unit)))`, `w := _Wrap(f : _fill)` where `_fill` pushes to a
  non-Send global `g`, then `^w`, extracted and `x.f` called on a spawned thread while `main`
  pushes to `g`. The same with a list of closures, `^xs` over `ArrayList(typeof(k))`.
- `Dyn(Fn(...), Send)` of a closure:
  `(d : Dyn(Fn() -> unit, Send)) = dyn(k)`, where `k` pushes to `g`, then `d()` on a spawned
  thread.

## Mechanism

- **`Iso(T)` is `Send` unconditionally.** That is its purpose: the runtime uniqueness walk
  (D2) proves no other thread holds a reference into the graph. But what a FUNCTION stored in
  the graph does when the receiving thread calls it is not a question of ownership, and nothing
  asked it.
- **At `dyn(...)`, the payload's traits were judged by type.** A closure's `Impl(Fn)` SomeT
  answered `Send` by declaration and resolution. The existing `Send`-dyn walk
  (`_require_send_dyn_methods_reach_no_global`) covers trait METHODS, and an `Fn` dyn has
  none.

## Fix (rule D9)

- **`evaluate_iso_type_call`** (`src/evaluator/calls/iso.yo`) walks `T`'s fields, enum
  variants, tuple members and pointees (with a cycle guard). Every function value the graph can
  hold must be `Send` by D9, judged through `call_function_value_marker`. A bare `fn` field
  (value unknown) and a `Dyn` without `Send` (code unknown) make the `Iso` an error.
- **`_require_dyn_traits_implemented`** (`src/evaluator/values/dyn.yo`) judges a function
  payload's marker traits by its value first.

Tests: three `comptime_expect_error` blocks in `tests/parallelism_soundness.test.yo` (the two
`Iso` shapes and the `dyn` one). The D9 canary also sends a clean closure through `Dyn(Fn() ->
unit, Send)` and `^` over a list of clean closures, and runs both on threads.
