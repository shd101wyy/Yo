# A renamed by-value capture of an awaiting `io.async` body reads an undeclared name

**Severity:** S2 — a valid program failed in the C compiler
(`use of undeclared identifier '__yo_v_m'`).

Found by the adversarial review of the §3.13 A2 change, 2026-10-12. The defect
came with A1 (by-value capture lists on `io.async`, commit 7a9b6f373); develop
rejects every `io.async` capture list.

## Symptom

```yo ignore
mk :: (fn(k : i32, io : Io) -> Impl(Future(i32, Io)))(
  io.async({ m : k }(io : Io) => {
    io.await(yield(io), io);
    m
  })
);
```

```text
error: use of undeclared identifier '__yo_v_m'; did you mean '__yo_v_k'?
```

`{ k }` with an await worked, and `{ m : k }` without an await worked (the
synchronous closure path builds the struct from the evaluated entries).

## Root cause

`_build_async_capture_struct_literal` (`src/codegen/exprs/async.yo`), which
builds a state-machine body's capture struct, read a capture list's evaluated
initializers only for borrow entries (A2). A by-value entry fell through to
the name-matching fallback, which reads the variable named like the field:
for `{ m : k }`, a variable `m` that does not exist.

## Fix

A by-value entry whose initializer is not the variable of the field's own
name takes its initializer, through `emit_deferred_dup_or_code` (its +1 rides
the initializer's deferred dup), as the synchronous closure path does. A
same-name entry keeps the existing path.

Regression test: `tests/async_await.test.yo`, "borrowed temporaries and
closure-borrowed locals of an awaiting io.async body live in the task" (the
`_a2_renamed_capture` assertion, with an `i32` and a `String` entry).
