# Runtime `str + str` passes `check` and fails `compile`

**Severity:** S2: `yo check` accepts a program that `yo compile` cannot build. One form fails in the C compiler on a swallowed definition-time error; the other is an internal compiler error.

**Status: OPEN.** Found 2026-10-03 while re-verifying the syntax cheatsheet (agent-knowledge consolidation K0). **Measured on:** yo 0.2.49, `--std-path ./std`.

## Symptom

A `str` parameter concatenated with a literal:

```rust
{ println } :: import("std/fmt");
f :: (fn(x : str) -> unit)({
  y := (x + "b");
  println(y);
});
main :: (fn() -> unit)({
  f("a");
});
export(main);
```

- `yo check`: evaluator OK.
- `yo compile`: the C compiler rejects the call. The diagnostic attribute reads "the body of yo_id_… failed to transpile — its definition-time evaluation failed and was swallowed (run yo check with YO_DEBUG_SWALLOW=1); this call would abort at runtime".

The same concatenation on a local, `x := "a"; y := (x + "b");` in `main`, is an internal compiler error instead: "Failed to transpile part of main's body — the emitted C for "__yo_user_main" contains an untranspiled expression".

## Expected

There is one verdict in both commands. Either runtime `str + str` lowers to a `String` (the documented working forms are `String.from("a" + "b")` with compile-time literals, `String + String`, templates and `.concat`), or `check` rejects it with a coded diagnostic that names the working forms. `compile` must not be where the program first fails.
