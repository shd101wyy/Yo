# `io.await` on a join handle is reported as an INTERNAL COMPILER ERROR

**Status: OPEN (filed 2026-09-13).** Found while promoting
`issues/repros/spawn-blocking-tests.yo` to a live test file — two of its four
tests used this spelling, so it had been written into a test nobody could run.

## Symptom

```rust
{ println } :: import("std/fmt");
main :: (fn(io : Io) -> unit)({
  a := io.spawn(io.async((io : Io) => i32(1)), io);
  ra := io.await(a, io);          // <-- a is a JOIN HANDLE, not a Future
  println(`ra=${ra + i32(0)}`);
});
export(main);
```

```
yo: error: internal compiler error: await argument must be a Future type
This is a bug in the Yo compiler, not in your program — please report it:
https://github.com/shd101wyy/Yo/issues
```

**The last sentence is false, and that is the bug.** The program IS wrong:
`io.spawn` hands back a join handle, which is awaited as `handle.await(io)`
and yields `Option(T)` (`.None` when the task unwound). `io.await` takes a
`Future`. The user is told to file a compiler bug for their own type error,
with no line number, no span and no mention of the construct at fault.

## Reproducer

`issues/repros/io-await-on-a-join-handle.yo`

**Pre-existing, not a regression.** Reproduces identically on the published
v0.2.32 seed and on a tree build — measured side by side, same message.

## Root cause

`src/codegen/exprs/await.yo:393-396` guards the await emitter:

```yo
future_type := match(context.base.get_expr_info(future_arg), .Some(ei) => ei.ty, .None => return(codegen_fatal_expr(...)));
if(!type_implements_future(future_type), {
  return(codegen_fatal_expr(String.from("await argument must be a Future type")));
});
```

`codegen_fatal` is the right tool HERE: by the time codegen runs, a non-Future
argument to `io.await` is a broken compiler invariant, and codegen has no span
to report against. The defect is upstream — **the evaluator accepts the call**.
It should reject a non-`Future` argument to `io.await` at the call site, where
the token and the argument's type are both in hand.

So this is not a "make the message nicer" task. It is a missing evaluator
check, and the ICE is the symptom of its absence.

## Why it matters more than a bad message

An ICE tells the reader to stop and report, so the natural response is to file
a bug rather than to fix the call — the diagnostic actively points away from
the fix. It also hides a real API asymmetry worth knowing:

| you have | how you await it | result |
| --- | --- | --- |
| `Impl(Future(T, E))` — from `io.async`, or any async fn | `io.await(fut, io)` | `T` |
| a join handle — from `io.spawn(fut, io)` | `handle.await(io)` | `Option(T)` |

Both are spelled "await" in prose, and the two are not interchangeable.

## Fix

Reject it in the evaluator, at the `io.await` call, with the span and a
did-you-mean: *"`io.await` expects a Future; `<x>` is a join handle — write
`<x>.await(io)`, which returns `Option(T)`."* Keep the codegen `codegen_fatal`
exactly as it is: once the evaluator gate exists, reaching it really would be a
compiler bug, and that is what it should say.

The general rule, which is the part worth keeping: **`codegen_fatal` is for
broken invariants, so every condition it guards must already be unreachable for
a well-typed program.** A `codegen_fatal` that a user's source can trigger is a
missing evaluator check wearing an ICE's clothes — and it misreports whose bug
it is.

## ATTEMPTED AND MEASURED NOT TO FIRE (2026-09-13): a plain `exn.throw` gate

The obvious version of the fix was built and it does NOT work. Recorded so the
next attempt starts one step further along.

The gate went in the `is_io_await_call(expr)` arm of `evaluate_function_call`'s
`rt` branch (`src/evaluator/calls/function.yo`) — read the first argument's
`ExprInfo`, and if its type is fully CONCRETE (not a `SomeT`, does not contain
one, not `unit`, not a function type) and `!type_implements_future(...)`, then
`exn.throw(format_error_message(ast_expr_token(_aw_arg), ...))`. It compiles,
`check ./src` and `check ./std` pass, and the reproducer still prints the ICE,
unchanged.

The predicate is not the problem: `JoinHandle(T)` is a plain
`struct(__future : *(T))` (`std/prelude.yo`) with no `Future` impl, so
`type_implements_future` is false for it, and nothing in the guard excludes it.

**The throw is almost certainly being SWALLOWED by the def-time trial** — the
same masking this repo documents elsewhere as "def-eval swallow masks type
errors". The pattern that survives it is already in this file, at the C19
argument-type-mismatch arm of `_evaluate_funcval_runtime_call`: flag the
flow-violation channel first, so an async-closure-body swallow re-raises it at
check time, and only then throw:

```yo
if(!(ctx.is_in_function_call_checking_phase) && !(propagate_def_time_errors()) && !(flow_violation_pending()), {
  flag_flow_violation(msg.clone());
});
exn.throw(dyn(format_error_message(tok, msg)));
```

So the next attempt is that same shape, not a different predicate and not a
different site. Confirm the swallow first — `YO_DEBUG_SWALLOW=1` makes it
visible — rather than assuming it, since "the gate did not fire" has more than
one cause and only one of them is this.
