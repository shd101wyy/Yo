# Followup: investigate `isControlFunction` false-positive on async fns with escape-handlers

## Background

Related to `issues/control-fn-called-as-regular-not-registered.md` (fixed in commit `53bece33`).

The fix there is a workaround: when a fn has `isControlFunction=true` but is called as a regular function, we register it + mark `isModuleEffectMember=true`. This keeps semantics correct via the thread-local escape flag.

However, it's unclear why `isControlFunction` becomes `true` for these functions in the first place. The body contains `escape` only **inside** an effect handler lambda:

```rust
do_work :: (fn(n : i32, using(io : IO)) -> i32)({
  given(exn) := Exception(throw : ((err) -> {
    escape i32(-1);    // escape is inside THIS lambda
  }));
  io.await(yield());
  return (n + i32(1));  // no escape here
});
```

`isFunctionBoundaryArrow` in `src/expr-traversal.ts:36` should stop traversal at the handler arrow (case 1: `$.isAnonymousFunctionDefinition === true`, set in `anonymous-function.ts:1174`). So `evaluatedBodyContainsEscape(do_work.body)` should return `false` — yet `isControlFunction` ends up `true`.

## Observations

- **Without `io.await`**: same handler pattern, `do_work` is correctly registered as a regular C function (verified with `/tmp/simple_test2.yo`). No `isControlFunction` false-positive.
- **With `io.await`**: the function becomes an async state machine, and the `isControlFunction` flag is set during SM specialization (`helper.ts:3678`). Something in the SM-specialized body evidently contains `escape` at a location where `isFunctionBoundaryArrow` doesn't cut traversal.

## Hypotheses to investigate

1. **SM specialization may duplicate the handler body inline.** The async SM transformation evaluates the given-binding and may splice the handler body into the outer SM state machine (so each await point's resume code can propagate escape). If the spliced `escape` is no longer enclosed by a `->`/`=>` arrow, `isFunctionBoundaryArrow` can't stop traversal.
2. **`expr.$.isAnonymousFunctionDefinition` may not be set on the cloned body.** `specializeControlFunctionBody` (around `helper.ts:3670`) clones and re-evaluates the body; the clone may drop `$` metadata on nested arrows.
3. **The `given(exn) :=` RHS may be evaluated differently.** If `Exception(throw: ((err) -> ...))` evaluation constructs a ModuleValue whose field is a FunctionValue (not the raw arrow), then the traversal recurses into `Exception` args — but those args are the original AST arrows, which should be marked. Worth verifying.

## How to investigate

1. Add a temporary `console.error` inside `evaluatedBodyContainsEscape` (in `expr-traversal.ts`) that logs the first `escape` atom it encounters and its parent chain.
2. Run the regression test `tests/control_fn_as_regular_call.test.yo` and observe the chain.
3. If `isAnonymousFunctionDefinition` is missing on an intermediate arrow, find which evaluation path produces that arrow and set the flag.

## Why the current workaround is safe

The workaround only changes codegen — it always uses the thread-local `__yo_effect_escaped` flag for escape propagation, which is the correct mechanism for a function called through a named C function pointer. The semantics match the intended behavior of `escape`.

The "proper" fix would be to make `isControlFunction` only `true` when the function is actually installed as a handler via `given` (not when it's called as a regular function), so we can use direct inline SM codegen (slightly less overhead). But this is an optimization, not a correctness issue.
