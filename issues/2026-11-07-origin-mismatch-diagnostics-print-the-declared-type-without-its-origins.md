# Origin-mismatch diagnostics print the declared type without its origins

**Severity:** S3 — a confusing message: the E0923 text names a declared type whose spelled origin it then says is missing, but prints the type with that origin erased

Found 2026-11-07 while verifying O-2's `generic-rigid-origin` row (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §9).

## Reproducer

`tests/origins/corpus/generic-rigid-origin.yo`: `yo check` reports

```text
error[E0923]: Cannot assign a value holding origin `q` to `dst`: its type is declared over `Option(&i32)`, whose origin does not name `q`, …
```

The declared type is `Option(&(i32, p))`. The return rule's E0923 ("the result is declared `Option(&mut i32)`, whose origin does not name `self`") prints the same way.

## Root cause

The messages format the type with `type_to_string`, which renders a reference without its origin (`&T`, never `&(T, p)`). The checks read the spelled origins correctly; only the text drops them.

## Fix

Not fixed. The messages should render origins (a `type_to_string` variant that prints `&(T, p)`), or name the declared origin set alongside the type.

## Test that pins it

None yet: the fix adds a `.test.yo` case asserting the E0923 text names `&(i32, p)`.
