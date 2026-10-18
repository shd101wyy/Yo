# An alias sharing its owner's task slot is retained but released once

**Severity:** S2 — an `io.async` body that binds an alias of a local (`sb := s`) and awaits leaked one reference to the value every time the task ran.

**Found:** 2026-10-16, sorting the leak verdicts of `tests/io_async_captured_alias.test.yo` ("canaries: owner and alias both captured; alias declared inside the body", 37 bytes, a `String`). Reproduces on develop `b0c4630d3`.

## Reproducer

```yo
{ yield } :: import("std/async");
{ String } :: import("std/string");
main :: (fn(io : Io) -> unit)({
  f := io.async((io : Io) => {
    s := String.from("hello");
    sb := s;
    io.await(yield(io), io);
    s.len() + sb.len()
  });
  _n := io.await(f, io);
});
export(main);
```

## Root cause

A local that shares an owner's reference-counted value is stored in its owner's slot when the owner is a local of the same body (`sm_storage_id`), so the two names are one storage. The binding still went through the dup chain and stored the slot into itself:

```c
if (sm->var_s != NULL) { __yo_incr_rc(sm->var_s); }   // a second reference
sm->var_s;
sm->var_s = sm->var_s;
...
if (sm->var_s != NULL) { __yo_decr_rc(sm->var_s); }   // s's drop
memset(&sm->var_s, 0, sizeof(sm->var_s));
if (sm->var_s != NULL) { __yo_decr_rc(sm->var_s); }   // sb's drop: the slot is already zero
```

Both names' scope-end drops release the one slot, and the first zeroes it, so the slot is released once and the binding's reference was never dropped.

## Fix

`src/codegen/exprs/init_assignment.yo`: a state-machine binding whose right-hand side renders as the very slot it binds adds no reference, so it emits no dup and no self-assignment.

Test: `tests/async/sm_ownership.test.yo`, "an alias of a local that crosses an await is released with its owner" (a `Drop` counter on a value struct's field; it fails on the build before this fix).
