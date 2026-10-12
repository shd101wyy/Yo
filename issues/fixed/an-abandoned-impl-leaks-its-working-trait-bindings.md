# An impl abandoned under `comptime_expect_error` leaks its working-trait bindings

**Severity:** S2 — a valid impl later in the module is rejected (E0602) because its `Self.Output` resolves to an earlier, failed impl's `Output`.

**Status:** fixed on feat/vbd-v2b-index-mut (VALUES_BY_DEFAULT V2b).

## Symptom

An impl rejected inside `comptime_expect_error(...)` makes a later impl of an unrelated trait fail its conformance check:

```yo ignore
test("bad impl", {
  comptime_expect_error(
    impl(Bad, Index(usize)(Output : i32, index : (fn(self : &mut Self, idx : &usize) -> *Self.Output)(addr_of(self.d0)))),
    "but the trait requires"
  );
});
LIndex :: (fn(comptime(Idx) : Type) -> comptime(Trait))(
  trait(Output : Type, index : (fn(self : &mut Self, idx : Idx) -> *Self.Output))
);
A :: struct(a : i32);
impl(A, LIndex(usize)(Output : i32, index : (fn(self : &mut Self, idx : usize) -> *Self.Output)(addr_of(self.a))));
B :: struct(b : A);
impl(B, LIndex(usize)(Output : A, index : (fn(self : &mut Self, idx : usize) -> *Self.Output)(addr_of(self.b))));
```

```
error[E0602]: Type "B" does not implement required trait "(Output : Type, index : fn(self : &mut Self, idx : usize) -> *(i32))" as written: member "index" has type fn(self : &mut B, idx : usize) -> *(A), but the trait requires fn(self : &mut B, idx : usize) -> *(i32)
```

Reproduced on develop `3b7640edb` with a tree-built compiler. The v0.2.59 seed accepts the program.

## Root cause

The impl field loop (`src/evaluator/values/impl.yo`) installs the trait entry's
working bindings in `ctx.current_impl_trait_field_labels` / `_types`
(`Output : i32` once the `Output` member is evaluated), so later members resolve
`Self.Output`. It restores them after the loop, but the rejected member throws
out of the loop first. `comptime_expect_error` catches the throw and restores
the evaluation context field by field, and these two fields were missing from
its list. Every later trait conformance check read the stale `Output`.

Related: `issues/fixed/abandoned-impl-members-survive-the-error.md` (the same unwinding hole, for the impl's in-flight record).

## Fix

Both catch sites that keep evaluating with the same context restore the two
fields alongside `truncate_forcing_depths`: `evaluate_comptime_expect_error`
(`src/evaluator/builtins/comptime_expect_error.yo`) and the module walker's
abort edge (`evaluate_anonymous_module_begin_exprs`,
`src/evaluator/values/anonymous_module.yo`), which a `yo check` or LSP session
crosses before evaluating the next module. The pending-definition forcer and
the in-block field forcer already ran on a copied context or restored them.

## Test

`tests/index.test.yo`, "An impl abandoned under comptime_expect_error leaves no
Output behind": the `AfterBadIdx` trait's second impl, after the failing
`BadBorrowIdx` impl. It was E0602 before the fix.
