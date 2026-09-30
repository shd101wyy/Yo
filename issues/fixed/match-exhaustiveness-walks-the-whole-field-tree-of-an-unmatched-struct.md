# Match exhaustiveness walks the whole field tree of a struct no arm looks into

**Severity:** S1 — `check`/`compile` time grows with the size of a scrutinee payload's type; the compiler's own build went from 177 s to 654 s and its `tests/internal` CI shards timed out

**Status:** FIXED 2026-09-29 (#996, `fix/seed-safe-join-handle`). Introduced by #993 (`b843e4112`).
**Found:** #996's CI. Every "Compiler internal tests" shard hit its job time limit, and individual
files (`evaluator_index`, `module_invalidation`, `macro_helpers`, `verifier_ghost`) exceeded the
test runner's compile deadline. Before #989 each shard took about 50 minutes.

## Measured

| Workload | `yo-dev` (develop, 2026-09-28, before #993) | #996 stage 1 before the fix |
| --- | --- | --- |
| `compile src/main.yo --skip-c-compiler` | 177 s | 654 s (peak RSS 3.49 → 3.55 GB) |
| its "entry module evaluation" phase | 102 s | 602 s, 470 s of it in `src/evaluator/builtins/build.yo` |
| `check src/evaluator/builtins/build.yo` | 24 s | 525 s |
| `check src/lexer.yo` | 3.5 s | 3.5 s |

A `sample` of the slow `check` had every sample inside one `match_missing_witness` call, with `_useful`
(`src/pattern.yo`) about 208 frames deep. `build.yo` has not changed since #788.

Reproducer: a two-variant enum whose payload is a wide struct, `S(i)` with `w` fields of type
`S(i-1)`, matched with `.A(s) => …, .B => …`. `check` time grows with the payload's `w^depth` leaves:

| Payload | no `match` (both binaries) | with the match, before the fix | after the fix |
| --- | --- | --- | --- |
| w = 40, depth 3 | 0.8 s | 2.0 s | 0.8 s |
| w = 60, depth 3 | 0.9 s | 6.0 s | 0.9 s |
| w = 30, depth 4 | 1.2 s | 16.9 s | 1.2 s |
| w = 40, depth 4 (the cli-case) | — | stack overflow after 16 s (rc 138) | 2.2 s |

After the fix the timings match the pre-#993 binary. (A deep binary DAG, `S(i) :: struct(a : S(i-1),
b : S(i-1))`, was the first reproducer, but defining such a type is slow by itself, match or no
match: `issues/fixed/defining-a-deep-struct-dag-is-exponential.md`.)

## Root cause

`_useful` is Maranget's usefulness algorithm. For a wildcard head at a tuple- or struct-typed
column, #993 always specialized by the type's one constructor, expanding the column into one
wildcard column per field. The expansion then recursed into every struct-typed field. A tuple or
struct has one constructor, but the signature is complete only when that constructor appears in the
column. With only wildcards there, the constructor set is empty, and the default matrix decides the
column. This is how the enum branch right above it already works (`_missing_variants`: missing
variants ⇒ the default matrix). With no arm looking inside the payload, the expansion visited every
field of the payload type's tree, and this happened in each `match_missing_witness` and per-arm
`arm_reachability` call. The compiler's own matches bind payloads such as `Target` and the context
structs, whose field trees are large.

## Fix

`_useful` expands a tuple or struct column only when some row's head in it is a tuple or struct
pattern (`_column_has_aggregate`). Otherwise the column falls through to the default matrix, whose
witness is `_`.

## Test

`tests/cli-cases/match-exhaustiveness-does-not-walk-an-unmatched-struct-field-tree`: `check` on the
width-40, depth-4 fixture must pass within the case's 30 s `timeout`. The unfixed compiler overflows
its stack (rc 138); the fixed one passes in about 2 s. `tests/match_structs.test.yo` and
`tests/match_tuples.test.yo` still pass, including their exhaustiveness diagnostics.
