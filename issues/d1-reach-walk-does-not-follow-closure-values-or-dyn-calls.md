# Rule D1's reachability walk does not follow calls through closure values or `dyn` methods

**Found:** 2026-09-26, implementing `plans/PARALLELISM_SOUNDNESS.md` Phase 3 (rule D1 of
`plans/reference/PARALLELISM_RULES.md`).
**Status:** OPEN — closes together with rule D4 (a closure type is `Send` iff its captures are),
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
