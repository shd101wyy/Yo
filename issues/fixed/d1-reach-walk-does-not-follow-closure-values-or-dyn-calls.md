# Rule D1's reachability walk does not follow calls through closure values or `dyn` methods

**Found:** 2026-09-26, implementing `plans/PARALLELISM_SOUNDNESS.md` Phase 3 (rule D1 of
`plans/reference/PARALLELISM_RULES.md`).
**Status:** FIXED 2026-09-26 (`plans/PARALLELISM_SOUNDNESS.md` Phase 2 PR). Was: OPEN — closes together with rule D4 (a closure type is `Send` iff its captures are),
which needs the same prerequisite: per-closure identity on `Func` types
(`plans/TYPE_SYSTEM_SOUNDNESS.md` Phase 3, type identity).
**Class:** thread-safety design gap (a residual of the D1 fix, not a regression).

## What D1 checks today

A closure bound to a `Send` closure type (a `Thread.spawn` / pool `spawn` body) may not reach a
non-`Send` module-level global, directly or through the functions it calls
(`function_reaches_non_send_global`, `src/evaluator/effects/mutation_summary.yo`). The walk follows
the STATIC call graph: a call whose callee the evaluator resolved to a `FuncVal` (plain calls,
method calls, index-trait calls) is descended into.

## The hole

A call through a closure VALUE (a local `Impl(Fn(...))` binding, a closure parameter, a closure
stored in a struct) or a `dyn` method carries no compile-time `FuncVal` on its call node, so the
walk cannot see its body. The closure below captures nothing (`g` is a module global, not a
capture), so its capture struct is trivially `Send`, and the spawn body only calls it:

`issues/repros/d1-reach-through-a-closure-value.yo` — `yo check` is green and the program races on
`g` exactly like the original `issues/fixed/module-globals-bypass-send-so-safe-code-can-data-race.md`.

Treating every unresolvable callee as a violation (a MAY-analysis) was tried first and rejected:
it convicted every spawn body that calls a captured helper closure (`tests/thread_safety`,
`tests/sync/rwlock`) or an operator the evaluator does not stamp with a callee (`+`, `match`
inside `panic`) — 8 of 22 parallelism suites red.

## Fix direction

When closures carry their identity on the `Func` type, a closure that reaches a non-`Send` global
is itself not `Send` (its "reach" joins its capture struct in the auto-trait computation), and the
capture check at the spawn boundary rejects capturing it. That is rule D4's mechanism; D1 becomes
one more input to it. A `dyn` receiver's `Send`-ness is already its dyn type's bound.

## Fix (2026-09-26)

Neither half needed per-closure identity on `Func` types after all:

- **Closure values.** A local closure keeps its `FuncVal` in its binding's value cell even
  though the call node carries none, so the reach walk resolves an atom callee through the env
  (`_gr_walk_closure_callee`, `src/evaluator/effects/mutation_summary.yo`) and descends into
  that body. A closure PARAMETER is covered at the literal's own creation site: a literal bound
  to a `Send` slot runs the D1 check there.
- **dyn methods.** At `dyn(...)` the concrete impl is known, so a `Dyn(Trait, Send)` value's
  vtable methods are walked there (`_require_send_dyn_methods_reach_no_global`,
  `src/evaluator/values/dyn.yo`), both coercion sites.

Tests: the repro's shape (a spawn body calling a local closure that pushes to a global
`ArrayList`) and a `Dyn(_GlobalPusher, Send)` whose method pushes to it, as
`comptime_expect_error` blocks in `tests/parallelism_soundness.test.yo`; the thread corpus
(`tests/thread_safety`, `tests/sync/rwlock` — spawn bodies calling captured helper closures that
touch only atomics) stays green.
