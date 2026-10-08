# The wrapper/payload member clash is not reported inside a generic body

**Severity:** S3: an inconsistency in when a diagnostic fires, not a miscompile. In a generic body, a call that is E0616 outside it keeps its pre-decision-32 meaning (the wrapper's member) with no diagnostic.

> Found 2026-10-08 while landing `plans/VALUES_BY_DEFAULT.md` decision 32 Generation B (#1268).

## Reproducer

```rust
_clone_rc :: (fn(generic(T : Type), w : Rc(T), where(T <: Clone)) -> Rc(T))(w.clone());
main :: (fn() -> unit)({
  e := _clone_rc(rc(i32(2)));
});
export(main);
```

`yo check` accepts it. The same `w.clone()` with `w : Rc(i32)` in a non-generic
function is E0616. The receiver's type is written as the wrapper, so decision 32
says it has two readings, `Rc.clone(w)` and `w.*.clone()`.

## Root cause

The check (`_reject_wrapper_payload_clash` in `src/evaluator/calls/function.yo`,
and the callee arm of `evaluate_property_access`) is off while a generic
function or a generic impl is specialized (`ctx.currently_specializing_function`,
`ctx.is_evaluating_generic_impl_specialization`). That is what the plan
requires for a receiver typed by a type parameter: `x.clone()` under
`where(T <: Clone)` with `T := Rc(i32)` is the bound's method and never the
clash (`tests/deref_auto.test.yo`, "a trait-bound call at a wrapper
instantiation is not the clash"; `std/collections/hash_map.yo`'s `key.hash(h)`
with `K := Rc(i32)`).

The specialized body sees only concrete types, so it cannot tell `w : Rc(T)`
(the wrapper written) from `x : T` with `T := Rc(i32)` (the wrapper
substituted). The definition-time trial, which sees the written types, does not
reach this call: no swallowed E0616 shows under `YO_DEBUG_SWALLOW=1`.

## Fix direction

Decide at definition time. When a generic body is evaluated with its type
parameters abstract, a receiver whose type is a `Deref` wrapper of a type
parameter (`Rc(T)`) and whose payload has the member through its bound
(`T <: Clone`) is the clash. Alternatively, carry the unsubstituted receiver
type into the specialization: the receiver's type before substitution decides.
The test lands with the fix: `_clone_rc` above as a `comptime_expect_error`,
next to the existing trait-bound test that must stay green.
