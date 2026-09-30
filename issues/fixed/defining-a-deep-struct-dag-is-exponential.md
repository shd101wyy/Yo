# Defining a deep struct DAG costs time exponential in its depth

**Severity:** S3 — no real program has been seen hitting it; a struct type that holds the same struct type several times, nested deep, makes every check of the module slow

**Status:** FIXED 2026-09-30 (#1022).
**Found:** building the regression fixture for
`issues/fixed/match-exhaustiveness-walks-the-whole-field-tree-of-an-unmatched-struct.md`, whose first
reproducer (a binary DAG) was slow with or without a `match`.

## Measured

```rust
S0 :: struct(x : i32);
S1 :: struct(a : S0, b : S0);
S2 :: struct(a : S1, b : S1);
// … S(i) :: struct(a : S(i-1), b : S(i-1)) up to S(d)
count :: (fn(o : S(d)) -> i32)(i32(0));
```

`yo check`, macOS arm64 (the same for `yo-dev` from 2026-09-28 and for #996):

| depth | 16 | 18 | 20 | 22 | 26 |
| --- | --- | --- | --- | --- | --- |
| before | 1.0 s | 1.6 s | 4.1 s | 15.8 s | over 100 s |

Each extra level of depth roughly doubles the time, so the cost follows the 2^depth leaves of the
type's expanded field tree, not the d + 1 type definitions.

## Root cause (measured: `sample` of the slow check, one walk at a time)

Three recursive walks over a type visited a shared subtype once per path to it:

1. `type_of_type` (`src/types/hierarchy.yo`), the type-universe walk. Its cycle guard is the list of
   names on the current path, and nothing remembered a struct already computed. This was the whole
   cost at depth 22.
2. `type_representation_contains_raw_ptr` (`src/types/utils.yo`), a flow predicate asked about every
   parameter type. This dominated once walk 1 was memoized: depth 26 still took 3.1 s and doubled
   every two levels.
3. `type_may_provide_slice_source`, its sibling. Both capped recursion at depth 40 "in place of an
   object-identity visited set", so a DAG 40 or more levels deep reached the cap on every path.

## Fix

Each walk memoizes named aggregates (structs and enums) within one top-level call.

- **A hit requires the same type object, not just the same id.** Substitution and SomeT resolution
  rebuild a struct under its id with different field types (`src/types/substitution.yo`,
  `evaluator/calls/helper.yo`), and such copies can answer differently. Nothing mutates a type
  object during one walk, so an identity hit is exact.
- **A result that depends on the path is not stored.** The universe walk tracks whether its name
  guard fired inside each entry; the flag is saved, cleared and OR-ed back, so a cycle elsewhere in
  the walk does not switch off memoization for unrelated entries. The predicates detect a cycle as
  the same type object already on the current path, and their depth limit becomes a 1024 stack
  backstop. A `false` computed under a cycle or the backstop is not stored; a `true` is exact and
  always stored.
- Unions carry no id, and two modules may define same-named unions, so unions are not memoized.

## Two soundness bugs along the way

- **The old depth-40 cap was a false negative.** The predicates answered `false` (no raw pointer)
  for a pointer more than 40 levels down; `tests/internal/types_utils.test.yo` even pinned that
  answer as its termination test. The test now expects `true`, and a separate test builds a type
  object that contains itself to show the walk terminates.
- **An id-based cycle guard is wrong.** An intermediate version of this fix compared ids along the
  path. Two different types with one id (an empty id, or a substituted copy) then read as a cycle,
  and the predicate said "no raw pointer": the unsafe direction. `types_utils.test.yo`'s nested
  newtype test caught it, and a shared-id test now pins it. Against the id-based source, 3 tests
  fail; with the object-identity guard all 71 pass.

The first version of #1022 keyed the universe memo by id alone, and a single guard flag disabled
the memo for the rest of the walk once any cycle appeared. Its measurements (depth 22: 48 s → 2.8 s,
on another machine) still doubled every two levels, which was walk 2.

## After

| depth | 22 | 26 | 30 | 40 | 64 |
| --- | --- | --- | --- | --- | --- |
| universe memo only | 0.9 s | 3.1 s | — | over 60 s | — |
| all three walks | 0.8 s | 0.8 s | 0.8 s | 0.8 s | 0.8 s |

(0.8 s is the prelude; the fixture adds nothing measurable.) The size and alignment walks in
`src/types/utils.yo` have the same shape but `check` does not reach them for this fixture; they were
not changed.

## Test

`tests/cli-cases/deep-struct-dag-defines-fast`: a depth-64 DAG whose function passes, returns and
rebinds an `S64`, behind a 30 s `timeout`. #996's binary times out; the fixed binary passes in 0.8 s.
