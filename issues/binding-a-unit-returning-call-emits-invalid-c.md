# Binding a `unit`-returning call emits invalid C (`void x = ;`)

**Status: OPEN (found 2026-08-23 while writing async-spawn probes; pre-existing).**

## Symptom

`name := <call returning unit>` type-checks (`yo check` passes) but emits C that
does not compile:

```
error: variable has incomplete type 'void'
 1466 |   void _file____priv_temp_5685 = ;
      |        ^
error: expected expression
 1466 |   void _file____priv_temp_5685 = ;
      |                                  ^
```

Two problems in one line: the declared C type is `void`, and the initializer is
empty (the unit value emits nothing).

## Minimal reproducer (verified failing on develop + PR #234)

```rust
{ println } :: import("std/fmt");
{ String } :: import("std/string");
_noop :: (fn(x : i32) -> unit)(
  ()
);
main :: (fn() -> unit)({
  _r := _noop(i32(1));
  println(String.from("ok"));
});
export(main);
```

`yo check repro.yo` → OK. `yo compile repro.yo --release -o repro` → the two C
errors above.

Note the discard name (`_r`, or `_` / `___`) makes no difference — the binding
is still emitted. Calling the function as a statement (`_noop(i32(1));`) is
correct and compiles.

## Why it is worth fixing

The evaluator accepts a program the backend cannot emit, so the diagnostic
surfaces as a raw C compiler error with a generated temp name and no source
location. It is easy to hit by habit: `_x := f(...)` is the idiomatic way to
discard a result in this codebase (it appears hundreds of times in `src/`), and
it silently only works when `f` returns a non-unit value. Whether a call
returns `unit` is not visible at the call site.

## Fix directions

1. **Codegen (smallest):** when the bound value's resolved type is `unit`, emit
   the initializer expression as a STATEMENT and skip the declaration entirely
   — the same treatment the unit-statement path already applies. The binding has
   no readable value by definition, so nothing downstream can reference it.
   (Guard on the resolved type, not the syntactic one: a `SomeT` that resolves
   to unit must take the same path — compare the `result_is_unit` /
   `resolve_some_type_to_concrete` handling in
   `src/codegen/functions/generation.yo`.)
2. **Evaluator (stricter):** reject `x := <unit>` with a real diagnostic
   ("a unit-valued call has no value to bind; call it as a statement"). This is
   a breaking change for any existing `_x := unit_call()` in the wild — grep
   `src/` and `std/` before choosing it.

(1) is the surgical fix and keeps existing code working.

## Test to add with the fix

A `tests/` case that binds a unit-returning call (plain fn, a method, and one
whose `unit` comes from a resolved `SomeT`) and then runs — currently it fails
to compile, so it is a valid red-first gate.
