# An array or tuple literal whose element holds a runtime field emits invalid C

**Severity:** S2 — a valid program fails to compile: an array or tuple literal whose element is a struct or enum literal with a runtime field (`[P(x : mk(i32(1)), y : i32(2)), …]`, `[.Some(mk(i32(1))), .None]`, `(P(x : mk(i32(1)), y : i32(2)), i32(5))`) emits `/* skip generating value */` inside the C initializer.

**Status:** OPEN. Found 2026-10-20 by the review of `fix/fixed-array-literal-runtime-strings`
(`issues/fixed/2026-10-17-a-fixed-array-literal-of-runtime-strings-emits-invalid-c.md`), which fixed
the same hole one level up: an element that is ITSELF a runtime value. Pre-existing: every shape
below fails identically with the v0.2.66 seed and with that branch's tree binary.

## Reproducers

```yo
{ println } :: import("std/fmt");
P :: struct(x : i32, y : i32);
mk :: (fn(k : i32) -> i32)(k + i32(1));
main :: (fn() -> unit)({
  (ps : [P ; 2]) = [P(x : mk(i32(1)), y : i32(2)), P(x : i32(3), y : i32(4))];
  println(&ps(usize(0)).x);
});
export(main);
```

```text
error: expected expression
  … (__yo_t_…){ .__yo_v_x = /* skip generating value */, .__yo_v_y = 2 } …
```

The same failure, measured 2026-10-20 on macOS with Apple clang:

- an enum payload: `(os : [Option(i32) ; 2]) = [.Some(mk(i32(1))), .None];` renders
  `.__yo_v_Some = { .__yo_v_value = /* skip generating value */ }`;
- a tuple element: `t := (P(x : mk(i32(1)), y : i32(2)), i32(5));`;
- a struct element with a `String` field: `[H(s : String.from("a"), n : i32(1)), …]` for
  `H :: struct(s : String, n : i32)`.

The struct literal alone, `(p : P) = P(x : mk(i32(1)), y : i32(2))`, compiles and runs, so the
failure belongs to the enclosing array or tuple literal.

A `ref(enum)` variant shape, measured 2026-10-22 on Linux with the tree binary of
develop `b0987d86f`: an array literal whose elements are variants of a `ref(enum(...))` built
from runtime values (`[Node.Return(e),]`, `[Node.Borrow(false, x),]`) emits each variant's
constructor call with its arguments dropped (`{ .data = { __yo_new_…_Return() } }`, clang: "too few arguments to
function call"). It surfaced when `tests/origins/model_corpus.test.yo` was migrated off the
deleted `array_list(...)` literal (macro plan B3); that file builds its lists by pushes until
this is fixed.

## Root cause

A struct or enum literal with a runtime field evaluates to a `StructVal` / `EnumVal` SHELL whose
field holds an `UnknownVal`. `evaluate_array_value` (`src/evaluator/values/array.yo`) and the tuple
literal (`src/evaluator/values/tuple.yo`) decide "every element is known at compile time" by looking
only at each element's TOP-LEVEL value: `None` and `Some(UnknownVal)` count as unknown, a shell does
not. The literal therefore carries a compile-time `ArrayVal` / `TupleVal`, and codegen's comptime
short-cut renders each nested hole as `/* skip generating value */`.

## Fix direction

Make both literals ask whether an element value CONTAINS an `UnknownVal` at any depth, not whether
it IS one. `_value_contains_unknown` (`src/evaluator/exprs/begin.yo`) already does this for
`EnumVal` and `StructVal`. Move it to `src/value.yo`, extend it to `TupleVal` and `ArrayVal`
elements, and use it in `values/array.yo` and `values/tuple.yo`. The literal then goes through the
runtime construction path (`generate_anonymous_array` for arrays), which already emits the struct
literal correctly on its own. Gate with an emit diff over the language suite: a nested-hole value
that some emitter renders correctly today would switch to the runtime path.

## Test

The four shapes above, as a local, a struct field and a module-level global, added to
`tests/array.test.yo` (the array shapes) and `tests/basic.test.yo` (the tuple shape). Before the
fix the batch fails in the C compiler with `expected expression`.
