# Should `for_await` stay, become a builtin, or fold into `for`?

**Kind:** design question. **Decided 2026-10-24 (maintainer, with an independent advisor review): delete
`for_await` outright.** No desugar and no replacement name. Code writes the explicit loop. The macro plan's B2
(`plans/backlog/MACRO_AND_ISO_REMOVAL.md`) becomes a deletion, like B3's collection literals. The analysis below
is the record the decision was made on.

## The question

`for_await(stream, io, x => body)` was a std macro (`std/async/stream.yo`, about lines 440–472). The maintainer
asked: why do we need it, given that `for` exists and the algebraic effect system works with a bare `for`?

## What holds

The macro was a fixed template, and its whole expansion is this loop:

```yo ignore
s := stream;
while(runtime(true), {
  n := io.await(s.next(io), io);
  match(n, .Some(x) => body, .None => { break; });
});
```

**A bare `for` covers only the body half.** Yo's `await` is not an algebraic effect. A task suspends only at an
`io.await` node written in its own `io.async` body. Codegen splits that body's state machine at each such node
(`src/codegen/exprs/await.yo`; `plans/archive/FOR_AWAIT_NEEDS_MACRO_AWARE_ASYNC_TRANSFORM.md`). An `io.await` in
any function the task calls is the blocking form. It spins the poll loop and nests the event loop
(`docs/en-US/ASYNC_AWAIT.md`, "blocking await"; `src/codegen/async/runtime_core.yo`). Probes on develop
`f271ed005` with the tree binary:

- A plain `for` whose body awaits, inside a spawned task, compiles and interleaves with `main`. The body is inlined
  into a `while` in the same `io.async` body, so its await suspends.
- A struct whose `Iterator.next` awaits through an `Io` stored in a field, driven by a plain `for` inside a task,
  compiles with no diagnostic and runs serialised. The whole loop finishes inside `io.spawn`'s cold start before
  `main` gets a turn.
- The same, with `next` awaiting a channel that `main` feeds after the spawn, deadlocks every time (rc 124 under a
  timeout). This is the 2026-09-11 failure that `for_await` was introduced to avoid.

So a loop over an async source needs `io.await(s.next(io), io)` written in the loop's own text, with an `io` value
in hand. `for` cannot supply that:

- `Io` is an explicit capability parameter. There is no ambient `io`, and plain functions use `for` with no `Io`
  in scope.
- The `for` desugar (macro plan B1) runs in `parse()`, before name resolution. It cannot see whether the source
  implements `Stream`, and `plans/reference/ASYNC_ITERATION_STREAM.md` already rejected a type-directed loop form.
- The only shape that could fold in is arity dispatch, `for(s, io, x => …)`, which is `for_await` under a worse
  name.

## Why deletion rather than a builtin

1. **It is pure sugar.** The macro consulted nothing semantic, as the plan's B2 says. Its expansion is the idiom
   std already writes by hand (`collect`, `for_each`, the net and channel tests), and `ASYNC_AWAIT.md` already
   presents it as "the hand-written loop". B3's reasoning applies as is: Yo is written by LLMs, and a terse form
   is a human convenience.
2. **It was the only construct that hid a suspension point behind a name.** That hidden await is its whole bug
   history: the 2026-09-11 blocking-await deadlock, and the 2026-10-17 E0911 gap. `src/evaluator/utils.yo` carries
   code (about lines 6270 and 6399) that exists only to re-attribute a std-token await to the call site. Every
   analysis keys on a visible `io.await`: the state-machine split, rule 4, and "build the chain outside the body".
   Deleting the form deletes that special case instead of porting it into the parser.
3. **It costs more to keep than to delete.** Keeping it meant B2's desugar, synthesized-token placement and two
   golden re-records. Against that it had about 23 use lines, all in tests and docs. `break`, `continue` and
   `return` work the same in the explicit `while`. `for_each` with `take` stays for the combinator style.
4. **The two E0911 cli-cases stay, as plain regressions.** They protected rule 4 (decision 26) across an await the
   arm does not spell, a property that existed only because of the macro. With an explicit `io.await` they become
   regressions of "a borrow, or a `mut` match place, live across an await in a loop". The fixtures are rewritten
   and renamed, and they must still be E0911.

## The rule this records

A suspension point is an `io.await` written in the `io.async` body. An `io.await` inside a function the task calls
blocks instead of suspending. `docs/*/ASYNC_AWAIT.md` states this next to the `handle.await` paragraph.

A related finding is filed separately:
`issues/2026-10-24-yo-async-strict-misses-a-blocking-await-during-a-spawns-cold-start.md` (S2).
`YO_ASYNC_STRICT=1` does not catch the probes' blocking await, because the task depth is still 0 during
`io.spawn`'s inline cold start.

## Recommendation

Delete `for_await`, and write `while(runtime(true), { n := io.await(s.next(io), io); match(n, .Some(x) => …,
.None => { break; }) })` instead (maintainer decision of 2026-10-24; implemented by branch
`refactor/delete-for-await`). Whether `for` itself should stay is recorded in
`issues/retired/2026-10-24-should-for-be-deleted-as-sugar.md`.
