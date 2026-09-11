# An `io.await` inside a macro expansion is emitted as a BLOCKING await (no state machine)

**Status: OPEN** (found 2026-09-11 while implementing `for_await` for
`std/async/stream.yo`). **Severity:** HIGH for anyone writing a macro that
awaits — the failure is a silent DEADLOCK inside a spawned task, with no
diagnostic, no untranspiled marker and a clean `yo check`.

## Symptom

Codegen decides whether an `io.async` body becomes a state machine by looking
for `io.await` calls in the body's AST. A macro CALL keeps the macro head in
the AST — the awaits live in `ExprInfo.macro_expansion` — so a body whose only
awaits come from a macro expansion is compiled as a plain C closure and each
await becomes the blocking form:

```c
static inline void closure_yo_id_18173(void* closure_context, __yo_t23 io) {
  ...
  // Synchronous await (io.await outside state machine)
  ...
  while (__await_state != -1 && __await_state != -2) { __yo_async_poll_step(); ... }
```

A blocking await inside a task nests the event loop, so `io.spawn` never
returns from the task's cold start. When the awaited future can only complete
because of something the CALLER does after the spawn, that is a deadlock:

`issues/repros/io-await-inside-a-macro-expansion-is-emitted-as-a-blocking-await.yo`
— a 20-line reproducer: a macro that expands to `io.await(ch.recv(io), io)`,
called inside `io.async`, spawned; the caller's `try_send` is never reached.
`timeout 10 ./repro` → **rc=124, no output**. Writing the same await directly
in the async body prints both lines and exits 0.

It does NOT always deadlock, which is what makes it dangerous: when the
awaited future completes autonomously (a timer), the blocking poll loop drives
it to completion and the program merely serializes where it should have
suspended. The same macro is then "working" until the awaited operation starts
depending on the caller.

## Why it matters

It makes an awaiting macro impossible to ship. `for_await(stream, io, (x) =>
body)` — the `for` loop of `plans/reference/ASYNC_ITERATION_STREAM.md`, whose
whole point is a loop body that can `break`/`continue`/`return` — was written,
tested and then REMOVED from `std/async/stream.yo` for exactly this: it is
correct from `main` and deadlocks inside a task, which is the shape a server
loop has. The stream consumers that survive (`for_each`, `collect`) put their
await inside an ordinary function body, where codegen sees it.

`plans/backlog/FOR_AWAIT_NEEDS_MACRO_AWARE_ASYNC_TRANSFORM.md` records the
design consequences and the options.

## Root cause (located, not yet fixed)

The async-body detection and the state-machine split walk the body's AST
without following `ExprInfo.macro_expansion`. AGENTS.md already carries the
general form of this rule for the dup/drop optimizer family:

> any tree walk in that optimizer family must follow `ExprInfo.macro_expansion`
> for macro calls (`for`, collection literals, user macros — their calls keep
> the macro head in the AST; the expansion is where branch structure is
> visible)

The async transform is another member of that family and does not follow it.
Start at the "does this body contain an await" predicate and the suspension
point collector in `src/codegen/async/`, and at the `Synchronous await
(io.await outside state machine)` emitter that produces the marker above.

## Fix sketch

1. Make the await/suspension-point walk descend into `ExprInfo.macro_expansion`
   (the same helper the dup/drop optimizer uses).
2. Make the state-machine splitter emit the macro EXPANSION rather than the
   macro call for bodies that contain awaits, so the split points land inside
   it.
3. Regression test: the reproducer above, plus a `for_await` over a channel
   fed by a sibling task (the test that was removed from
   `tests/async/channel.test.yo` in the same commit — see the plan doc).
