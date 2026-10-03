# A definition inside `comptime_expect_error` is emitted as a live abort stub

**Severity:** S3 — no wrong output (codegen never emits the `comptime_expect_error` argument, so nothing called the stub), but every such definition in a test body produced a live "failed to transpile" stub. Those stubs were the only thing keeping Phase 6 step 4 (a live stub is a compile error) from landing.

**Status:** FIXED on `tss/phase6-step4` (2026-10-03), together with Phase 6 step 4. Regression:
`tests/type_soundness.test.yo`, "soundness: a definition inside comptime_expect_error is not
emitted".

## Symptom (measured, develop after #1124)

```rust
test("defs inside comptime_expect_error", {
  comptime_expect_error({
    bad :: (fn(x : i32) -> i32)(x + "s");
    ()
  });
  comptime_expect_error(begin(g := (fn(x : i32) -> i32)(x + true), ()));
});
```

`YO_DEBUG_SWALLOW=1 yo test` prints `[ftt-stub] kind=value fn=yo_id_… site=…:7:98 spec=false
recorded=false` for each definition, so both are emitted as value-returning abort stubs that are
not superseded. The same shape at module level emits nothing. #1124's census of the fast suite
found 14 live stubs, and all 14 were this.

## Cause

`comptime_expect_error` evaluates its argument to see that it throws, and codegen skips the
argument (`find_function_calls_in_expr`, and the expression emitter returns `""`). A function
literal evaluated inside the argument still registers a function value, though, and the function
collector emits every registered function. Its body is the invalid code the test expects to be
rejected, so it becomes a stub.

## Fix

`comptime_expect_error` records each argument it evaluates as a source span: its module path
and the first and last token offset in the subtree (`record_cee_argument_span`,
`src/function_value.yo`). `should_skip_function_codegen` skips any function whose body starts
inside a recorded span, which covers every path that registers a function value. A first cut
keyed the check by AST node id and marked the function at one registration site. It missed a
function whose body is a CLONE with fresh node ids: `tests/algebraic_effects.test.yo`'s
`comptime_expect_error((fn() -> …)(begin(handler := (msg -> …), return(handler)))())` became a
live stub, and step 4 failed the batch. Clones share their tokens, so the span check catches
them. A specialization of a std generic minted while the argument is evaluated carries std
tokens and is unaffected.
