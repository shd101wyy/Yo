# A destructuring inside an `io.async` body binds C locals its reads never see

**Severity:** S1 — silent wrong values: names bound by a destructuring (`(n, from) := got`, `{ a, b } := s`) inside a task read garbage

**Status: FIXED (2026-09-30).** Found by CI on #1002, the phase 5 PR of `plans/ASYNC_STATE_MACHINE_GENERATION.md`: `tests/net/udp.test.yo` "a quiet recv_from parks the task, not the event loop" read `n == 0`, and its sender address was not loopback. The v0.2.46 seed passes it: this was a regression of the single-pass lowering.

## Symptom

```rust
got := io.await(server.recv_from(buf, usize(64), io), e);
(n, from) := got;              // n == 0, from is garbage
```

The emitted C declared locals and then read the task's slots, which nothing wrote:

```c
size_t n = sm->var_got_…._0; // Destructuring 0
...  &(sm->var_n_…)  ...     // the read
```

## Root cause

Under the single-pass lowering every captured local lives in a task slot, and its reads render `sm->var_<id>`. A plain `x := v` declaration in a state machine is written to the slot. The destructuring emitter (`_emit_destructurings`, `src/codegen/exprs/init_assignment.yo`) still declared a C local for each name.

## Fix

One helper, `_sm_binding_slot`, now picks a binding's slot for both the plain declaration and each destructured name. Regression test: `tests/async_await.test.yo` "a destructuring of an await result inside a task binds its slots". It fails on the branch before the fix.
