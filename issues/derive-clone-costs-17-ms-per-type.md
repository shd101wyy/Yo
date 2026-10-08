# `derive(T, Clone)` costs ~17 ms per type, so std's derives slow every compile

**Severity:** S3 — a compile-time performance regression: the derives #1269
added to std put +0.15 s on every `yo check`/`compile` of any program, and ~7%
on the formal-verification CI job, which then hit its 90 min cap.

> Found 2026-10-08 while diagnosing develop run 37732698461 (formal
> verification cancelled at the cap on both attempts, every verifier step ~7%
> slower than on 8f13ae338).

## Measurements

All on a Mac Mini M4, installed v0.2.54, `yo check <file> --std-path <std>`,
three interleaved runs each, wall time.

| Program | std at 8f13ae338 | std at a8c9d29b1 (#1269) |
| --- | --- | --- |
| an empty `main` | 0.90 s | 1.05 s |
| `tests/spec/contracts_phase0.test.yo` | 1.90 s | 2.14 s |

The empty program only loads the prelude, which #1269 gave 4 plain derives
(`Pragma`, `Allocator`, `Ordering`, `FutureState`: −0.08 s when removed) and 6
generic ones (`Range`, `Reverse`, `IterPair`: −0.06 s when removed).

Per derive, from user files declaring 40 three-variant enums:

| Shape | Cost per type |
| --- | --- |
| hand-written `impl(E, Clone(clone : (self -> match(...))))` | < 0.1 ms |
| `derive(E, Copy)` (the rule is `ctx.make_impl(quote(Copy()))`) | ~1 ms |
| `derive(E, Clone)` | ~17 ms |

Bisected with custom `derive_rule`s (40 types each, cost above the
trivial rule's ~1 ms):

| Rule body | Extra cost per type |
| --- | --- |
| `Type.get_info` + `Type.get_enum_variants` | ~2 ms |
| a `.to_expr()` of a short string | ~0.5 ms |
| ten chained `__s2` calls | ~0.1 ms |
| `__yo_comptime_fold_range(1, …)` | ~0.75 ms |
| `__yo_comptime_fold_range(3, …)` | ~2.2 ms |
| `__yo_comptime_fold_range(6, …)` | ~5 ms |

Each `recur` step of `__yo_comptime_fold_range` (`std/prelude.yo`) costs
~0.8 ms whether `f` is a named function or a literal. The `Clone`, `Eq`,
`Hash` and `Ord` rules fold over every variant and every field, nested, so
their cost grows with the type's shape.

## Root cause

Not yet pinned below "a comptime `recur` call through a function-valued
comptime parameter". A call with only scalar comptime arguments (`__s2`) is
~0.01 ms, so the cost is in the recursion/function-parameter path, not in
comptime calls generally. These pieces explain ~5 of the `Clone` rule's
~17 ms on a three-variant enum; the rest (its nested folds, `cond`s and the
`quote`d `match`) is unattributed. A symbolized profile of one derive is the
next step.

## Fix direction

Make the comptime recursion path as cheap as a plain comptime call. Not a
hardcoded built-in `Clone` derive in the evaluator: the rules stay in Yo.
Verification: the empty-program `yo check` returns to ~0.90 s with today's
std, and the 40-type `derive(E, Clone)` file costs within 2x of the
hand-written one.
