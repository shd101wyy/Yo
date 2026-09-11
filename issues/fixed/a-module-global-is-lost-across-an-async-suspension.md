# A module-level mutable binding is lost across a suspension point in an `io.async` body

**Status: FIXED 2026-09-11.** Found 2026-09-11 while writing the keep-alive server for
`std/http`'s pool tests, where a module-level accept counter written by a
spawned server task read back as zero.

## Symptom

A module-level mutable binding (`(g_n : usize) = usize(0);`) read or written
inside an `io.async` body that SUSPENDS operates on a copy: the writes are
lost, and a later call starts from the value the global had before the body
ran. The same body with no `io.await` in it updates the real global.

## Reproducer

`issues/repros/module-global-lost-across-an-async-suspension.yo`:

```
flat, awaited:       task=2 global=2      <- correct
suspending, awaited: task=2 global=0      <- writes lost
suspending, awaited: task=2 global=0      <- and the second call restarts from 0
suspending, spawned: task=2 global=0
```

Every body is the same two increments of `g_n`; the suspending ones have an
`io.await(sleep(1ms))` between them. The task's own return value shows it saw
1 then 2, so the increments happened — against storage the caller cannot see,
and which the next call does not see either.

## Why it matters

It is silent. The testing guidance in
`.github/instructions/testing.instructions.md` recommends a module-level
counter as the in-language oracle for a leak, and that recommendation is sound
only for synchronous code: an async body that suspends makes the counter read
zero, which looks exactly like "the thing under test never happened". It cost
an afternoon of chasing a working pool that reported no accepts.

The workaround, used by `tests/http/http.test.yo`'s `_KaStats`, is to put the
counters in a `ref(struct(...))` and pass it as a parameter — reference
semantics are shared by construction. (That workaround costs a leaked
reference per call, for
`issues/a-ref-value-passed-to-an-async-future-is-never-released.md`.)

## Where to look

A suspension splits the body into state-machine states, and locals that live
across the split are moved into the future's state struct. A module-level
binding is not a local and must keep being addressed as a global; the symptom
says it is being promoted into that struct (snapshot on entry, written back
nowhere). `src/codegen/async/` — the state-field promotion decision.

## Fix

`src/evaluator/shared/suspension_analysis.yo` — `_capture_env_variable` returns
early for a module-level global, so it is never hoisted into the state-machine
struct. A global has static storage duration: it survives the suspension by
construction, and every state addresses it by its module-mangled C name. This
mirrors the guard the CLOSURE-capture path already had
(`src/evaluator/context.yo`) and uses the same REGISTRY (`is_module_level_global`)
rather than `Variable.is_module_level`, for the reason recorded there — env
copies drop that flag on some resolution paths while keeping it on others.

Verified with the reproducer (all four lines now `global=2`/`global=4`) and by
`tests/async_await.test.yo`, "Test a module global survives a suspension
point": the control with no suspension, the regression case, a second call
continuing from the global, and a spawned task.
