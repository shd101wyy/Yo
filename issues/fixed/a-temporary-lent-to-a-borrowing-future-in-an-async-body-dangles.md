# A temporary lent to a borrowing future inside an awaiting `io.async` body dangles

**Severity:** S1 — the borrowing future wrote and read a dead stack slot of
the resume function (`1`/`2`/garbage where 42 was right).

Found by the adversarial review of the §3.13 A2 change, 2026-10-12.

## Symptom

```yo ignore
outer :: (fn(io : Io) -> Impl(Future(i32, Io)))(
  io.async((io : Io) => {
    io.await(yield(io), io);
    io.await(make().later(io), io)                  // `later` takes `&mut self`, returns a borrowing future
  })
);
inner :: (fn(io : Io) -> Impl(Future(i32, Io)))(
  io.async((io : Io) => io.await(bump_later(&mut make(i32(19)), io), io))
);
```

The same awaits in a synchronous `main` printed 42. Inside the state machine
the C hoisted the temporary (`sm->var_<temp> = <temp>;`) but passed the
address of the resume function's C local (`(&(_file____User_temp_…))`) to
the method, whose future suspended and then dereferenced it.

## Root cause

A temporary in a state-machine body is a C local of the resume function,
mirrored into its task slot for its scope-end drop
(`_store_temp_var_to_state_machine_if_needed`). Lending it by address used
the C local. Before A2 no borrow outlived a suspension, so that was harmless;
a borrowing future holds the address across one. The temporary itself
legitimately lives to the end of the statement (Rust's temporary lifetime),
which contains the await.

## Fix

`_apply_ref_amp` (`src/codegen/exprs/other_fn_call.yo`) lends a temporary
that has a task slot by the slot's address (`_sm_lent_temp_slot`). The slot
holds the same value (stored when the temporary was made), and the
temporary's drop reads the slot, so a write through the borrow is the one the
drop sees. This covers an explicit `&`/`&mut` argument and an auto-referenced
receiver alike.

Regression test: `tests/async_await.test.yo`, "borrowed temporaries and
closure-borrowed locals of an awaiting io.async body live in the task".
