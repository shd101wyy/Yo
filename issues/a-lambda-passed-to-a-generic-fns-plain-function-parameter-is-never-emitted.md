# A lambda passed to a generic function's plain function parameter is never emitted

**Severity:** S2 — a valid program fails at the C compiler: the call passes the lambda's C symbol, but the lambda's definition is never emitted.

**Status: OPEN.** Found 2026-10-01 on develop `6f5dec5db` while probing generic specialization (plans/CODEGEN_MEMORY_REDUCTION.md, Phase 4 Design 1 of the evaluator plan).

## Repro

```rust
{ println } :: import("std/fmt");
twice :: (fn(generic(T : Type), x : T, f : (fn(a : T) -> T)) -> T)(f(f(x)));
main :: (fn() -> unit)({
  println(`${twice(i32(3), (a) -> (a * i32(2)))}`);
});
export(main);
```

```
$ yo compile repro.yo -o repro
repro.c:2214:203: error: use of undeclared identifier 'fn_yo_id_3887902831623505226000000'
yo: error: compile: C compiler failed (exit 1) on repro.c
```

The call site emits the specialization call with `(void*)(fn_yo_id_…)` as the function argument, and no definition or declaration of `fn_yo_id_…` exists in the C.

The same call through a NON-generic function compiles and prints `6`:

```rust
apply :: (fn(x : i32, f : (fn(a : i32) -> i32)) -> i32)(f(x));
// apply(i32(3), (a) -> (a * i32(2)))  → 6
```

`twice("ab", (a) -> `${a}${a}`)` fails the same way.

## Where to look

Not diagnosed yet. The likely place is collection (`src/codegen/functions/collection.yo`), which registers the functions a body reaches. The lambda is reachable only as a runtime ARGUMENT of the call, and the generic path does not seem to register the argument's FuncVal while the non-generic path does.

## Fix

A test in `tests/` passing a lambda to a generic function's `fn(...)`-typed parameter (i32 and str instantiations), which fails before the fix.
