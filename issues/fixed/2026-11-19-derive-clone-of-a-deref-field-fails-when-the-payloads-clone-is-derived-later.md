# `derive(Clone)` of a `Deref` field fails when the payload's `Clone` is derived later in the module

**Severity:** S2 — a valid module is rejected depending on the order of its `derive` lines, and it blocks VERDICTS-63
Generation B: with `ArrayList(T)` implementing `Deref`, `check ./src` fails in 203 of 273 files at `src/env.yo`'s
`derive(VariableRare, Clone)`.

**Status:** FIXED by `v0279/derive-later-clone` (v0.2.79): a generic impl's `where` bound forces the bound type's
pending impls and derives before it rejects the candidate.

Found 2026-11-19 by the v0.2.80 Deref lane (`v0280/deref-std-impls`), with a tree binary of develop `d8f0d89fa`
(no `src/` change up to `939fe7160`) and develop's std.

## Reproducer

`issues/repros/2026-11-19-derive-clone-of-a-deref-field-fails-when-the-payloads-clone-is-derived-later.yo`:

```yo
A :: struct(xs : Box(B), n : i32);
derive(A, Clone);
B :: struct(n : i32);
derive(B, Clone);
main :: (fn() -> unit)({
  a := A(xs : Box.new(B(n : i32(2))), n : i32(1));
  _b := a.clone();
});
export(main);
```

```text
error: derive on "A" failed: error: Type "Box(B)" does not implement trait "Clone".
  --> auto-generated://
// === START auto-generated code ===
Self((type_of(self.xs) <: Clone).clone(&self.xs), self.n.clone())
// === END auto-generated code ===
```

With `derive(A, Clone)` moved below `derive(B, Clone)` the file checks. A field that is not a `Deref` type
(`xs : ArrayList(B)` on develop's std, where `ArrayList` has no `Deref` yet) takes the `self.xs.clone()` arm and checks
in either order.

## Root cause

The derive rule (`std/prelude.yo`, `__derive_clone`, and `derive(Hash)`'s twin) spells a `Deref` field's call through
the field type's own impl, `(type_of(self.f) <: Clone).clone(&self.f)`, so decision 32's wrapper/payload clash (E0616)
cannot fire on a handle. The `<:` cast (`src/evaluator/exprs/subtype_of.yo`) judges `Box(B) <: Clone` at the derive
site and, on a miss, forces the pending impls of the LHS head, `Box`, which has none pending. The answer comes from the
prelude's generic `impl(generic(T), where(T <: Clone), Box(T), Clone(...))`, and its `where` pass
(`try_match_generic_impl`, `src/evaluator/values/impl.yo`) judged `B <: Clone` through `type_implements_trait`
without forcing anything, so the module's later `derive(B, Clone)` (a pending impl since LAZY_TOPLEVEL_BINDINGS P7) was
never registered and the candidate was rejected. The method call `self.f.clone()` does not judge the bound there.

`derive(Hash)` takes the same arm but did not fail: `Hash.hash` is generic over the hasher, so its body is evaluated at
the call, after the module's derives ran.

## Fix

The `where` pass of `try_match_generic_impl` forces the pending impls and derives of a concrete bound type's head
(`force_pending_impls_for_type_name`) when an enforced clause fails, then re-judges the clause. Every trait check that
reaches a generic impl (the `<:` cast, a callee's `where` bound, a nested instantiation like `Box(Option(B))`) now
sees the module's later impls of the bound type, as the direct checks already did for the receiver's own impls.

## What it blocks

VERDICTS-63 Generation B's `impl(ArrayList(T), Deref(Target : [T]))`: `ArrayList` becomes a `Deref` type, so every
derived `Clone`/`Hash` of a struct with an `ArrayList` field takes this arm, and `src/env.yo` derives `VariableRare`'s
`Clone` (field `undone_moves : ArrayList(UndoneMove)`) 48 lines before `derive(UndoneMove, Clone)`. VERDICTS-63 p11b
keeps the arm for owners, so the fix is the evaluator's, not a reordering of `src/env.yo`.

## Test

`tests/derive.test.yo`, "derive Clone and Hash over a Box field whose payload derives them later": a struct with a
`Box(B)` field and an enum with a `Box(B)` payload, both deriving `Clone` and `Hash` above `B`'s own derives, cloned and
hashed. It fails before the fix with the reproducer's error. The `ArrayList(B)` field case needs ArrayList's `Deref`
impl (v0.2.80); it was verified by checking `./src` with the Deref branch's `std/collections/array_list.yo`.
