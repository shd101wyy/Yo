# A struct field of type `Option(Box(X))` emits invalid C (`unknown type name`)

**Severity:** S2: a valid program that `check` accepts fails in the C compiler.

**Status: OPEN.** Found 2026-10-14 by the v0.2.62 batch review. **Measured on:** develop a89b8356c and v0.2.61. Any `X` reproduces it (`i32`, `String`, a user struct). A bare local of type `Option(Box(String))`, `.clone()` included, compiles and runs correctly.

## Symptom

```yo
T :: struct(o : Option(Box(i32)), n : i32);
main :: (fn() -> unit)({
  t := T(o : .Some(box(i32(3))), n : i32(7));
});
export(main);
```

- `yo check`: evaluator OK.
- `yo compile --optimize 2`: `error: unknown type name '__yo_t_…'` on the struct's `__yo_v_o` member.

## Cause

The C type collector emits the struct before the typedef of the field's `Option(Box(X))` type. This is the same ordering family as `issues/derive-clone-on-a-recursive-enum-over-an-arraylist-of-self-emits-invalid-c.md`, in a non-recursive shape. It blocks every derived `Clone`, `Hash` or `Eq` on such a struct.

## Fix direction

Make the struct's dependency walk in the type collector visit an `Option` of a `Box` field before the struct itself. Add a cli-case or test that compiles and runs the program above.
