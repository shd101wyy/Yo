# Type errors inside a closure body are swallowed at `check` and become a runtime FATAL

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 1).
**Status:** OPEN. Green `yo check`, green `yo compile`, the binary aborts.
**Measured:** yo 0.2.39 seed; re-verified with the same result on a develop build `d455b6a67`.

## Repro 1: a closure body that does not type-check

```rust
{ println } :: import("std/fmt");
apply :: (fn(f : Impl(Fn(x : i32) -> i32), v : i32) -> i32)(f(v));
main :: (fn() -> unit)({
  k := i64(10);
  r := apply(x => (x + k), i32(3));
  println(`${r}`);
});
export(main);
```

`check` rc=0, `compile` rc=0, run:

```
yo: FATAL: reached closure_yo_id_…, whose body failed to transpile - its definition-time evaluation failed and was swallowed
```

`YO_DEBUG_SWALLOW=1 yo check` shows the evaluator found it:
`[anon-swallow] error[E0601]: Cannot unify incompatible types: "i32" and "i64"`.

## Repro 2: a `ctl` handler resuming with the wrong type

```rust
{ println } :: import("std/fmt");
{ String } :: import("std/string");
Raise :: (ctl(msg : String) -> i32);
safe_divide :: (fn(x : i32, y : i32, raise : Raise) -> i32)(
  cond((y == i32(0)) => raise(`div-by-zero`), true => (x / y))
);
main :: (fn() -> unit)({
  (raise : Raise) = ((msg) -> { return(`not an i32`); });
  r := safe_divide(i32(1), i32(0), raise);
  println(`r=${r}`);
});
export(main);
```

Same outcome: `check` and `compile` green, runtime FATAL; the swallow trace shows
`error[E0601]: Cannot unify incompatible types: "String" and "i32"`. The `unwind(...)` variant of
this shape is being fixed separately on the peer branch `yo-context-c7`
(`issues/fixed/unwind-type-mismatch-in-a-handler-is-swallowed.md` there). That fix covers only
`unwind`, not `return(...)` and not ordinary closure bodies.

## Mechanism (READ)

- `_trial_eval_anon_body` (`src/evaluator/values/anonymous_function.yo` ~394) runs the body under
  a swallowing exception. Only three channels re-raise (forward-ref unbound name, flow violation,
  `propagate_def_time_errors`, ~1530-1572).
- The named-fn path re-raises through `g_trial_swallow_msg` (`src/evaluator/calls/function_type.yo`
  ~191-232); the closure path has no equivalent.
- Codegen makes an FTT stub fatal only inside `__yo_user_main`
  (`src/codegen/functions/generation.yo` ~838), so a hollow closure body survives `yo compile`.

## Fix direction

When every parameter type of the closure is concrete (no SomeT left), there is no later
specialization that could make the body type-check, so re-raise the swallowed error the way the
named-fn path does. Separately, make any reachable FTT stub a compile error, not only those in
`main`.

## Related

`issues/anonymous-module-trial-swallows-a-top-level-derive.md`,
`issues/mutual-recursion-between-a-fn-and-a-trait-impl-body.md`,
`issues/swallowed-closure-spec-emits-wrong-typed-return-msvc-error.md` (same swallow policy,
other entry points).
