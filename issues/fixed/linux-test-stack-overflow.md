# Linux test stack overflow — ASAN + evaluate() recursion exceeds default 8 MB RLIMIT_STACK

## Status: FIXED (commit: setrlimit constructor in test-runner.ts)

## Symptom

58 of 113 tests in `yo-self/tests/eval_5a.test.yo` fail with ASAN stack-overflow
or SIGSEGV (without ASAN) when run on Linux:

```
✗ Phase 5ag: ArrayVal.map doubles each element
  Test failed with exit code 1 signal=null

AddressSanitizer:DEADLYSIGNAL
==<pid>==ERROR: AddressSanitizer: stack-overflow on address 0x7ffe...
```

Tests that pass in isolation fail when compiled together in a batch binary, because
the larger binary's `evaluate()` function has more code paths and slightly larger
stack frames.

## Root cause

The `evaluate()` function in `yo-self/evaluator/eval.yo` has ~2482 local variables
that consume ~1.5 MB of C stack space per frame at -O0 (no ASAN). With ASAN enabled,
each frame consumes ~2.5 MB due to redzones around every local variable.

Tests that evaluate nested expressions through the proto-evaluator (e.g. `filter`
with a multi-operator closure body like `(x % 2) == 0`) require 3+ simultaneous
`evaluate()` frames:

```
evaluate[FnCall(==)]
  └─ evaluate[FnCall(%)]      (evaluates LHS of ==)
       └─ evaluate[Atom(x)]   (evaluates operand of %)
```

That is **3 evaluate frames × ~2.5 MB = ~7.5 MB**, plus `call_funcval_with_args`,
`handle_method_dispatch`, and `main` overhead, which exceeds Linux's default **8 MB**
(`ulimit -s 8192`) thread stack limit.

## Why macOS and Windows don't have this issue

- **macOS**: `src/test-runner.ts` uses the linker flag `-Wl,-stack_size,0x10000000`
  (256 MB). macOS `ld` respects the stack size hint in the Mach-O header.
- **Windows**: `src/test-runner.ts` uses the linker flag `-Wl,/STACK:16777216`
  (16 MB). The PE header `SizeOfStackReserve` is respected by the Windows loader.

## Why the Linux linker flag (-Wl,-z,stack-size=) doesn't help

Linux's `PT_GNU_STACK` header with `p_memsz` is **ignored** by the kernel when
`RLIMIT_STACK` is set to a lower value. The `ulimit -s` soft limit always takes
precedence. Since most Linux distributions set `ulimit -s 8192` (8 MB) by default,
the linker flag has no effect.

## Fix

Add a `__attribute__((constructor))` function to the generated test C code on Linux
that calls `setrlimit(RLIMIT_STACK, ...)` at startup. This increases the stack limit
to 64 MB before any test code runs.

The fix is in `src/test-runner.ts`, in `compileBatchedBinary()`, prepending the
`setrlimit` call to the generated C code after Yo→C compilation but before C→binary
compilation.

## Verification

```bash
# Run the full eval_5a test suite
./yo-cli test ./yo-self/tests/eval_5a.test.yo --parallel 1
```

## Notes

- The macOS fix used a linker flag because `ulimit -s unlimited` is not available
  on macOS (returns "cannot modify limit: Operation not permitted").
- The Linux fix uses `setrlimit` because the linker flag is ineffective on Linux.
- `setrlimit(RLIMIT_STACK, ...)` can only INCREASE the limit up to the hard limit
  (`RLIM_INFINITY` on most systems), and only lower the soft limit.
- The 64 MB value balances headroom for deep recursion against memory pressure on
  systems with limited RAM.
