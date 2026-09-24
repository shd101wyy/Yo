# A generic fn instantiated at two `T` hands one closure the other's parameter type

**Status: FIXED 2026-09-24** (Phase 2.4 of `plans/TYPE_SYSTEM_SOUNDNESS.md`; found 2026-09-07, while implementing D17's stable sort).

**Severity: emitted C does not compile.** Not silent — clang rejects it — but
the diagnostic names a generated symbol and a `__yo_tN` type, so the user has
no way to see which of their calls is at fault.

## Symptom

The trigger is narrower than "two instantiations". Both of these compile
fine:

- a generic `Impl(Fn(a : T, b : T) -> bool)` helper called at two `T` from
  `main`;
- the same helper taking a `*(T)` as well, still called at two `T` from
  `main`.

What breaks is an **outer generic instantiating an inner generic at a
DIFFERENT type, with a closure that captures the outer `T`'s data**:

```rust
_inner :: (fn(generic(T : Type), ptr : *(T), n : usize, less : Impl(Fn(a : T, b : T) -> bool)) -> bool)(...);

_outer :: (fn(generic(T : Type), ptr : *(T), n : usize, less : Impl(Fn(a : T, b : T) -> bool)) -> bool)({
  idx := ...;                      // *(usize)
  // _inner at T = usize, from inside _outer whose T = Rec; the comparator
  // closes over the OUTER ptr/less.
  _inner(idx, n, (a, b) => unsafe(less((ptr.add(a)).*, (ptr.add(b)).*)))
});
```

```
error: passing 'size_t' (aka 'unsigned long') to parameter of incompatible
       type '__yo_t0' (aka 'struct __yo_t0_struct')
```

The inner call's `usize` index is passed to a closure whose emitted C
signature took the OUTER instantiation's element type.

Reproducer: `issues/repros/generic-fn-at-two-types-wrong-closure-param.yo`
(verified to fail; the two non-triggering shapes above were checked first, so
the file pins the actual trigger rather than a superset).

## Where it was hit

`std/collections/array_list.yo`. D17's stable sort wanted an outer generic
over the element type to sort an INDEX array (`usize`) by comparing elements
— exactly the shape above. Worked around by making the index merge
**monomorphic**, so the shipped `sort` is unaffected and the bug is untouched.

## Why it matters beyond sorting

"Sort/search/group indices by comparing elements" is a standard shape, and so
is any combinator that delegates to a generic helper at a different type
while closing over its own. The failure arrives as a C compile error naming
internal `__yo_tN` symbols, which is the diagnostic class C69 was filed for.

## Suspected area

The closure's C signature is emitted per closure *id*, but the call site
appears to pick the parameter type from the enclosing specialization rather
than from the closure's own resolved type — the `SomeT` resolution-cell
family (see `yo-varbound-receiver-cell-recovery`, C27). Confirming that needs
a walk of the specialization keys for the two instantiations.

## Root cause (2026-09-24)

The closure literal `(a, b) => …` was evaluated against `_inner`'s parameter type
`Impl(Fn(a : T, b : T) -> bool)` with `_inner`'s `T` still unbound, and that `T` was then
resolved BY NAME in the environment — where the enclosing `_outer` specialization binds its own
`T = Rec`. So the closure's parameters were typed `Rec` while `_inner` was specialized at `usize`.
The "suspected area" above (the SomeT resolution cells) was close: it is the name-keyed half of
the same shared-binder resolution.

## Fix

Function-literal arguments are evaluated after the other arguments, against their parameter type
with the callee's binders substituted at the callee's OWN occurrences (name + frame level) by the
types the other arguments fixed — here structurally, `ptr : *(T)` given `*(usize)` — so a
caller's same-named binder cannot answer (`_fv_refine_closure_expected`,
`src/evaluator/calls/function.yo`; the same ordering in `try_to_call`'s Step 7).

## Verification

`issues/repros/generic-fn-at-two-types-wrong-closure-param.yo` compiles and prints
`outer=true`. `tests/type_soundness.test.yo` ("a closure keeps the inner instantiation's
parameter type") fails on the Phase 0–2.3 compiler with the clang error above and passes now.
The monomorphic index merge in `std/collections/array_list.yo` can use the generic helper again;
that is left as is (the shipped sort is correct either way).
