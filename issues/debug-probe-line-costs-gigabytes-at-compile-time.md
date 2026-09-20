# A 5-line debug-probe enrichment in synthesizer.yo cost +11.7 GB / +2.9x wall of SEED-compile memory — compile-time, with the probe never firing

**Status: FIXED 2026-09-20 (root cause and fix below; the standalone repro is the
GATE 0 compile-cost ratchet in `scripts/bootstrap/gates_fast.sh`).** Originally:
OPEN (the probe is reverted; the underlying compile-cost mechanism is the open
part). Found 2026-08-24 root-causing what was first
misdiagnosed as "S1 std growth hit a memory wall"
(issues/retired/std-s1-prelude-growth-tripled-self-emit-memory.md — superseded by
this doc's finding).

## The numbers (seed v0.2.16, `yo compile src/main.yo --release
--skip-c-compiler`, peak = `/usr/bin/time -l` peak memory footprint)

2×2 over #242's two src files on the develop tree (full S1 std content):

| impl.yo (cell-chain fix) | synthesizer.yo (probe enrichment) | wall | peak |
|---|---|---|---|
| old | old | 140 s | 17.5 GB |
| NEW | old | 140 s | **17.5 GB** |
| old | NEW | 410 s | 29.1 GB |
| NEW | NEW | 390-402 s | 29.1 GB |

So the #242 cell-chain fix is FREE, and the ENTIRE regression is the
`[bind-T]` probe enrichment in `_bind_some_type`
(src/evaluator/types/synthesizer.yo) — a block gated behind
`YO_DEBUG_BIND`, which is UNSET in every one of these runs. The cost is
paid COMPILING the probe, not running it. Line-level split:

- `slot_str := match(old_var.value.get(usize(0)), .Some(ovv) =>
  value_to_string(ovv), .None => String.from("-"));`
  → **+8.7 GB, +220 s** on its own.
- The remaining enrichment (gate conjunct removal + `slot_id=${…}
  src_id=${…} selfm=${….to_string()}` template refs) → **+3.0 GB, +45 s**.

For scale: the whole S0+S1 std campaign (5 merged PRs, ~1,000 added prelude
lines) costs +0.4 GB total (17.1 → 17.5). One probe line cost 22× the
entire campaign.

## Why this went to CI as a "memory wall"

The 16 GB differential-shard runners swap-thrashed under the 29 GB peak
(stage-1 build 12.8 → 60.5 min), heavy internal files then tripped the
600 s evaluator deadline, and all four required shard checks became
un-passable. The budget patch (#244) papered over it and was REVERTED right after the
probe fix: the probe fix restored fast builds (shard build back to minutes
on the first post-fix run), and #244's `--compile-timeout-ms` flag was
INVALID anyway — `yo test` has no such option (the 600 s deadline is
hardcoded on the runner's CHILD compile, src/main.yo ~2506), so every
shard file failed instantly on 'unknown option'.

Measurement trap that delayed the diagnosis: an early baseline ran in a
worktree WITHOUT `vendor/` submodules initialized (the known fresh-worktree
trap), reading 10.0 GB and manufacturing a phantom "S0 tripled memory"
jump. All apples-to-apples (with-vendor) numbers: pre-#238 17.1 GB,
post-S1 17.5 GB.

## Open question — the actual mechanism

Why does compiling ONE gated statement cost gigabytes? The block sits in
`_bind_some_type`, whose body the seed def-time-evaluates and specializes
during the self-emit. Suspects, unverified: (a) def-eval descent into
`value_to_string(<unknown EvalValue>)` from a NEW binding shape exploding
the trial/specialization graph a generation deeper (the old probe already
called `value_to_string(val)` on a parameter, which was cheap — the
difference may be the Option-unwrap match producing a fresh unknown
lineage); (b) per-interpolation costs in the template string (each extra
`${…}` measurably GBs). Distill a minimal repro (a gated eprintln with a
match-unwrapped unknown fed to a large recursive formatter, in a
module-level fn), attribute with the live census
(scripts/bootstrap/live_census.py), and fix the underlying evaluator
behavior — probes must be O(probe size) to compile.

## Rule of thumb until the mechanism is fixed

Debug probes in HOT evaluator files: keep interpolations few and feed them
PARAMETERS or precomputed strings, not match-unwrapped values routed
through big recursive formatters. Measure the self-emit peak
(`/usr/bin/time -l`, with vendor initialized!) before landing any probe in
src/evaluator/.

## Root cause (2026-09-20)

**The evaluator's cost is ~4× per level of a left-nested method-call chain,
and a template string with N interpolations IS such a chain.**
`parse_template_string` (`src/parser.yo`) folds the parts as
`(prev.+)(part)` — a `.`-callee method call per part, each part wrapped in
`.to_string()` — so N interpolations produce ~2N nesting levels. In
`evaluate_function_call` (`src/evaluator/calls/function.yo`) a DOT callee's
receiver is evaluated to resolve the method, and then the SAME receiver AST
node is pushed into `all_args` (~line 6905, `all_args.push(method_info.receiver_expr)`)
and evaluated again by argument matching; further re-visits (the operator
path's `evaluate_expression_raw(first_arg, …)` at the head of the function,
def-time trial + real evaluation) bring the measured multiplicity to ~4 per
level, compounding down the chain.

Standalone repro, v0.2.38, `yo check` of a 15-line program whose one
function binds N `String` locals and prints them in ONE template:

| N interpolations | footprint | wall   |
| ---------------- | --------- | ------ |
| 5                | 1.21 GB   | 3.4 s  |
| 6                | 1.23 GB   | 3.6 s  |
| 7                | 1.34 GB   | 4.2 s  |
| 8                | 1.78 GB   | 7.3 s  |
| 9                | 3.57 GB   | 19 s   |
| **10**           | **10.7 GB** | **67 s** |
| manual `((s0 + s1) + s2)…` chain of 20 operands | 4.38 GB | 26 s |
| `s.clone().clone()…` × 20                        | 7.72 GB | 42 s |

The increments 0.11 / 0.44 / 1.79 / 7.1 GB are ×4 per level. The 2026-08-24
probe (`[bind-T]`, +11.7 GB) and #800's `[chres-oor]` probe (+11.6 GB,
`issues/seven-gated-debug-probes-cost-11-gb-of-check-memory.md`) were both
10-interpolation templates; the "match-unwrapped unknown fed to a recursive
formatter" hypothesis was wrong — the formatter never mattered, the count
did.

Fix direction: the receiver of a method call must be evaluated ONCE (reuse
its recorded `ExprInfo` when argument matching meets an already-evaluated
node), and the template fold should not need to be left-nested at all. The
parser-side flattening alone would leave `a.f().g().h()` chains exponential,
so the evaluator fix is the real one; the repro shapes above are the gate.

## Fix (2026-09-20)

`mark_node_preevaluated` / `unmark_node_preevaluated` / `node_is_preevaluated`
(`src/expr_info.yo`): a method call marks its receiver node, and an infix
operator call its first operand, for the duration of the call's argument
matching; the evaluator's dispatcher (`_evaluate_expression_raw_wrapper`,
`src/evaluator/exprs/_expr.yo`) returns a marked node whose `ExprInfo` is
already recorded instead of re-evaluating it. The operator's SECOND operand
is only probed without an expected type and is deliberately NOT marked: a
literal `0` there must still be evaluated against the parameter type
(`(v.fields.len() == 0)` in the prelude's derived `Eq` failed with
"Cannot unify usize and i32" when it was).

Measured with the tree-built compiler (`YO_SPEC_REPORT=1` counts evaluations
per AST node id):

| program (`check`)                    | before (seed)     | after            | most-evaluated node |
| ------------------------------------ | ----------------- | ---------------- | ------------------- |
| `s.clone()` × 20                     | 8.32 GB / 38 s    | 0.92 GB / 3.9 s  | 1,048,576 → 8       |
| template with 10 interpolations      | 11.53 GB / 66 s   | 0.92 GB / 2.6 s  | 1,048,576 → 8       |
| `((s0 + s1) + s2)…` × 20             | 4.38 GB / 26 s    | 0.92 GB / 2.6 s  |                     |
| node evaluations, 20-deep chain      | 5,365,871         | 89,450           |                     |

Regression guards: `issues/repros/template-ten-interpolations-is-linear.yo`
(twelve interpolations + a 14-deep method chain + a 14-operand operator chain)
compiled under a 120 s timeout by `gates_fast.sh` GATE 0; the values a long
template / chain must produce are pinned in `tests/template_string_specs.test.yo`.
