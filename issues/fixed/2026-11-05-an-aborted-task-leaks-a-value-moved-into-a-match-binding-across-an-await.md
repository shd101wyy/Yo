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

## Root cause

The abort dispose (`generate_async_block_state_dispose_function`, `src/codegen/exprs/async.yo`)
drops every cross-boundary local's task slot except the ones recorded in
`state_machine_binding_ids`: the slots a `match` pattern binding was stored into. That rule
dates from bindings that only read the scrutinee's payload, so the scrutinee's own drop released
it. A consuming `match` (`MATCH_MODE_CONSUME`, decision 26) moves the payload into the binding
and marks the scrutinee's slot moved (`__yo_mv_…`), so the dispose skipped both holders. A
borrowing match (`match(&o, …)`) still binds a read of the scrutinee's payload, which is why that
shape dropped once.

## Fix

- `generate_match_expression` records whether the match consumes its scrutinee
  (`FunctionGenerationContext.match_binds_own`), and `note_state_machine_binding_id` records only
  a borrowing match's bindings. A consuming match's binding slot is dropped by the dispose like
  any named local's, under its move flag.
- Every store of a binding into its slot clears the slot's move flag
  (`_clear_binding_move_flag`, `src/codegen/exprs/match.yo`), as a store into any named local's
  slot does: an arm in a loop binds the name again after a move out of the previous value.
- Dropping the binding's slot exposed the same hole for every named local's slot: an abort
  before the slot is stored, or after its scope dropped it, dropped the slot's zeroes, a
  spurious `drop` for a plain `Drop` struct
  (`issues/fixed/2026-11-05-an-aborted-task-drops-a-local-its-scope-already-dropped.md`, fixed
  alongside).

## Test

`tests/async/sm_ownership.test.yo`: "an aborted task drops a pattern binding's scrutinee once"
is on `Option(Thing)` (an `Rc` value payload) again, and "an aborted task drops a plain Drop
payload its match binding holds once, wherever it stops" aborts the reproducer's shape before
the arm, inside it and after it.
