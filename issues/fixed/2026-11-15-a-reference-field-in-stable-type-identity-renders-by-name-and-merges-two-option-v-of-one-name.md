# A reference field in `stable_type_identity` renders by name, merging two `Option(&V)` of one name

**Severity:** S1 (the whole `tests/error.test.yo` batch fails to compile: 15/15 rows reported failed; any
program whose two scopes each declare a same-named enum and view-`downcast` it hits the same C error)

## Symptom

Two sibling scopes each declare `MathError :: enum(DivisionByZero, NegativeSqrt)` and each catches a
thrown error with `downcast(&err.*, MathError)`. The Yo side type-checks; the C compiler fails:

```text
error: incompatible pointer types initializing 'const __yo_t_1729401705981530153 *' with an
expression of type 'const __yo_t_13136553424661209307 *'
```

One `Option` struct is emitted for the two downcasts, and its `Some(value)` slot holds the FIRST
declaration's `MathError` while the second downcast's cast and is-check use its own.

## Root cause

`stable_type_identity` (`src/types/type_key.yo`) — the dedup key `collect_type` uses to alias a
re-collected type onto its first C type — has arms for `Struct`, `EnumT`, `SomeT`, `Tuple`, `Pointer`
and `SliceT`, but NONE for `Reference`: a `&T` field fell to the `type_to_string` fallback, which
spells a nominal type by NAME. `stable_type_identity(Option(&MathError_1))` and
`stable_type_identity(Option(&MathError_2))` rendered identically, so `collect_type` registered the
second's `type_key` as an ALIAS of the first's (`register_type_alias`) — one C type for two payload
types. `type_key` itself distinguishes them (its `Reference` arm recurses into the pointee); only the
alias dedup merged them. `tests/nominal_enum_identity.test.yo` guards the enum side but reaches the
enum directly, never behind a reference.

The flip made this the error family's shape: a view `downcast(&err.*, V)` returns `Option(&V)` (the
`&V` field is new), and `tests/error.test.yo` declares `MathError` per row.

## Fix

A `Reference` arm in `_stable_identity_at` that renders the mode and recurses into the pointee
(origin erased, as `type_key`'s own `Reference` arm does): equal renders still imply equal structure,
and the two declarations of one name now render distinctly.

## Test

`tests/error.test.yo` rows 5 and 7 (the two `MathError` rows) fail to compile before the fix and pass
after. Standalone reproducer `tmp/p/p16.yo` in this worktree (two blocks, one function; fails with
the incompatible-pointer error by yo-il, compiles and prints `p16 ok` by the fixed binary). The
renamed variant `tmp/p/p16b.yo` (`MathError2`) compiles by yo-il, confirming the merge is name-driven.
