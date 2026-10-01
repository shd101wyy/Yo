# A named impl miss forces the importer's impls while the importer is still on the import

**Severity:** S2 — `check ./std` failed (E0906 on `String`, then a cascade of E0616 "ambiguous `index_in`"), so every program importing `std/string` through another module was rejected

**Status:** FIXED on `tss/enum-final-name` (2026-10-01), before that branch merged: it was the
branch's own regression, never on `develop`. Regression: `tests/lazy_toplevel_bindings.test.yo`
("an imported module's member miss does not force the importer's impls", fixture
`tests/fixtures/lazy_impl_later_member.yo`).

## Symptom (measured, `fix/enum-final-name` at 06b6dc8d3)

```
$ yo check ./std --std-path ./std
error[E0906]: forward reference to "String" (bound at line 2018) …  --> std/string/string.yo:1600:5
error[E0616]: The call to "index_in" is ambiguous: trait_string__string_Pattern_r0c11_n0 and Pattern both supply a "index_in" …
error[E0616]: … _n0 and … _n1 and Pattern …        (one more Pattern instance per importing module)
```

`yo check std/string/string.yo` alone passed. `yo check std/fmt/to_string.yo` failed, so the
failure needed an importer.

A two-module reproducer:

```rust
// lib.yo
S :: struct(n : i32);
impl(S, twice : (fn(self : Self) -> i32)({ c := self.copy_of(); (c.n + self.n) }));
impl(S, copy_of : (fn(self : Self) -> Self)(S(n : self.n)));
export(S);

// main.yo
{ S } :: import("./lib.yo");
Show :: trait(show : (fn(self : Self) -> i32));
impl(S, Show(show : (fn(self : Self) -> i32)(self.twice())));
```

`yo check main.yo`: E0906 `forward reference to "S"` on the branch, E0610 `No method "copy_of"`
on v0.2.47 (the bug the branch fixes), and it passes once the fix lands.

## Cause

`fix/enum-final-name` made the impl-forcing guard name-aware. A miss on a name the in-flight impl
does not declare now forces the type's later impls. `force_pending_impls_for_type_name`
(`src/evaluator/context.yo`) forced EVERY pending impl of the type in EVERY active module walk.
`YO_DEBUG_LAZY=1` showed the miss and what it forced:

```
[force-miss] String.clone (forcing stack: impl(String) splitn)
[force] impl(String, …) (line 2018) in …/std/string/string.yo
…
[force] impl(String, …) (line 344) in std/fmt/to_string.yo
error[E0906]: forward reference to "String" …
```

`splitn` calls `self.clone()`, and only `impl(String, Clone(…))` at line 3345 answers it. The
pass also forced `impl(String, ToString(…))` in `std/fmt/to_string.yo`. That module's walk was
still parked on `import("../string")`, so its `String` binding did not exist yet. The failed force
left `std/string` half-registered, and every later importer minted another `Pattern` trait.

## Fix

A named miss first forces only the pending impls that declare the name: a direct `name : value`
member, or one inside a trait constructor (`_impl_expr_declares`). If none of them declares it:

- inside an impl of the same type, nothing is forced;
- elsewhere, all of the type's impls are forced, as before (a trait default or a derive does not
  appear in the impl's member list).

A trait-satisfaction check (no name) forces as before.
