# Does `Future(T, E)` keep an effect row once every row is `Io`?

**Kind:** design question — an open decision, not a defect. Filed 2026-11-28 with the adoption of VERDICTS-96, as E-6 of [`plans/backlog/ERRORS_AS_VALUES.md`](../../plans/backlog/ERRORS_AS_VALUES.md). To be answered by v0.2.84, before AFA-5 declares `BoxFuture(T, E)`.

## The question

A future's type carries an effect row: `Future(T, E)` with `E : Type.Struct`, and `io.await(f, e)` / `io.spawn(f, e)` inject the bundle `e` into the frame (`plans/backlog/IO_INTERFACE_AND_STD_RUNTIME.md` §2, "The effect row `E : Type.Struct` is unchanged"). The row exists so that a handler, which is bound to its install frame, can reach a task without being stored in the future.

After E-3 (v0.2.84) std has no `exn` parameter and `IoExn` is deleted, so every std row is `Io`. After E-5 (v0.2.86) no handler type exists. Should `Future(T, E)` keep its second parameter, or become `Future(T)` with `io` passed as an ordinary value?

## What depends on it

- **Bucket B of VERDICTS-94 §3**: about 2,100 lines (`Future(T, E)` parsing and compatibility, `io.async` binder pre-binding, the bundle layout check, injection at await and spawn, the effect setters in state machines). It is deletable only if the row goes.
- **ALLOCATION_FREE_ASYNC.** AFA-3 stores the bundle in each embedded frame (`Io bundle;` in §3's C sketch), and AFA-5 declares `BoxFuture(T, E)` in the prelude, so the answer fixes BoxFuture's arity.
- **Two open bundle issues**: `issues/2026-10-20-an-effect-binder-bound-only-through-a-future-parameter-resolves-to-io.md` and `issues/an-io-await-with-the-wrong-effect-bundle-passes-check.md`. Both disappear with the row.
- **User capabilities.** A user record of closures (a logger, a clock) can ride in the row today. Without the row it is a capture of the `io.async` body or an ordinary parameter.

## Options

1. **Drop the row.** `Future(T)`, `BoxFuture(T)`; `io.await(f)` and `io.spawn(f)` take no bundle, and the task's `io` is the awaiter's `Io`, passed at start as today's injection does for the `Io` field.
2. **Keep the row, fixed to `Io`.** The surface stays and every instance is `Future(T, Io)`. It keeps the code of bucket B for no second instance.
3. **Keep a general row** for user capability records. It keeps bucket B and the two issues, for a use the tree does not have.

## Recommendation

Option 1, at about 70% (VERDICTS-96 §6, E-6). The row's reason was the frame-bound handler, and E-5 deletes it. `Io` is an interface value (IO-1b), so it can be passed like any other value. Decide it with the AFA lane before AFA-5, so that `BoxFuture` is declared once with its final arity, and schedule the deletion of bucket B after E-5.
