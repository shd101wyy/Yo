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

## Profile (2026-10-08)

A `--line-directives -g` build (`yo compile src/main.yo --optimize 2
--line-directives -g`) makes `sample` frames carry `.yo` file:line. On 200
`derive(E, Clone)` enums (inclusive share of the run):

| Share | Where | What |
| --- | --- | --- |
| 33% | `_trial_eval_fn_body` (`src/evaluator/calls/function_type.yo`) | the deferred-definition trial of every `fn` literal in a derive rule (the fold callbacks), re-run on every call of the rule, because a compile-time call re-evaluates a fresh clone of its body |
| 21% | `synthetic_token` (`src/env.yo`) | hashing the full module path on every call, from the operator/method compile-time paths that bind each parameter |
| 12% | `_source_line_of_token` (`src/error.yo`) | splitting the whole input (the 10k-line prelude) per diagnostic, mostly for errors the trial then swallows |

## Fixed so far

- `_source_line_of_token` scans to the row instead of splitting the input.
- The diagnostics-only deferred trial (fresh-id clone, no result comparison,
  no binder stamps) is memoized per definition (site, function type,
  printed body) once it has run clean (`g_deferred_trial_clean`).
- `synthetic_token` keeps the last module's inner map, so a run of calls for
  one module hashes only the name.

Measured on the profiling build, same tree std, three runs each:

| Program | Before | After |
| --- | --- | --- |
| an empty `main` | 1.00 s | 0.63 s |
| 200 `derive(E, Clone)` enums | 4.45 s | 2.84 s |

The empty program now checks faster than before #1269 (0.90 s on the
release seed), since `synthetic_token` and the trial are on every compile's
path.

Soundness probes for the memo, old vs new binary (identical verdicts): a
compile-time function defining a never-called generic `fn` literal whose
body divides by a captured `k` (called with `k = 1` then `0`), and one whose
body constructs a captured type `T` (called with a type that has the field,
then one that does not).

## Still open

A derive still costs ~11 ms (hand-written: < 0.1 ms). The next profile's
largest item is the operator compile-time path: each `==`/`-` on two
compile-time integers pushes an env frame, binds its parameters
(`add_variable_to_env` from `src/evaluator/calls/function.yo`, 17%), and
allocates cycle-collected objects (`__yo_gc_collect`, 9%). Folding a
primitive operator on two concrete values without the frame is the next
step.

## Root cause

A compile-time call is interpreted, not specialized: every call clones its
body with fresh ids and evaluates the clone
(`src/evaluator/calls/comptime_fn.yo`). So everything a derive rule's body
defines is defined again on every derive, and every operator inside it is
another compile-time call. The bisection above attributed the cost to the
fold's recursion, but the profile shows the cost is in what each step
re-does (the trial of the re-defined callbacks, parameter binding,
diagnostics for swallowed errors), not in the recursion itself.

## Fix direction

Keep the rules in Yo (no hardcoded built-in `Clone` derive in the
evaluator), and make what each compile-time call re-does cheap: done for the
three items above; next, the primitive-operator path. Verification: the
empty-program `yo check` at or below ~0.90 s with today's std (met: 0.63 s),
and the 40-type `derive(E, Clone)` file within 2x of the hand-written one
(not yet met).
