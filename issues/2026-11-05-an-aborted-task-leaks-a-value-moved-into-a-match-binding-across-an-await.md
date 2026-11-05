# An aborted task leaks a value moved into a `match` binding across an await

**Severity:** S2 — aborting a task while it waits inside a `match` arm never drops the arm's by-value binding: one value (and everything it owns) leaks per aborted task.

Found while migrating `tests/async/sm_ownership.test.yo` off `ref(struct)` (V5 part B, branch
`vbd/v5-part-b-tests`), on develop 68b45b81d. Its case "an aborted task drops a pattern
binding's scrutinee once" passes with a `ref` payload and fails with a value payload: the
`Drop` counter stays at 0.

## Symptom

```yo ignore
o := Option(V).Some(V(n : i32(5)));
match(
  o,
  .Some(q) => {
    io.await(yield(io), io); // the task is aborted here
    q.n
  },
  .None => i32(0)
)
```

Spawned, then aborted at the await, the task never drops `q`. The same task awaited to completion
drops it once. Reproducer: `issues/repros/2026-11-05-aborted-task-leaks-moved-match-binding.yo`
(`yo compile <it> -o r && ./r` prints `aborted: 0` / `completed: 1`; both should be 1).

Measured shapes (develop 68b45b81d, `V` a `Drop` value struct; the count is the drops seen after the abort):

| Task body | Drops |
| --- | --- |
| `match(o, .Some(q) => { await; q.n }, …)`, `o : Option(V)` | 0 |
| the same, `o : Option(Box(V))` | 0 |
| the same, `o : Option(Rc(V))` | 0 |
| the same, `o : Option(W)` (a wider payload, no niche) | 0 |
| `match(&o, .Some(q) => { await; q.n }, …)`, `o : Option(Rc(V))` | 1 |
| `o := Option(Rc(V)).Some(…); await; o.is_some()` (no match) | 1 |
| `o := Rc.new(V(…)); await; o.n` | 1 |
| the by-value match, not aborted | 1 |
| the by-value match over a `ref(struct)` payload | 1 |

## Root cause (not yet located)

A by-value `match` over a move-only scrutinee moves the payload into the binding's slot and
marks the scrutinee moved. On completion the arm's scope end drops the binding. The abort
dispose (`_state_dispose_locals`) sees the scrutinee as moved and skips it, but it does not
drop the binding's slot either, so neither holder releases the value. With a `ref` payload, the
binding was a dup and the scrutinee kept its own count, which the dispose released. That is why
the existing test passed. The fix that last touched this
path (`InlineSmLowering.binding_sources`,
`issues/fixed/async-abort-dispose-double-drops-moved-enum-payload.md`) zeroes the source on a
consuming read of the binding. The binding slot itself also has to be in the dispose set
whenever the binding owns its value.

## Test

`tests/async/sm_ownership.test.yo`'s "an aborted task drops a pattern binding's scrutinee
once" keeps a `ref` payload (`_RefThing`) until this is fixed; its comment names this doc. The
fix switches it to `Option(Thing)` (an `Rc` payload, as the rest of the file), adds the
reproducer's value-struct shape as a second case, and moves this doc to `issues/fixed/`.
