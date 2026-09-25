# `match` demands a missing case of a GADT variant the scrutinee's type excludes

**Found:** 2026-09-25, implementing `plans/TYPE_SYSTEM_SOUNDNESS.md` Phase 4.5.
**Severity:** MEDIUM (a correct program is rejected with a witness that type cannot hold).
**Status:** FIXED on `tss/phase4-5`.

## Reproducer

```rust
Value :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    IntVal(i : i32) -> recur(i32),
    BoolVal(b : bool) -> recur(bool)
  )
);
pick :: (fn(v : Value(i32)) -> i32)(match(v, .IntVal(i) => i, .BoolVal(true) => i32(0)));
export(pick);
```

```
error[E0607]: Match expression is not exhaustive. Missing case: .BoolVal(false)
```

No `Value(i32)` is a `.BoolVal`, so there is no `.BoolVal(false)` to miss.

## Root cause

The usefulness check (`src/pattern.yo`) excluded GADT-excluded variants when deciding whether
the signature was complete (`_missing_variants`), but then iterated the variants PRESENT as
row heads to find a witness, excluded ones included. `.BoolVal(true)` was specialized like a
live variant and `.BoolVal(false)` came back as uncovered.

## Fix

A variant the scrutinee's GADT index excludes has no values (`gadt_exact`): the
complete-signature walk skips it, and a query headed by it is not useful. The `.BoolVal(true)`
arm is now reported for what it is, an arm that can never run:

```
error[E0608]: Unreachable match arm: .BoolVal(true) — no value of type Value(i32) matches it
```

Inside a generic specialization (`Value(T)` at `T = i32`) the arm checks keep every variant
live, because the source arm serves the other instantiations.

## Tests

`tests/cli-cases/match-gadt-excluded-variant-partial-arm-is-dead`,
`tests/cli-cases/match-gadt-excluded-variant-arm-is-an-error`; `tests/gadts.test.yo` keeps the
generic `Value(T)` matches green.
