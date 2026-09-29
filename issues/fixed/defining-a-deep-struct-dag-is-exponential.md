# Defining a deep struct DAG costs time exponential in its depth

**Severity:** S3 — no real program has been seen hitting it; a struct type that holds the same struct type several times, nested deep, makes every check of the module slow

**Status: FIXED** (2026-09-29): `type_of_type_with_visited`'s replacement
`_universe_of` (`src/types/hierarchy.yo`) memoizes each named aggregate by
its eval id — declaration-stable per declaration, eval-fresh per generic
instantiation — within one top-level walk, so a struct DAG's shared subtrees
are walked once per distinct type instead of once per leaf path. Entries
computed while the name-cycle guard fired are not stored (their result is
path-dependent). Unions are not memoized (they carry no eval id; a name key
would be unsound across modules) — a union DAG stays path-walked; filed as
the residual below. Measured after the fix (same machine as the table above): depth 22
48 s → 2.8 s, depth 26 >100 s → 6.2 s, depth 28 (unmeasurable before)
19.3 s. Still superlinear (~3× per +2 depth) — a second walk with the same
shape remains; attribution open. Regression:
`tests/cli-cases/deep-struct-dag-defines-fast` (depth-24 binary DAG behind a
30 s timeout — the unfixed build times out at rc 124; the fixed build
passes).

**Status:** OPEN (filed 2026-09-29). RESIDUAL: union-typed DAGs are still
path-walked (no eval id to key on).
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

`yo check`; the numbers are the same for `yo-dev` (develop, 2026-09-28) and #996:

| depth | 16 | 18 | 20 | 22 | 26 |
| --- | --- | --- | --- | --- | --- |
| time | 1.0 s | 1.6 s | 4.1 s | 15.8 s | over 100 s |

Each extra level of depth roughly doubles the time, so the cost follows the 2^depth leaves of the
type's expanded field tree, not the d + 1 type definitions.

## Where (measured, not yet root-caused)

A `sample` at depth 22 is dominated by `type_of_type_with_visited` (`src/types/hierarchy.yo`). For a
struct, it recurses into the fields, and `visited` guards against cycles by name along the current
path only. Nothing remembers a struct already computed, so a type reached along 2^k paths is walked
2^k times. Whether other walks (`type_key`, size or layout) have the same shape is
still open as of the fix; the fix covers `type_of_type` only.
