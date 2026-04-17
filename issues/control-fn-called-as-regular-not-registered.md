# Control function called as regular function not registered for codegen

## Status

**Fully fixed** by commit `16a152f8` (root-cause fix in `src/expr-traversal.ts`). See `issues/iscontrolfunction-false-positive-with-escape-handler.md` for the root cause analysis.

An earlier commit `53bece33` added a codegen workaround in `collection.ts`, but that has been reverted now that the root cause is fixed.

## Symptom

When a top-level `fn` installs a local effect handler that can `escape` (e.g. `given(exn) := Exception(throw: ((err) -> { escape x; }))`) and is **called from multiple call sites as a regular function** (not as an installed handler), codegen fails with:

```
Yo compilation error: Unhandled function call: do_work(i32(10), using(io))
```

## Repro

See `tests/control_fn_as_regular_call.test.yo`. Minimal form:

```rust
{ Exception } :: import "std/error";
{ yield } :: import "std/async";

do_work :: (fn(n : i32, using(io : IO)) -> i32)({
  given(exn) := Exception(throw : ((err) -> {
    escape i32(-1);
  }));
  io.await(yield());
  return (n + i32(1));
});

test "call from multiple sites", {
  a := do_work(i32(1), using(io));  // OK — only site, inlined SM
  b := do_work(i32(2), using(io));  // FAILS — "Unhandled function call"
  assert(a == i32(2));
  assert(b == i32(3));
};
```

The bug also triggered the `yo_http_benchmark` multi-threaded server
(`main_mt.yo`), where `run_server` (a control fn) was invoked once on the
main thread and additionally from each `Worker.spawn((using(io)) => run_server(using(io)))`
closure.

## Root cause

`collection.ts` marks any function whose evaluated body contains `escape` as `isControlFunction=true`. In the **call path** (`expr.kind === ExprKind.Call`), when `isControlFunction` was true, the code previously only recursed into the body expression to inline via state machine and did **not** register the function in `context.functions`. Subsequent call sites therefore had no named C function to dispatch to — `generateExpr` for the `Call` expression threw `Unhandled function call`.

A parallel code path (`functionValue` path, `collection.ts` ~line 556) correctly handles this case by both registering the function AND marking `isModuleEffectMember=true` so that `generateEscape` uses the thread-local `__yo_effect_escaped` flag instead of an inline SM abort.

## Fix

In the call-path branch of `collection.ts`, when `functionValue.isControlFunction` is true, also:

1. Register the function in `context.functions` (standard path).
2. Set `isModuleEffectMember = true` on the registered entry so `generateEscape` uses the thread-local escape flag at `escape` sites.
3. Continue recursing into the body and arguments (unchanged).

Also defaults `runtimeArgExprs` to `[]` in `other-fn-call.ts` for resilience when the evaluator hasn't attached the runtime-arg-order metadata (happens for some specialized control fns).

## Why `isControlFunction` is true here

`evaluatedBodyContainsEscape` traverses the function body and sees the `escape` inside the `((err) -> { escape x; })` handler lambda. Ideally `isFunctionBoundaryArrow` in `src/expr-traversal.ts` would cut off traversal at the handler lambda boundary, but the handler arrow's `isAnonymousFunctionDefinition` flag isn't set when the arrow is the value of a module field (`throw: ((err) -> ...)`), so traversal continues into it.

A **more thorough fix** would be to mark those handler arrows as anonymous function definitions during evaluation so `evaluatedBodyContainsEscape` correctly treats them as closed. The current fix is a localized workaround that keeps the semantics correct (thread-local escape flag) for the few call sites that hit this path.

## Related files

- `src/codegen/functions/collection.ts` — fix location.
- `src/codegen/exprs/other-fn-call.ts` — defensive default.
- `src/expr-traversal.ts` — `isFunctionBoundaryArrow` (deeper fix candidate).
- `tests/control_fn_as_regular_call.test.yo` — regression test.
