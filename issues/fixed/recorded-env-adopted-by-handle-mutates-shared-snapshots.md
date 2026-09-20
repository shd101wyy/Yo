# A recorded `ExprInfo.env` adopted by handle and then mutated rewrites every sharer's scope once snapshots are shared

**Status: FIXED 2026-09-21** on `perf/evaluator-memory-p2-f3`
(`plans/EVALUATOR_MEMORY_REDUCTION.md` Phase 2 / F3). Provenance: every
site below was FOUND BY MEASUREMENT (the frozen-env guard's backtrace), the
fix shape was chosen after the emission diff, and the final verdict is the
same-binary A/B recorded in the plan.

## Symptom

With `expr_info_env_snapshot` sharing one snapshot between consecutive
same-scope ExprInfos, `yo check ./src` failed with
`Failed to define variable "body_info": already defined` (cond.yo) — a
recorded scope had gained a frame it never had.

## Mechanism (measured)

`Environment` is a ref struct. ~130 evaluator sites took a recorded env BY
HANDLE (`x = info.env`) and went on to evaluate arguments in it — whose
`begin`/`match` blocks push and pop frames — or pushed a frame themselves.
Pre-sharing each ExprInfo owned a private snapshot, so the mutation only
altered THAT ExprInfo's recorded env (a latent corruption:
`issues/fixed/yo-self-recorded-env-aliasing.md` is the same class). With
sharing it altered every ExprInfo holding the snapshot.

The `frozen : bool` flag (set on every snapshot the memo hands out) plus
`YO_DEBUG_FROZEN=1` (panic in `push_frame`/`pop_frame`/`push_env_frame`/
`pop_env_frame`/`pop_frame_nonmutating` when `self.frozen`) under
`lldb --batch -o run -k "bt 60"` found the adopters one cycle at a time;
frames are hash-only `yo_id_N`, mapped back by re-hashing
`":<file://path>:<row>:<col>"` (FNV-1a) over every token position of the
compiled tree. Eight syntactic shapes of the same adoption, none of which a
single regex catches:

| # | shape | example |
| --- | --- | --- |
| 1 | `x = info.env;` | impl.yo receiver env |
| 2 | `rec.env = info.env;` | impl.yo in-flight record |
| 3 | `x = match(.., .Some(i) => i.env, ..)` | begin.yo return/unwind re-read |
| 4 | `evaluate_*(e, info.env, ctx)` | utils.yo dup synthesis, `as()` |
| 5 | `x := info.env;` | cond.yo case env, 22 builtins |
| 6 | direct mutation of a recorded env | match.yo `pop_env_frame(body_info.env)` |
| 7 | `(x : Environment) = info.env;` | the parameter matcher, 16 builtins |
| 8 | a function RETURNING `info.env` | derive.yo rule runner |

`pop_frame_nonmutating` is not safe on a shared snapshot either: it reassigns
`self.frames`.

## Fix

Adoption is **copy-on-write per ExprInfo**: `expr_info_adopt_env(info)`
(`src/expr_info.yo`) takes a shallow `snapshot_env` copy, points THIS
ExprInfo at it and hands it out. Plain private copies (`snapshot_env(info.env)`)
made the guard clean but changed emission (borrow asserts, an unwind temp):
the pre-sharing aliasing was load-bearing — pushes and temps made through the
adopted env were later read back through `info.env` by the mutation mask
(`mutation_summary.yo`) and codegen's temp lookup. Copy-on-write restores
exactly that for the adopted ExprInfo; never-adopted snapshots stay shared.
Sites #6 (match arm trim) build the trimmed copy and store it back.

## Emission

Against the pre-sharing compiler on the same tree: identical except ONE
dup/drop pair (`src/codegen/functions/context.yo`, `merged_part_lens` moved
into a struct) that the pre-sharing compiler failed to cancel and the shared
one cancels. See the plan for the same-binary A/B (`YO_ENV_NO_RING=1
YO_ENV_ADOPT_ALIAS=1` reproduces the pre-sharing semantics) and its verdict.
