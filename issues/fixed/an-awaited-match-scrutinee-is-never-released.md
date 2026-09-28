# An awaited `match` scrutinee is never released

**Status: FIXED 2026-09-28** (`src/codegen/exprs/async.yo`,
`src/codegen/exprs/match.yo`). Found while gating the async batch: the new
"await as the scrutinee of a bound match on a handle Option" test leaked
under LeakSanitizer. Pre-existing: develop at `b097fb448` leaks the same way
in the statement form.

## Reproduction

```rust
future_opt_bytes :: (fn(n : usize, io : Io) -> Impl(Future(Option(ArrayList(u8)), Io)))({
  count := Box(usize)(n);
  io.async((io : Io) => {
    io.await(yield(io), io);
    b := ArrayList(u8).new();
    b.push(u8(7));
    return(Option(ArrayList(u8)).Some(b));
  })
});
main :: (fn(io : Io) -> unit)({
  task := io.async((io : Io) => {
    (n : usize) = usize(0);
    match(
      io.await(future_opt_bytes(usize(3), io), io),
      .Some(bytes) => { n = bytes.len(); },
      .None => { n = usize(99); }
    );
    return(n);
  });
  _r := io.await(task, io);
});
export(main);
```

`--sanitize address`: `Direct leak of 32 byte(s)` (the `ArrayList(u8)`) plus
its buffer. The same `match` over a synchronous call does not leak, and
neither does the same code outside a state machine.

## Root cause: two gaps, both needed

The await is hoisted into the previous state
(`hoist_non_splittable_awaits`). The `match` itself is then an ordinary
statement of the next segment, emitted by the synchronous `match`
generator (`codegen/exprs/match.yo`), which materializes the subject into
its temp: `T tmp = sm->await_result_0;`. The evaluator schedules that
temp's scope-end drop on the body, so the temp is live into the cleanup
segment and has an `sm->var_<id>` field.

1. **The value never reached the field.** The synchronous generator did
   not call `_store_temp_var_to_state_machine_if_needed` after
   materializing the subject. The completion state's drop reads the field,
   which is calloc zero. This is gap 1 of
   `async-match-scrutinee-deferred-drops-hit-zeroed-slot.md`: the TypeScript
   fix stored the value in BOTH match paths, but the Yo port added the store
   only to `generate_match_with_await`.
2. **The drop was not emitted at all.** The resume function is its own C
   function, but it was generated with the enclosing function's
   `declared_c_var_names` / `declared_scopes`, and the emitter's `scope_ref`
   did not track its lines into the stack the drop gate reads.
   `_keep_pending_drop` requires the target's C name on the open block-scope
   stack, so it rejected the temp ("not in scope"). Each gap alone still
   leaks; measured with a build carrying only the store.

## Fix

- `generate_async_block_resume_function`'s caller gives the resume function
  a fresh declared-name set and block-scope stack, seeded with its `sm`
  parameter, and points the emitter at them for the duration. This is the
  same setup `generate_function` does for a body.
- The synchronous `match` generator stores a materialized subject temp into
  its state-machine field, as `other_fn_call.yo` does for call temps.

## Tests

In `tests/async_await.test.yo`, with a Dispose counter on the awaited
payload:
- "Test an awaited match scrutinee is released (statement form)";
- "Test an awaited match scrutinee is released (bound form)".

Both fail on the unfixed compiler (exit 6, zero disposals, with the leak
verdict off) and pass with the fix.

## Related

A state-machine local bound from a `match` arm's moved payload was released
only on the escape path. It is fixed in the same change:
`issues/fixed/a-state-machine-binding-from-a-match-arm-payload-is-released-only-on-escape.md`.
