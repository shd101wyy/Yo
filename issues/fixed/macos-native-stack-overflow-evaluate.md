# macOS native stack overflow in `evaluate()` — SIGSEGV in "recur simple countdown"

## Status: FIXED (commit: stack_size linker flag)

## Symptom

The "evaluate: recur simple countdown" test in `yo-self/tests/eval_basics.test.yo`
crashed with SIGSEGV on macOS ARM64 when run with `--disable-sanitize`. The binary
ran for ~160 ms before crashing (not AMFI/launched-suspended which kills in <3 ms).

```
✗ evaluate: recur simple countdown (3178ms)
  Test failed with signal=SIGSEGV, exit code null
```

(Signal was visible after also adding `signal=${runResult.signal}` to the error message
in `src/test-runner.ts`.)

## Root cause

The `evaluate()` function in `yo-self/evaluator/eval.yo` compiles to a ~9900-line C
function with **~2482 local variables** (many `EvalValue` and `TypeValue` large tagged
unions). At `-O0` (no optimisation, no stack-frame reuse), each C-stack frame for
`evaluate()` occupies **~1.5 MB**.

The "recur simple countdown" test evaluates `count(1)` where `count` is a recursive
function. The maximum simultaneous C-stack depth for this call is:

```
evaluate[outer]
  └─ call_funcval_with_args[A]
       └─ evaluate[B]  (executes fn body, hits recur branch)
            └─ evaluate[F]  (recur handler, calls call_funcval_with_args again)
                 └─ call_funcval_with_args[B_]
                      └─ evaluate[H]  (evaluates fn body with n=0)
```

That is **5 simultaneous `evaluate` frames × 1.5 MB = 7.5 MB**, plus
`call_funcval_with_args` and `main` overhead, which exceeds macOS's default **8 MB**
thread stack limit.

Note: "recur factorial(1)" did not crash because factorial hits the base case `n<=1`
immediately without making a recursive call, so only ~2 `evaluate` frames are stacked.

### Why the ASAN measurements differed

The ASAN documentation (`issues/asan-eval-frame-size-after-expr-id.md`) reported ~566 KB
per frame with ASAN enabled. This is because ASAN uses a "fake stack" (a separate heap
region) for many local variables, which dramatically reduces the _real_ C-stack usage per
frame. Without ASAN (`--disable-sanitize`) all locals live on the real C stack, giving the
1.5 MB figure.

## Fix

Added macOS-specific linker flag to `src/test-runner.ts` (after the existing Windows
`/STACK:16777216` block):

```typescript
if (!isWindows && !isEmcc && process.platform === "darwin") {
  // Increase the stack reserve to 32 MB on macOS.  The default 8 MB is
  // insufficient for large yo-self tests: the `evaluate` function in
  // yo-self/evaluator/eval.yo has ~2482 local variables that consume
  // ~1.5 MB of stack space per frame (at -O0, no stack-frame reuse).
  // The recursive call chain for count(1) stacks 5 evaluate frames
  // (5 × 1.5 MB = 7.5 MB), which hits the 8 MB limit.  32 MB provides
  // headroom for deeper recursion and future growth.
  // macOS linker flag: -Wl,-stack_size,<hex-bytes> (0x2000000 = 32 MB).
  compileArgs.splice(-2, 0, "-Wl,-stack_size,0x2000000");
}
```

After the fix, all 123 tests in `eval_basics.test.yo` pass with `--disable-sanitize`.

## Verification

```bash
./yo-cli test yo-self/tests/eval_basics.test.yo --parallel 1 --disable-sanitize
# 123 passed, 123 total
```

## Notes

- `ulimit -s unlimited` is not available on macOS (returns "cannot modify limit: Operation
  not permitted"), so the linker flag is the only reliable fix.
- The macOS flag format is `-Wl,-stack_size,0x2000000` (hex bytes), **not**
  `-Wl,-stack_size,33554432` (decimal), which the macOS `ld` linker rejects with
  "ld: -stack_size must be <= 512MB" (despite 32 MB being well within 512 MB — the
  linker only accepts hex for this flag).
- The `evaluate()` function frame size grew because of Phase 3a (ExprId added to `AstExpr`)
  and Phase 2az (TraitT extended with new fields). Future reductions to frame size would
  allow lowering the stack reserve.
