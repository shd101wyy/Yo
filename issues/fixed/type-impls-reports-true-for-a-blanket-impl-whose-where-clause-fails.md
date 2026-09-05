# `Type.impls` reports `true` for a generic impl whose `where` clause fails (FIXED 2026-09-05)

**Status:** FIXED — `src/evaluator/values/impl.yo`, `try_match_generic_impl`
now enforces a failed MARKER `where` clause for CONSTRUCTED receiver patterns
when it is answering the trait predicate. Regression tests + over-rejection
canaries in `tests/basic.test.yo`.

**Severity:** soundness. `Send` is the gate on what may cross a thread
boundary, and the predicate answered `true` for `*(NonSend)`.

## Symptom

```
*NonSend          Send == true   (want false)
Array(NonSend, 4) Send == true   (want false)
?*NonSend         Send == true   (want false)
```

The prelude declares these three conditionally (`std/prelude.yo`):

```rust
impl(generic(T : Type), where(T <: Send), *(T), Send());
impl(generic(T : Type, U : usize), where(T <: Send), Array(T, U), Send());
```

`?*(T)` is `Option(*(T))`, whose Send is derived from its flattened variant
field `*(T)` — so it inherits the same wrong answer.

The `where(T <: Send)` bound was simply not consulted, so any `T` at all
satisfied the impl.

## Reproducer

```rust
pragma(Pragma.AllowUnsafe);
{ println } :: import("std/fmt");
NonSend :: ref(struct(v : i32));
PTR_NONSEND :: Type.impls(*NonSend, Send);
ARR_NONSEND :: Type.impls(Array(NonSend, 4), Send);
OPT_PTR_NONSEND :: Type.impls(?*NonSend, Send);
PTR_I32 :: Type.impls(*i32, Send);
report :: (fn(label : str, got : bool, want : bool) -> unit)({
  cond(
    (got == want) => println(`ok     ${label} : ${got.to_string()}`),
    true => println(`WRONG  ${label} : ${got.to_string()} (want ${want.to_string()})`)
  );
});
main :: (fn() -> unit)({
  report("*NonSend         ", PTR_NONSEND, false);
  report("Array(NonSend, 4)", ARR_NONSEND, false);
  report("?*NonSend        ", OPT_PTR_NONSEND, false);
  report("*i32             ", PTR_I32, true);
});
export(main);
```

`yo compile tmp/send_where.yo --std-path ./std --optimize 2 -o tmp/send_where.out`
then `./tmp/send_where.out` — three `WRONG` lines before the fix, zero after.

Note the reproducer must observe the answers through **module-level `::`
bindings + a runtime `assert`/`println`**: `comptime_assert` is inert inside a
function body (`issues/fixed/comptime-assert-never-fires-inside-a-function-body.md`),
which is exactly why the pre-existing `comptime_assert`-only test in
`tests/basic.test.yo` ("Test Send on pointer-bearing types is conditional on the
pointee") never caught this — it already contained the right assertions.

## Root cause

`src/evaluator/values/impl.yo`, `try_match_generic_impl`'s where-constraint
pass. The clause was discharged, but the REJECTION was gated on the impl's
receiver pattern being a bare blanket:

```rust
wcj_impl := wcj_f(wcj_bound, wcj_trait, match_env);
if(!wcj_impl && is_some_type(entry.receiver_type_pattern), {
  wc_ok = false;
});
```

`is_some_type(entry.receiver_type_pattern)` is true only for
`impl(generic(T), where(...), T, Trait())` — a bare-`SomeT` pattern. The
pointer/array impls have a CONSTRUCTED pattern (`*(SomeT(T))`,
`Array(SomeT(T), SomeT(U))`), so their clause was evaluated and then thrown
away.

The scoping was deliberate and its reasoning (recorded in the comment above the
pass) is sound for **method dispatch**: enforcing a specific-pattern impl's
clause there would DELETE a method wherever the trait-implements predicate has a
load-order false negative (the comment names `String <: Hash` breaking
`HashMap(String, _).new()`). What it missed is that the same function also feeds
the **trait predicate** — `find_matching_generic_impl` is the sole feeder of
`type_implements_trait` step 8 — where dropping the clause is not conservative
at all, it is unsound.

## Fix

Two independent restrictions, both needed.

**1. Split the two uses of `try_match_generic_impl`** instead of picking one
policy for both. It takes an `enforce_all_where : bool`:

- `false` — method dispatch (`find_methods_from_generic_impls`,
  `find_associated_type_from_generic_impls`, `get_generic_impl_doc_entries`)
  and `find_matching_negative_generic_impl`. Behaviour unchanged: only blanket
  impls are rejected on a failed clause.
- `true` — `find_matching_generic_impl`, the trait predicate. Constructed
  patterns are enforced too.

A load-order false negative on the predicate side costs a `false` from a
PREDICATE (and the auto-derive / registry / builtin steps ahead of step 8
already answer for the common types); it cannot silently delete a method the
way the dispatch path can.

**2. On the predicate side, enforce only a MARKER constraint**
(`_is_marker_trait`: a `TraitT` whose member types and associated-type-
constraint types mention no type variable — `Send`, `Comptime`, `Runtime`,
`Acyclic`).

This is not caution for its own sake — a non-marker constraint **cannot be
answered from what is stored**. `entry.where_constraint_traits[i]` holds the
trait as it was evaluated at IMPL-REGISTRATION time, so `where(T <: Eq(T))` is
stored as `Eq(SomeT(T))`: a trait built for the impl's own type PARAMETER, with
a `Rhs`-specialized id (`Eq` is a comptime fn returning a fresh `Trait` per
`Rhs`). MEASURED: asked as-is, even `i32 <: Eq(SomeT(T))` is `false`, while
`i32 <: Eq(i32)` is `true`. Enforcing the raw answer deleted the entire
`Option(T)`/`Eq` and `Option(T)`/`Ord` family from the predicate — the
over-rejection canary below caught exactly that, on the first build of the fix.

`substitute()` cannot repair it either: its `TraitT` arm rewrites field types
but KEEPS the trait id, which is what the registry is keyed on (verified by
building that variant — the canary still failed). Closing the non-marker half
would need the constraint's source EXPR re-evaluated against the match
bindings, not a stored `TypeValue`; that is left as a known, documented gap.

Unchanged in every mode: an **unbound** where-param is never a rejection.
`_resolve_one_forall_binding` returning `.None` — the clause could not be
discharged because the param never got a concrete binding, e.g. a def-time
trial over an unresolved `SomeT` — still falls through. Only a param that IS
bound and demonstrably fails its trait removes the impl.

`find_matching_negative_generic_impl` is deliberately left on `false`: a
negative impl REMOVES a trait, so tightening its match would LOOSEN the
predicate — the opposite direction from this fix.

## Known remaining gap

A PARAMETRIC `where` bound on a constructed receiver pattern (`where(T <:
Eq(T))`, `where(T <: Ord(T))`, `where(T <: Clone)`, `where(T <: Hash)`,
`where(T <: Default)`) is still ignored by the trait predicate, for the reason
above. So `Type.impls(Option(<a type with no Eq>), Eq(Option(...)))` still
over-reports. That is a correctness wart, not a thread-safety hole: the marker
traits — the ones that gate `Send` across a thread boundary and `Comptime` /
`Runtime` / `Acyclic` across evaluation contexts — are now enforced.

## Over-rejection canaries

This change tightens trait resolution, which is the dangerous direction. The
regression tests carry canaries that must KEEP answering `true`:

- `*i32`, `Array(i32, 4)`, `?*i32` still report `Send == true` — the same three
  impls, with a satisfied bound.
- The `Option(T)` blanket family, also a constructed pattern with a `where`
  clause, and the one that regressed before
  (`issues/fixed/yo-self-option-eq-ref-enum-not-specialized.md`):
  `Type.impls(Option(i32), Eq(Option(i32)))`,
  `Type.impls(Option(<user struct with a manual Eq impl>), Eq(Option(...)))`,
  `Type.impls(Option(i32), Acyclic)` — plus real `==` / `!=` dispatch on
  `Option(<user struct>)`, so the canary covers dispatch and not just the
  predicate.

The `Option`/`Eq` canaries are what rejected the first two attempts at this fix
(enforce every constraint; enforce with `substitute()`-repaired traits).

## Tests

`tests/basic.test.yo`, four new tests (each shape separately so one failure
does not mask the others):

- `Test *(T) Send honours the impl's where(T <: Send)`
- `Test Array(T, N) Send honours the impl's where(T <: Send)`
- `Test ?*(T) Send honours the impl's where(T <: Send)`
- `Test where-clause enforcement does not over-reject a satisfied bound`

Verified RED before the fix (the first three fail, the canary passes) and GREEN
after.
