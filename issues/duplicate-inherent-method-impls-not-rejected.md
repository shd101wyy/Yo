# Duplicate inherent method impls are silently accepted (docs claim rejection)

**Found:** 2026-08-21, during the function-overloading-policy audit
(`plans/FUNCTION_OVERLOADING_POLICY.md`).

## Symptom

Registering the same inherent method name on one type via two separate
`impl(...)` calls is not an error:

- **Identical signature:** the second impl is silently ignored — the FIRST
  definition wins.
- **Different arity:** both register and calls dispatch by arity — i.e.
  working, undocumented inherent-method overloading.

Both contradict the documented model, in two places:

- `.github/instructions/yo-design.instructions.md`: "Duplicate method names
  across impl blocks are disallowed. Defining `unwrap` in two separate impl
  blocks for the same type produces an error."
- `.github/skills/yo-core-patterns/core-patterns-cheatsheet.md` ("Method
  overloading: inherent NO, trait YES"): "a second same-name inherent
  method is rejected (\"Method already defined\" across impl blocks)".

The quoted error string `Method already defined` does not exist anywhere in
`src/evaluator/` — the check was never ported (or never existed; the claim
may have been aspirational).

## Reproducers

Both pass `yo check` (v0.2.14) and the first also compiles and runs,
asserting that the FIRST impl won:

```rust
// repro 1 — identical signature: second impl silently ignored
{ assert } :: import("std/assert");
P :: struct(x : i32);
impl(P, get : (fn(self : Self) -> i32)(self.x));
impl(P, get : (fn(self : Self) -> i32)(self.x + i32(1)));
main :: (fn() -> unit)({
  p := P(x : i32(1));
  assert(p.get() == i32(1), "first impl wins; second silently dropped");
});
export(main);
```

```rust
// repro 2 — different arity: both live, dispatch by arity (overloading)
{ assert } :: import("std/assert");
P :: struct(x : i32);
impl(P, get : (fn(self : Self) -> i32)(self.x));
impl(P, get : (fn(self : Self, y : i32) -> i32)(self.x + y));
main :: (fn() -> unit)({
  p := P(x : i32(1));
  assert(p.get() == i32(1), "arity-0");
  assert(p.get(i32(5)) == i32(6), "arity-1");
});
export(main);
```

## Root cause

Inherent method registration appends into the per-type method registry
without a same-name inherent-duplicate check.
`src/evaluator/values/type_trait_methods.yo` states the contract
explicitly: "duplicates by `(label, source_trait_id)` are not deduplicated
by the registry — callers responsible" — and no caller takes the
responsibility for the inherent (no-source-trait) case.

## Why not fixed in the overloading-policy branch

The fix is not a one-line throw: the module loader re-evaluates files (and
generic impls re-register per instantiation), and
`src/evaluator/module_loader.yo` documents that duplicate registry pushes
are expected and harmless ("re-registration ... a duplicate push would
still be harmless"). A rejection must therefore distinguish a GENUINE
second definition (different source expression) from an idempotent
re-registration of the same one — e.g. key the check on the defining
`ExprId`/token identity: same id ⇒ allow (re-registration), different id
with same `(type, label)` and no source trait ⇒ error. That touches the
registration path for every impl in every module, so it needs its own
branch and the full validation pyramid.

Trait-provided methods sharing a name (with an inherent method or with
methods from other traits, incl. parameterized trait impls `Eq(String)` /
`Eq(str)`) are BY DESIGN and must stay allowed — the check is for the
inherent channel only.

## Interim state

`yo-design.instructions.md` and the core-patterns cheatsheet now carry a
"policy, not yet enforced" annotation pointing here, so nobody codes
against the phantom error.
