# A fixed-array literal of runtime `String`s emits invalid C

**Severity:** S2 — a valid program fails to compile: `[String.from("a"), String.from("b")]` as a `[String ; 2]` emits `/* skip generating value */` inside a C initializer.

**Status:** fixed 2026-10-20 (branch `fix/fixed-array-literal-runtime-strings`). Found 2026-10-17 while writing `tests/shared_borrow_write.test.yo`
(`issues/fixed/a-field-write-through-a-shared-borrow-parameter-is-accepted-and-lost.md`).

## Reproducer

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  (ss : [String ; 2]) = [String.from("a"), String.from("b")];
  println(&ss(usize(1)));
});
export(main);
```

`yo check` accepts it; `yo compile` on develop at `1a4cf8df6` fails in clang:

```
error: expected expression
  Array___yo_t_..._2 __yo_v_ss = (Array___yo_t_..._2){ .data = { /* skip generating value */, /* skip generating value */ } };
```

The same happens when the literal is a struct field's value
(`Q(ss : [String.from("a"), String.from("b")])` for `Q :: struct(ss : [String ; 2])`).

## Root cause (suspected)

`evaluate_array_value` (`src/evaluator/values/array.yo`) builds a compile-time
`ArrayVal` when every element has `Some(value)`, and a runtime element's value
is `Some(UnknownVal)`, which it counts as known. Codegen's comptime short-cut
(`src/codegen/exprs/generation.yo`) then renders the `ArrayVal`, and each
`UnknownVal` element becomes `/* skip generating value */`. The tuple literal
had the same hole and treats `Some(UnknownVal)` as unknown
(`src/evaluator/values/tuple.yo`); the array literal does not.

## Fix direction

Count a `Some(UnknownVal)` element as unknown in `evaluate_array_value`, as the
tuple literal does, so the literal goes through `generate_anonymous_array`
with its runtime element expressions; add the reproducer above as a test.

## Fix (2026-10-20)

Confirmed the suspected root cause: `evaluate_array_value` now counts a
`Some(UnknownVal)` element as unknown, exactly as the tuple literal does, so a
literal with any runtime element carries no `ArrayVal` and codegen emits it
through `generate_anonymous_array` from its runtime element expressions. A
runtime `i32` element was never affected (its value is `None`); the hole was
specific to elements whose evaluation records a typed unknown, such as a
`String.from(...)` call.

Regression test: `tests/array.test.yo`, "A fixed-array literal of runtime
Strings builds its elements at run time" (the local binding and the struct
field cases); before the fix its batch fails in the C compiler with
`expected expression` at both initializers.
