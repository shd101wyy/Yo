# Codegen bug: `__yo_unwind_value` is a fixed 64-byte buffer — `unwind(large_value)` overflows it

## Summary

The generated C uses a **fixed-size 64-byte thread-local buffer** to pass the
value of an algebraic-effect `unwind(v)` from the handler back to the unwind
site:

```c
// src/codegen/functions/generation.ts:1793 (and :1902)
static _Thread_local _Alignas(16) char __yo_unwind_value[64];  // Thread-local buffer for unwind value storage
```

The handler copies the unwind value into it (`src/codegen/exprs/generation.ts:457`):

```c
{ ArgType _unw_val = <argCode>; memcpy(__yo_unwind_value, &_unw_val, sizeof(ArgType)); }
```

and the unwind site copies it back out
(`src/codegen/exprs/other-fn-call.ts:2623` etc.):

```c
memcpy(&_unw_result, __yo_unwind_value, sizeof(callerCType));
```

If `sizeof(ArgType) > 64`, the `memcpy` into the 64-byte buffer **overflows**.
Built with FORTIFY (`__memcpy_chk`), this traps with **SIGTRAP / EXIT 133** (no
error message). Without FORTIFY it would be a silent stack/global buffer
overflow.

## Why it was latent

Every existing `unwind(...)` in std/yo-self/tests unwinds a SMALL value —
typically `()` (unit) or a small scalar — which fits in 64 bytes. So the buffer
was never exceeded in practice.

## How it was discovered

The def-time function-body-evaluation work (`evaluator/calls/function_type.yo`,
flowability) needed a trial-eval helper whose swallowing exception handler did
`unwind(Option(AstExpr).None)`. `Option(AstExpr)` is a large enum (>64 bytes),
so the unwind-value `memcpy` overflowed → EXIT 133 while checking
`std/string/string.yo`. Backtrace:
`__chk_fail_overflow ← __memcpy_chk ← <unwind handler> ← evaluate_match ← _trial_eval_fn_body`.

## Current workaround (committed)

`function_type.yo`'s `_trial_eval_fn_body` unwinds `()` (unit, like the existing
`exprs/test.yo` trial-eval pattern) and returns the evaluated body via an
out-param `ArrayList`, never through the unwind value. This sidesteps the
buffer entirely. No codegen change was made.

## Proper fix (faithful, foundational)

Size `__yo_unwind_value` to fit the **largest** unwind-value type in the program
(not a fixed 64). Options:

1. During codegen, collect the C types of all `unwind(...)` argument expressions
   and emit the buffer as `char __yo_unwind_value[MAX(64, max_unwind_type_size)]`
   (or a `union` of those types).
2. Heap-allocate the unwind value (changes the unwind ABI more broadly).

This is a bug in BOTH `src/codegen/functions/generation.ts` (the TS compiler that
builds `yo-self-bin`) AND its faithful port `yo-self/codegen/functions/generation.yo`
— fix both to keep them 1-to-1. Any program that does `unwind(value_larger_than_64_bytes)`
hits this, so it is worth fixing independently of the flowability work.
