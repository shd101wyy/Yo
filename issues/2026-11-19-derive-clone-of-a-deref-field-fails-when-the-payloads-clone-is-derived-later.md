# `derive(Clone)` of a `Deref` field fails when the payload's `Clone` is derived later in the module

**Severity:** S2 — a valid module is rejected depending on the order of its `derive` lines, and it blocks VERDICTS-63
Generation B: with `ArrayList(T)` implementing `Deref`, `check ./src` fails in 203 of 273 files at `src/env.yo`'s
`derive(VariableRare, Clone)`.

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

## Root cause (not yet located)

The derive rule (`std/prelude.yo`, `__derive_clone`, and `derive(Hash)`'s twin) spells a `Deref` field's call through
the field type's own impl, `(type_of(self.f) <: Clone).clone(&self.f)`, so decision 32's wrapper/payload clash (E0616)
cannot fire on a handle. The `<: Clone` cast judges `Box(B) <: Clone` at the derive site, where `Box`'s
`where(T <: Clone)` asks for `B <: Clone` before the module's later `derive(B, Clone)` has registered it. The method
call `self.f.clone()` does not judge the bound there. `impl` registration is order-independent within a module
(`plans/reference/LAZY_TOPLEVEL_BINDINGS.md`), so the cast's trait check should force the module's pending
`derive`/`impl` registrations before it answers "does not implement".

## What it blocks

VERDICTS-63 Generation B's `impl(ArrayList(T), Deref(Target : [T]))`: `ArrayList` becomes a `Deref` type, so every
derived `Clone`/`Hash` of a struct with an `ArrayList` field takes this arm, and `src/env.yo` derives `VariableRare`'s
`Clone` (field `undone_moves : ArrayList(UndoneMove)`) 48 lines before `derive(UndoneMove, Clone)`. VERDICTS-63 p11b
keeps the arm for owners, so the fix is the evaluator's, not a reordering of `src/env.yo`.

## Test that will pin it

`tests/derive.test.yo`: the reproducer's two structs (a `Box(B)` field and an `ArrayList(B)` field, each with `B`'s
`derive(Clone)` and `derive(Hash)` after the holder's) checking and cloning.
