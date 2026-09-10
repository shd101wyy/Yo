# `for_await` — blocked on a macro-aware async transform

**Status:** BACKLOG — blocked, with the blocker measured and filed. Written
2026-09-11 when `for_await` was implemented for
`plans/reference/ASYNC_ITERATION_STREAM.md`, worked from `main`, deadlocked
inside a task, and was REMOVED from `std/async/stream.yo` rather than shipped.

## What was wanted

The `for` loop of async iteration — a loop whose body is ordinary code, so it
can `break`, `continue` and `return`:

```rust
conns := listener.incoming().take(usize(3));
io.async((io : Io) => {
  for_await(conns, io, (c) => {
    match(c, .Ok(s) => serve(s, io), .Err(e) => log(e));
  });
})
```

It was option (1) of the stream plan (a macro expanding to `while` + `await
next()` + `match`), recommended there over making `for` polymorphic. The macro
itself is ~40 lines and its expansion is exactly the hand-written loop that
works today; it was written, formatted, and passed every non-suspending test.

## Why it cannot ship

**An `io.await` reached only through a macro expansion is not counted as a
suspension point.** Codegen decides whether an `io.async` body becomes a state
machine by walking the body's AST, and a macro CALL keeps the macro head in
that AST — the expansion lives in `ExprInfo.macro_expansion`. So a body whose
only awaits come from a macro is emitted as a plain C closure, and each await
becomes the blocking form:

```c
static inline void closure_yo_id_18173(void* closure_context, __yo_t23 io) {
  ...
  // Synchronous await (io.await outside state machine)
  while (__await_state != -1 && __await_state != -2) { __yo_async_poll_step(); ... }
```

A blocking await inside a task nests the event loop, so `io.spawn` never
returns from the task's cold start. Measured 2026-09-11: a `for_await` over
`TcpListener.incoming()` inside a spawned task hangs (rc=124) with no output —
the task blocks in `accept` during the spawn, so the caller never reaches the
`connect` that would satisfy it.

Full write-up plus a 20-line reproducer that needs no network:
`issues/io-await-inside-a-macro-expansion-is-emitted-as-a-blocking-await.md`,
`issues/repros/io-await-inside-a-macro-expansion-is-emitted-as-a-blocking-await.yo`.

The failure is worse than a hard error, which is why the macro was removed
rather than documented-with-a-caveat:

- From `main` it is CORRECT (a blocking await is what `main`'s awaits are).
- Inside a task it deadlocks — and a task is exactly where a server loop
  lives.
- When the awaited future completes autonomously (a timer), the blocking poll
  loop drives it and the program merely serialises. So a macro can look
  healthy for its whole test suite and hang the first time it awaits something
  that depends on its own caller.

## What ships instead

`std/async/stream.yo` keeps two consumers whose awaits live in ORDINARY
function bodies, where codegen sees them:

- `for_each(f, io)` — the loop as a combinator; works from `main` and inside a
  task (tested both ways in `tests/async/combinators.test.yo`).
- `collect(io)` / a hand-written `while` + `io.await(s.next(io), io)` +
  `match`, which is what `for_await` expanded to and is what the stream doc
  and the net/channel tests now use.

The only thing lost is the loop-body `break`/`continue`/`return`: a closure
body cannot break the caller's loop, so `for_each` cannot stop early. `take(n)`
covers the bounded case, and `filter`/`filter_map` cover skipping.

## Options

1. **Make the async transform macro-aware (RECOMMENDED).** Follow
   `ExprInfo.macro_expansion` in the "does this body await" predicate and in
   the state-machine splitter, and emit the expansion rather than the call for
   bodies that await. AGENTS.md already states this rule for the dup/drop
   optimizer family ("any tree walk in that optimizer family must follow
   `ExprInfo.macro_expansion` for macro calls"); the async transform is
   another member of it. Then land `for_await` unchanged — it is written and
   its tests exist in this branch's history.
2. **Reject an awaiting macro at definition time.** Cheap, and strictly better
   than the silent deadlock: a macro whose expansion contains `io.await`
   errors unless the enclosing body is already a state machine. It closes the
   footgun without enabling `for_await`.
3. **Make `for` polymorphic over `Iterator`/`Stream`** (option 2 of the stream
   plan). Does not help: the expansion still hides the await, so it hits the
   same wall. Any spelling of an async loop as a MACRO does.
4. **Do nothing.** `for_each` + `take` covers most loops; the cost is that
   early exit from a stream loop stays inexpressible.

Recommendation: (2) as a small standalone guard, then (1) as the real fix,
then land `for_await`. Sequenced that way, no window exists where an awaiting
macro can deadlock silently.

## Cross-references

- `plans/reference/ASYNC_ITERATION_STREAM.md` — the stream design; its
  "Order of work" item 4 is what this doc parks.
- `issues/io-await-inside-a-macro-expansion-is-emitted-as-a-blocking-await.md`
  — the defect.
- `plans/STD_API_STABILIZATION.md` §4 (Concurrency) — where the async surface's
  open items are tracked.
