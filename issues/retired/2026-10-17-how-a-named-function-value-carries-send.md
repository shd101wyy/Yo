# How does a named function value carry `Send` into a generic container?

**Kind:** design question (decided; retired into the plan).

**Status:** DECIDED 2026-10-18: option 1 is the end state, in two scheduled steps. The maintainer delegated the open VBD questions to the coordinator's advisor and accepted its verdicts. Filed
2026-10-17. It blocks `issues/arc-of-a-named-function-value-fails-its-send-bound.md`
and `issues/2026-10-17-a-declared-send-binding-of-a-named-function-is-rejected.md`.

## The question

PARALLELISM_RULES D9 makes a function value `Send` when it captures only
`Send` state and its code reaches no thread-affine global. The rule judges
the VALUE, wherever the value is known. Where no value is known, the type
decides, and a bare `fn(...)` type is not `Send`. That last rule closes the
struct, `Channel` and `Iso` routes, where a function loses its identity.

Closures meet the rule everywhere, because a closure's type is an identity.
It is an `Impl(Fn...)` SomeT that resolves to its own capture struct, and the
`g_closure_fids_by_*` registries map that type back to the closure. So
`arc(k)`, `Channel(type_of(k))` and `where(T <: Send)` all reach the value.

A named function has no such type: `nine` is just `fn() -> i32`. Its value is
judged where it is an argument (`take(nine)` into `Impl(Fn() -> i32, Send)`),
and that is the last place it can be. As soon as a generic binds `V` to
`fn() -> i32`, the value is gone:
- `arc(nine)` builds `Arc(V)`, and the `Arc` type constructor's where clause
  sees only the bare type;
- `dyn(nine)` into `Dyn(Fn() -> i32, Send)` boxes with `arc`, so it fails the
  same way.

The type cannot be admitted by provenance. Function types are structural, so
any `Arc(fn() -> T)` that is admitted also admits every other function of that
signature, through `Arc(F)(other)` or a `make_mut()` write (the counterexample
is in the issue's Analysis).

So the question is: what type does a named function value have once it
enters a generic that requires `Send`?

## Options

1. **Function-item types (Rust's design).** Each `::` function gets a
   singleton type that resolves to its `fn(...)` pointer type, much like a
   closure identity with no captures.
   - `arc(nine)` would specialize per function and judge it by its fid through
     the existing registries. `Arc(F)(other)` would then be a type error.
   - Cost:
     - every generic call that takes a named function specializes per function;
     - `type_key` and the specialization cache must key the new identity;
     - codegen must collapse it to the pointer type, which is the fragile
       place (`issues/fixed/arc-of-a-capture-free-closure-emits-two-arc-typedefs.md`
       had to fix exactly this collapse for closures);
     - a fn item must coerce to the plain `fn(...)` type wherever one is
       expected.
2. **Rebind a value-proved binder to a marker-declaring SomeT.** When a
   bare-`fn` value passes a binder's where markers by value, rebind the binder
   to `Impl(Fn(sig), Send, Sync, ...)` resolved to the `fn` type: the type D9
   already names as "the function type that carries the obligation".
   - It touches less than option 1.
   - It inherits the structural-compat weakness: a concrete `fn` value is
     compatible with an `Impl(Fn(sig), ...)` SomeT by trait test alone. Then
     `Arc(V)(other)` and `make_mut` writes go through unless the
     concrete-vs-resolved-SomeT rule is tightened as well. That tightening is
     the same fix as
     `issues/fixed/2026-10-17-a-closure-typed-field-accepts-a-named-function-and-emits-invalid-c.md`.
   - The declared binding `(f : Impl(Fn(...), Send)) = count` needs the same
     change, so that the variable keeps the declared SomeT rather than adopting
     the right-hand side's bare type.
3. **Keep it as it is, and document closure wrapping.** `dyn(() => nine())`
   and `arc` of a capture-free closure already work. Under this option D9's
   text would change: it would recommend the wrapper instead of the declared
   binding, which E0601 rejects today. The two issues would be retired as
   "by design".

## Recommendation

**Option 1, in two steps.**

1. Fix the structural-compat rule first. A SomeT that carries a resolution is
   compared by that resolution, in the concrete-actual direction too. This is
   an S2 on its own, and it is a prerequisite for both options 1 and 2.
2. Then give a named function its own item type.

Why option 1:
- It is the only option under which "`Send` is judged by value" holds through
  every generic container without per-route special cases.
- It is also what Rust does, for the same reason: fn items are distinct
  zero-sized types, and only the coercion to `fn` pointers erases them.

What option 2 would still need:
- the same compat tightening;
- a binding-site exception;
- a binder-rebinding exception on both call paths.

Option 2 also leaves an `Arc(V)` whose identity depends on how the `V`
binding was made.

Option 3 is the fallback if option 1's codegen cost proves too high. Under it,
D9's paragraph must stop recommending a binding that the compiler rejects.

## Verdict

1. **Now:** fix the structural-compat rule, which is already filed as `issues/fixed/2026-10-17-a-closure-typed-field-accepts-a-named-function-and-emits-invalid-c.md` (S2). A SomeT that carries a resolution is compared by that resolution in the concrete-actual direction too.
2. **After decision 43 lands:** give each named function its own item type, as Rust does.
   - Both changes rework `TypeValue` and `type_key`, so doing this one earlier would mean two passes over them.
   - It is not on the VBD critical path and gates nothing.

**In the interim,** `plans/reference/PARALLELISM_RULES.md` D9 recommends wrapping a named function in a capture-free closure, either `dyn(() => f())` or `arc` of the closure. It no longer recommends the declared binding, which E0601 rejects for a named function. The two blocked issues (`issues/arc-of-a-named-function-value-fails-its-send-bound.md` and `issues/2026-10-17-a-declared-send-binding-of-a-named-function-is-rejected.md`) stay open until step 2.
