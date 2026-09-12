# An unknown identifier inside an `io.async` body passes `yo check`; the build dies with an ICE

**Status: FIXED 2026-09-12** (`src/evaluator/context.yo` `hard_swallow_diagnostic`).
Found writing `src/fetch.yo`'s `fetch_package`: the file used `println` without
importing it, `yo check ./src` reported 273/273 OK, and `yo build` failed with

```
internal compiler error: src/fetch.yo:569:27: this `io.async` closure's body was never
fully evaluated — an error inside it was deferred at definition time and never re-checked
```

Bisecting the body statement by statement took a dozen compiles; `YO_DEBUG_SWALLOW=1 yo
check` would have printed the swallowed `Variable "println" not found.` at once (the
diagnostics registry says so — worth remembering).

## Reproducer

```rust
{ String } :: import("std/string");
{ Exception, IoExn } :: import("std/error");
f :: (fn(flag : bool, io : Io, exn : Exception) -> Impl(Future(String, IoExn)))(
  io.async((e : IoExn) => {
    if(flag, {
      totally_unknown_fn(`x`);
    });
    String.from("v")
  })
);
```

`yo check` → evaluator OK. The same call in a plain `fn` body is `error[E0401]`.

## Root cause

A closure body is trial-evaluated at definition time by `_trial_eval_anon_body`
(`src/evaluator/values/anonymous_function.yo`), whose handler SWALLOWS every throw — a
closure body may legitimately fail before its parameter types are known (the bare-`e`
io.async shape, generic element types), so the wall is deliberate. Only the classes
`hard_swallow_diagnostic` (`src/evaluator/context.yo`) names are re-raised: a forward
reference to a later runtime binding, and an argument-count mismatch. An unbound name
that is bound NOWHERE was not one of them, so it hollowed the body silently. A concrete
`fn` body has no such wall (its trial re-raises every swallow, TS parity), which is why
the plain-function form is caught. An `io.async` closure is never re-evaluated at a
call, so definition time was the only chance.

## Fix

`Variable "x" not found.` joins the hard swallow classes: Yo scopes lexically, a
module-level name is forced on the miss (lazy top-level bindings) and a later runtime
binding is already the forward-reference class, so a miss that survives to the swallow
is a typo or a missing import that no later call can bind. The class applies to both
silent trial sites (closure bodies and deferred-generic bodies); `check ./src` and
`check ./std` stay green.

## Gates

- `tests/cli-cases/check-async-body-unknown-identifier` — `yo check` rc 1 with the
  E0401 (the pre-fix compiler scores it NO-GOLDEN vacuous: it prints no error).
- The `check-dyn-unresolved-payload` case (the sibling swallow through `dyn`) stays
  green.
