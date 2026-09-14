# A `while` loop with an await, inside a `match` arm, emits no loop at all — its body never runs

**Found**: 2026-09-14, while root-causing #556. **Status**: OPEN — root cause
established with a minimal reproducer; the codegen fix is not written yet.
**Not a regression**: the v0.2.32 seed reproduces it identically, so this has
been live for as long as #556 has been failing.

## THIS IS THE ROOT CAUSE OF #556

`issues/a-bodyless-http-response-is-not-read-until-the-deadline.md` spent days
in the HTTP client, then in kqueue, then in io_uring. It is in none of them.
Everything that document records as a symptom — "an inner `io.async` block
completes and the parent await never resumes", the ten-second timeout on an
exchange that takes a millisecond, the identical behaviour on both I/O backends,
the platform-roulette — follows from this one defect.

## Reproducer

`issues/repros/while-in-match-arm-loses-its-loop.yo`. No network, no HTTP, no
threads:

```rust
match(
  o,
  .NoLimit => { turns = i64(-1); },
  .Limit(secs) => {
    h  := e.io.spawn(<a 30 ms task>, e.io);
    dh := e.io.spawn(sleep(Duration.from_secs(secs), e.io), e.io);
    while(runtime(!h.is_finished() && !dh.is_finished()), {
      e.io.await(yield(e.io), e.io);
      turns = (turns + i64(1));
    });
    println(`after loop: turns=... h_fin=... dh_fin=...`);
  }
);
```

Prints:

```
turns=0
BUG: the while condition was false at entry while both handles were unfinished
```

The loop body runs **zero** times, and one line later both `is_finished()`
calls return `false` — so the condition was not merely raced, it was never a
loop. With the sibling arm ALSO awaiting, the same shape escalates to a
segfault: `EXC_BAD_ACCESS (address=0x8)` in the resume function at the
`is_finished()` state-word read, i.e. a NULL `JoinHandle.__future`.

## What the emitted C shows

The state struct declares the loop's continuation flag:

```c
// Loop state tracking for while loops with await
_Bool while_loop_0_active;  // Whether while loop 0 should continue
```

and that is the **only** occurrence of `while_loop` in the entire emitted
program. No `while_loop_0_start` label, no `while_loop_0_end`, no assignment,
no re-check. The await inside the body IS emitted
(`sm->await_future_0 = (void*)(__yo_async_yield_start());` with a state
transition), but there is no loop around it.

So the detection half works — `src/codegen/exprs/async.yo` sees an await point
with `is_inside_while` and emits the field — while the emission half
(`src/codegen/async/state_code_gen.yo`, which owns `while_loop_N_start`/`_end`
and the break/continue info) never runs for this shape. A declared-and-never-used
field is the tell.

## Why it produces exactly #556's symptom

`std/http/client.yo`'s `_fetch_deadline` is that shape — the `while` lives in
the `.Some(limit)` arm of a match on `opts.timeout`:

```rust
h  := e.io.spawn(_fetch_follow(...), e);
dh := e.io.spawn(sleep(limit, e.io), e.io);
while(runtime(!h.is_finished() && !dh.is_finished()), { e.io.await(yield(e.io), e.io); });
cond(
  h.is_finished() => { ...deliver the response... },
  true            => { h.abort(); e.exn.throw(dyn(HttpError.Timeout)); }
);
```

With the loop gone, control reaches the `cond` immediately. `h` has not
finished — it has barely started — so the `true =>` arm runs: it **aborts the
exchange and throws `HttpError.Timeout` at once**. Instrumented locally:

```
[srv] TASK ENTERED
[srv] about to accept          <- server parks, correctly
[204] server spawned, issuing request one
[flw] FOLLOW TASK ENTERED      <- the exchange task does start
[dl] spin begins
[dl] spin ended after 0 turns h_fin=false dh_fin=false
unexpected exception: HTTP request timed out
```

That accounts for every open question in the other document:

- **Why the error is always `Timeout` and never the real one** — the `true =>`
  arm is unconditional once the loop is missing; it can only ever report its
  own impatience.
- **Why the server sits in `accept`** — the client aborts before connecting.
- **Why both I/O backends behave identically** — neither is involved.
- **Why "the parent await never resumes"** — it was aborted, not stuck.
- **Why it is platform-roulette** — whether the aborted exchange has already
  printed a checkpoint depends on scheduling, so the trace truncates in
  different places. The abort is deterministic; only what precedes it is not.

## It reproduces locally, contrary to the record

The other document says 27 local runs were clean. That was measured against a
runtime with two since-fixed bugs in the wake path. On a current build,
`tests/http/http.test.yo` fails on the **first** run, and the single test in
isolation fails deterministically. Do not re-spend an afternoon proving it does
not reproduce.

## The fix, and what it is not

The fix belongs in `state_code_gen.yo`: a `while` whose body contains an await
must emit its loop when it appears inside a match arm, exactly as it does at
statement level. `src/codegen/async/state_code_gen.yo:234` already describes
the intended behaviour ("the looping arm's await must re-check
`while_loop_N_active` and jump to `after_while_loop_N` when broken, the plain
arm's must not"), so this is a missed case in existing machinery rather than an
unimplemented feature.

**What it is NOT**: rewriting `_fetch_deadline` to avoid the shape. That would
make #556 pass while leaving a compiler that silently deletes loops, and the
next person to write a `while` in a match arm gets the same silent wrong answer
with no test to catch it. `plans/backlog/ASYNC_DEADLINE_COMBINATOR.md` argues
that spin should become a real combinator anyway, and it should — but on its
own merits, after this is fixed, not as a way around it.
