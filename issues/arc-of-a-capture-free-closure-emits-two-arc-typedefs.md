# `arc(k)` of a capture-free closure still emits two `Arc` instantiations, so clang rejects a valid program

**Found:** 2026-09-25, while probing `issues/function-values-bypass-the-d1-reach-walk.md`.
**Status:** FIXED 2026-09-25. Was: OPEN. **Class:** valid code fails to compile (codegen). The residual of
`issues/fixed/arc-of-a-send-closure-emits-two-capture-struct-typedefs.md` (P-26).
**Measured:** tree-built compiler at `ps/phase2-iso` `d8280ec37`, macOS arm64.

## Repro

`issues/repros/arc-of-a-capture-free-closure-emits-two-arc-typedefs.yo`: a closure that
captures nothing (its body is `println("ran")`), bound to `(k : Impl(Fn() -> unit))`, wrapped
with `arc(k)`, read back as `f := a.*` on a spawned thread and called. `yo check` is green;
`yo compile --optimize 2` fails:

```
error: incompatible pointer types returning '__yo_t_17335061386286930355 *' from a function
       with result type '__yo_t_1628345691991984787 *'
```

The emitted `arc` specialization declares one `Arc` instantiation as its return type and
constructs another in its body, which is P-26's shape exactly. The P-26 canary, a closure that
captures an `AtomicI32`, compiles and runs.

## Mechanism (traced 2026-09-25)

The call-time re-application of `arc`'s `where(V <: (Send, Acyclic))` bound `V` to the
closure's `Impl(Fn() -> unit)` SomeT. Its SomeT branch (`apply_single_trait_constraint` /
`parse_where_clause_constraints`, `src/evaluator/types/function.yo`) judged the bound and
then **added** `Send` and `Acyclic` to that SomeT's required-trait lists. Those lists are
shared by reference, so the caller's own closure type mutated mid-call from
`Impl : (Fn() -> unit)` into `Impl : (Fn() -> unit + Send + Acyclic)`.

`Arc(...)` instances are memoized by their argument, so the signature's `Arc(V)`, taken
before the push, and the body's `Arc(V)(value)`, taken after it, became two instances. The
trace showed the return type re-evaluated and adopted as `Arc(Impl : (Fn() -> unit + Send +
Acyclic))`, with the emitted prototype still naming the pre-push instance. A capturing
closure escaped only because its SomeT resolves through its capture struct, which the push
does not change.

The push was also a latent unsoundness. Afterwards `k`'s type DECLARES `Send`, and a declared
marker is taken as discharged (D9), so anything that pushed `Send` onto a closure SomeT
without judging it laundered the closure.

## Fix

A marker bound that the type's VALUES just discharged (`call_function_value_marker` found and
judged the closure) is not pushed onto the SomeT: the SomeT is the caller's own closure type,
not a type variable whose later instantiation must meet the bound. A bound nothing judged, on
a generic type variable, still propagates as before.

## Regression test

"D4/D9 canary: arc() of a capture-free closure runs on a thread" in
`tests/parallelism_soundness.test.yo`: clang rejected its batch before the fix.
