# A block's result lent to a call after an await leaks inside `io.async`

**Severity:** S2. Inside an `io.async` body, a block used as a value and lent to a call after the body's first await, such as `log.push_string({ t := String.from("x;"); t })`, never released its result. Each evaluation leaked the value (a `String` buffer per loop iteration). No wrong result and no crash, but a leak per evaluation in long-running async code. D10's interpolation lowering (`plans/VALUES_BY_DEFAULT.md` D10) makes every template string of two or more parts such a block, which turned this into 7 leak failures in `tests/async_await.test.yo`.

**Status:** FIXED 2026-10-30 (`vbd/b8-d10-interpolation-builder`). **Found:** 2026-10-30, root-causing the D10 branch's async_await leaks. Develop `b7e873958` with the v0.2.72 seed leaks on the reproducer below, so the bug predates D10.

## Reproducer

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
{ yield } :: import("std/async");
_f :: (fn(io : Io) -> Impl(Future(String)))(
  io.async((io2 : Io) => {
    (mut(log) : String) = String.new();
    io2.await(yield(io2), io2);
    log.push_string({ t := String.from("x;"); t });
    log
  })
);
main :: (fn(io : Io) -> unit)({
  got := io.await(_f(io), io);
  println(`got ${got}`);
});
export(main);
```

`yo compile repro.yo --sanitize address --allocator system` and run: LeakSanitizer reports one 32-byte `String` allocation per evaluation. Without the await, or with the block bound to a local first (`tt := {...}; log.push_string(&tt)`), nothing leaks.

## Root cause

A block used as a value writes its result into a C-local temp (`generate_begin`, `src/codegen/exprs/begin.yo`). In an `io.async` state machine the temp also has a task slot, and its scope-end drop reads the slot. A call-result temp is stored into its slot when it is made (`_store_temp_var_to_state_machine_if_needed`), and a `cond` or `match` result temp got the same step through `_store_result_temp_in_task` (`issues/fixed/a-match-or-cond-condition-inside-io-async-takes-the-wrong-branch-when-the-branch-awaits.md`). A block's result temp did not: the drop released the zeroed slot and the C local was never released.

## Fix

`generate_expr` routes a value block through `_store_result_temp_in_task` too (`src/codegen/exprs/generation.yo`), so the block's result is stored in its slot and the scope-end drop releases it.

## Test

`tests/async_await.test.yo`: "a block's result lent to a call after an await is released". It fails with `Memory leak detected` before the fix.
