# A borrowing future made inside a `cond`/`if`/`match` arm or a block tail skips the shared-cell check

**Severity:** S1 — the compiler accepted a borrow through an `Rc` that a
suspended future held, and the program read freed memory.

Found by the adversarial review of the §3.13 A2 change (V3 async, borrowing
futures), 2026-10-12.

## Symptom

Decision 38 D (as amended for futures) rejects a place lent to a borrowing
future through an `Rc`/`Arc` deref. The direct operand was rejected:

```yo ignore
n := io.await(peek(&r.*, io), io);   // error[E0909]: ... lives in a shared cell
```

The same call one wrapper deeper was accepted:

```yo ignore
n := io.await(if(true, peek(&r.*, io), peek(&r.*, io)), io);   // accepted
n := io.await({ u := i32(0); peek(&r.*, io) }, io);             // accepted
io.await(cond(true => push(&mut o.*.inner.*.items, io)), io);   // accepted, rc=139
```

With another task replacing the `Rc`'s payload while the future waited,
`p16b_rc_bypass_uaf.yo` printed `-1` (7 was pushed), `p29r_cell_lend_cond_uaf.yo`
died with SIGSEGV, and under Guard Malloc the program segfaulted.

## Root cause

`_check_awaited_future_lends` (`src/evaluator/calls/function.yo`) ran at
`io.await` and read its operand syntactically as one call: it scanned that
call's arguments for `&`/`&mut` markers and a `.` receiver. For a `cond`,
`match` or block operand the arguments are arms or statements, which carry no
marker, so nothing was checked, although the operand's type carried the
borrows.

## Fix

The check moved to the call that makes the future.
`_note_future_producing_call` runs after every call in
`evaluate_function_call` (user code and std alike). When the result is a
future whose type carries borrows, it checks the places that call lent
(`_check_future_call_lends`, the old logic with the call in hand) and records
the call. Where the future then flows (an arm, a block tail) no longer
matters.

`io.await` keeps a belt (`_check_awaited_future`): it walks its operand
through `cond`/`match` arms and block tails, and a leaf that carries borrows
must be a call recorded by the hook or an `io.async` written in place (its
capture list is checked where it is written). Anything else is E0909.

Regression test: `tests/async_await.test.yo`, "a borrowing future made in an
arm or a block tail is checked where it is made".
