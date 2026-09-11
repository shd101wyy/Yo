# `i = e.io.await(...)` in an async while body stores no future — the resume reads a NULL slot (SIGSEGV)

**Status:** FIXED 2026-09-11 (`fix/async-nested-match-dead-arm`).
**Found:** 2026-09-11, probing loop shapes for the nested-dispatch fix.
Reproduces on the pre-fix compiler with a plain `while` in an `io.async`
body — no nesting involved.
**Severity:** high — the program crashes (rc=139); `check` is clean.

## Reproducer

`issues/repros/async-while-body-reassigning-an-await-result-never-stores-the-future.yo`:

```rust
(i : usize) = usize(0);
while(runtime(i < usize(3)), {
  i = e.io.await(step(i, e.io), e);   // `=`, not `:=`
});
i
```

## Root cause

`generate_while_body_with_await` (`src/codegen/async/state_code_gen.yo`)
recognised the body's await only as `x := io.await(...)` or a bare
`io.await(...)`. The re-assignment form `x = io.await(...)` matched neither, so
the loop body emitted nothing for it: `sm->await_future_N` was never stored,
while the resume state (whose target comes from `extract_target_variable_id`,
which does accept `=`) dereferenced the NULL slot. The cond-arm and
remaining-code emitters had already grown the `=` arm
(issues/fixed/async-cond-dispatch-skips-chained-sibling-arm.md); the while body
had not.

## Fix

The while-body store accepts `=` with two arguments alongside `:=`.

**Gate:** `tests/async_await.test.yo` — "a while body that re-assigns an
outer local from an await stores the future".
