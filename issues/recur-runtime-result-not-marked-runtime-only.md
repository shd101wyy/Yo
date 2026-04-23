# `recur(...)` result not marked `isRuntimeOnly`, breaks runtime overload resolution

## Summary

When the function body being evaluated is a **runtime function** (its return
type is not wrapped in `comptime(...)`), the placeholder `UnknownValue`
synthesized for `recur(...)` during CTFE-capability analysis is **not**
marked `isRuntimeOnly`.

That breaks overload resolution for the `Call :: (runtime_fn, comptime_fn)`
tuple pattern used by `!`, `>`, `+`, etc. in the prelude. The dispatch
sees an `UnknownValue` arg and incorrectly accepts the comptime overload
(e.g. `comptime_not`), which has a `comptime(self) : _Self` parameter. The
codegen then emits a 0-arg call to the comptime helper:

```c
bool _yo_temp_NNNN = fn_yo1c2129e9_id_2543_comptime_not();   // ← 0 args
```

`clang` rejects it as a call to an undeclared function (the comptime helper
isn't declared because no instantiation was actually requested at runtime).

## Minimal reproduction

`tmp/repro_not_recur.yo`:

```rust
open import "std/string";
open import "std/fmt";

E :: enum(A, B(inner : Box(Self)));

eq :: (fn(a : E, b : E) -> bool)(
  match(a,
    .A => match(b, .A => true, .B(_) => false),
    .B(ai) => match(b,
      .A => false,
      .B(bi) => {
        if(!(recur(ai.*, bi.*)), { return false; });
        true
      }
    )
  )
);

main :: (fn() -> unit)({
  x := E.B(box(E.A));
  y := E.B(box(E.A));
  println(eq(x, y).to_string());
});

export main;
```

```
./yo-cli compile tmp/repro_not_recur.yo --release -o /tmp/repro_not
```

Before fix:

```
error: call to undeclared function 'fn_yo1c2129e9_id_2543_comptime_not';
```

After fix: prints `true`.

## Fix

In `src/evaluator/exprs/recur.ts`, mark the synthesized `UnknownValue` as
`isRuntimeOnly: true` whenever the recurred function's return type is not
`isCompileTimeOnly`. This allows `hasRuntimeUnknownArg` in
`src/evaluator/calls/function.ts` to correctly exclude comptime function
candidates from overload resolution.

```ts
const recurUnknown = createUnknownValue(returnType, { ... });
if (
  !isEvaluatingFunctionBodyOfType.return.isCompileTimeOnly &&
  isUnknownValue(recurUnknown)
) {
  recurUnknown.isRuntimeOnly = true;
}
```

## Status

Fixed.
