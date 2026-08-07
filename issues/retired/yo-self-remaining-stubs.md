# yo-self remaining functional stubs — triage (2026-06-27)

Triage of the genuine functional stubs in `yo-self/` (excluding tests). A
"functional stub" is a function that does not do its job (returns a constant /
no-ops) — distinct from legitimate sentinels (`placeholder_token`,
`new_expr_info_placeholder_for_unreachable_`, the `deferred_drop/dup_expressions`
ExprInfo fields) and descriptive "deferred/no-op" comments, which are NOT stubs.

The self-compile corpus is **83/83** and `check ./std` is **152** _with_ these
stubs in place — none breaks the validated path. Each is a focused, often
cascading port, not a quick win.

## 1. `can_type_form_rc_cycle` — `types/utils.yo:520` → `false`

**Scope: LARGE (cascading).** Full plan in
`issues/fixed/yo-self-cycle-gc-runtime-port.md`. Un-stubbing requires porting the
~487-line QuickJS trial-deletion GC runtime (`generateFullGCRuntimeFunctions`) +
the dispose-dispatch function-pointer path + the ref-struct traversal emitter
(written, `scratchpad/ref_struct_traversal.patch`) + the un-stub itself
(`scratchpad/can_type_form_rc_cycle.patch`). Memory-safety-sensitive (ASan).
Task #34.

## 2. `set_expr_as_needs_to_call_dup` — `evaluator/utils.yo:562` → no-op

**Scope: MEDIUM (likely codegen dependency).** Mirrors `setExprAsNeedsToCallDup`
(`src/expr.ts:2445`, ~138 lines, 10+ call sites: assignment, init-assignment,
array, anonymous-struct, type, dyn, helper). Inserts a deferred `___dup`
expression (RC ownership transfer) and marks the owning temp consumed. The
`deferred_dup_expressions` ExprInfo field already exists (`expr_info.yo:349`).
Risk: porting the evaluator side alone may regress the corpus if yo-self codegen
doesn't consume `deferred_dup_expressions` the same way TS does (could
double-dup or leak). Investigate yo-self's current RC dup/drop emission first;
validate with ASan. Corpus-green today because the exercised paths don't need
the shared-ownership dup, or codegen handles it inline.

## 3. `format_yo_source` — `formatter.yo` → returns input unchanged

**Scope: SEPARATE FEATURE.** The self-hosted `yo fmt` pipeline. Not on the
compile critical path (CLI convenience). Port the TS formatter when `yo fmt`
self-hosting is prioritized.

## 4. `build_runner.yo` phase-7 — 3 TODOs (lines 811, 820, 889)

**Scope: ARCHITECTURAL.** Self-hosted `yo build` orchestration: JSON reading via
`std/json` (needs a Reader interface), direct self-hosted module-manager call,
direct evaluator call. Blocked on those subsystems; part of the build-system
self-host phase.

## 5. Minor platform deferrals

- `target.yo:187` — Linux musl detection (Phase 1).
- `env.yo:254` — panic API no-op (Phase 2a; caller-guarded).

These are small and low-impact; do them opportunistically when the surrounding
subsystem is touched.

## Recommendation

Tackle in a dedicated session, in this order of compiler-correctness impact:
(2) RC dup-insertion → (1) cycle-GC runtime → (4) build_runner → (3) formatter →
(5) platform bits. Each needs its own build + ASan/corpus validation; none should
be rushed at the tail of an unrelated session.
