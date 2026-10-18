# A declared `Impl(Fn(...), Send)` binding of a named function is E0601, so D9's documented workaround does not work

**Severity:** S2: PARALLELISM_RULES D9 tells you to write `(f : Impl(Fn(...), Send)) = count` to make a named function `Send`, and that line is rejected with E0601. A closure literal, `(f : Impl(Fn(...), Send)) = (() => count())`, works.

**Status:** OPEN — waiting on decision 43's function-item types (step 2 of
`issues/retired/2026-10-17-how-a-named-function-value-carries-send.md`).
**Found:** 2026-10-17, probing the routes of
`issues/arc-of-a-named-function-value-fails-its-send-bound.md`, on develop
5425cd7bf.

**Assessment 2026-10-18**, after the retired doc's step 1 landed (the
concrete-vs-SomeT resolution hop,
`issues/fixed/2026-10-17-a-closure-typed-field-accepts-a-named-function-and-emits-invalid-c.md`):
nothing that fix could clear is left. The declared annotation
`Impl(Fn(...), Send)` is a FRESH, UNRESOLVED SomeT at the binding — the new
hop reads its `resolution`, finds none, and keeps the type-level trait test,
which a bare `fn` type fails (D9). `(f : Impl(Fn() -> i32, Send)) = nine`
stays E0601, verified on the tree binary of that fix; the closure-identity
route `(k2 : Impl(Fn() -> i32, Send)) = k` stays accepted, as before. Making
the binding keep the declared SomeT — or a value — on the variable is
exactly step 2's rework of `TypeValue` and `type_key`, so this doc stays open
until then. D9's interim text already recommends the capture-free closure
wrapper (`dyn(() => f())`, `arc(() => f())`), which works today.

## Repro

```yo
nine :: (fn() -> i32)(i32(9));
main :: (fn() -> unit)({
  (f : Impl(Fn() -> i32, Send)) = nine; // E0601
  (g : Impl(Fn() -> i32)) = nine; // accepted; g's type is fn() -> i32
  (h : Impl(Fn() -> i32, Send)) = g; // E0601
  f;
  h;
});
export(main);
```

```
error[E0601]: Incompatible types:
- Expected: Impl(Fn() -> i32 + Send)
- Given   : fn() -> i32
```

A closure goes through: `(k2 : Impl(Fn() -> i32, Send)) = k` with
`(k : Impl(Fn() -> i32)) = (() => nine())` is accepted, and `arc(k2)` compiles.

## Analysis

- **The compatibility check runs before the marker judgement.** In the
  binding path in `src/evaluator/exprs/assignment.yo`, `are_types_compatible`
  runs before `judge_function_argument_markers`.
  - For a concrete `fn() -> i32` against an `Impl` SomeT, compatibility
    requires every listed trait to hold at the type level
    (`src/types/compatibility.yo`, "Concrete (actual) vs SomeType (expected)").
  - A bare `fn` type is never `Send` at the type level (D9), so the check
    fails. The value judgement that D9 promises for this binding never runs.
  - The argument path does it the other way round. It judges the markers
    first and then skips them (`impl_param_unmet_trait(..., fam.judged)`),
    which is why `take(nine)` into `Impl(Fn() -> i32, Send)` is accepted.
- **Reordering alone is not a fix.**
  - The bound variable adopts the right-hand side's type (`ty : rhs_type` in
    the same function), so `f` would be typed `fn() -> i32`. That drops the
    `Send` the declaration made.
  - It keeps no value either. A later spawn closure that captures `f` would
    be judged on the bare type and refused, exactly like `f := nine`.
  - Keeping the promise means keeping a marker-declaring type, or a value, on
    the binding. That is the open decision in
    `issues/retired/2026-10-17-how-a-named-function-value-carries-send.md`.

## Regression test

None yet; it lands with the fix. It needs three cases:
- the clean binding compiles: `(f : Impl(Fn() -> unit, Send)) = _d9_count`;
- a spawn closure that captures `f` compiles;
- the dirty binding is refused with its reach reason:
  `(g : Impl(Fn() -> unit, Send)) = _d9_fill`.
