# A lazy impl force reaches an importer that is parked on the import, so a valid program fails E0906

**Severity:** S2 — a valid two-module program is rejected with E0906 "forward reference" whenever an imported module calls a method that only a later impl in that same module supplies, and the importer has its own pending impl of the type

**Status:** FIXED on `tss/enum-final-name` (2026-10-01). Present on develop and v0.2.47.
Regression: `tests/lazy_toplevel_bindings.test.yo` ("an imported free function's trait-default
miss does not force the importer's impls", fixture `tests/fixtures/lazy_impl_later_member.yo`).
The same mechanism caused `issues/fixed/a-named-impl-miss-forces-the-importers-impls-mid-import.md`.

## Reproducer (measured, v0.2.47)

```rust
// lib.yo
S :: struct(n : i32);
Tr :: trait(
  base : (fn(self : Self) -> i32),
  (dflt : (fn(self : Self) -> i32)) ?= (self -> (self.base() + i32(1)))
);
use_dflt :: (fn(s : S) -> i32)(s.dflt());
impl(S, Tr(base : (fn(self : Self) -> i32)(self.n)));
export(S, use_dflt);

// main.yo
{ S, use_dflt } :: import("./lib.yo");
{ assert } :: import("std/assert");
Show :: trait(show : (fn(self : Self) -> i32));
impl(S, Show(show : (fn(self : Self) -> i32)(use_dflt(self))));
main :: (fn() -> unit)({
  s := S(n : i32(2));
  assert(s.show() == i32(3), "show");
});
export(main);
```

```
$ yo check main.yo
error[E0906]: forward reference to "S" (bound at line 7) — imports, pragmas and runtime bindings are evaluated in order …
  --> main.yo:1:27
```

## Cause

`use_dflt` misses `dflt` on `S`, and the lazy walker forces the pending impls of `S`
(`force_pending_impls_for_type_name`, `src/evaluator/context.yo`). It searched every active
module walk. Walks nest strictly, so every walk except the innermost is parked on the import
that is running now. `main.yo`'s `impl(S, Show(…))` was forced while `main.yo` was still on
`{ S, use_dflt } :: import("./lib.yo")`, before that statement had bound `S`: E0906.

## Fix

A forcing pass searches the innermost walk, plus any outer walk that itself declares the type
(the import-cycle case: the running module reached back into a module still loading, whose own
type has a pending impl). An impl of an imported type in a parked importer is never forced. It
registers when the importer's walk reaches it.
