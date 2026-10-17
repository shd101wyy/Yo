# A struct field of type `Option(Box(X))` emits invalid C (`unknown type name`)

**Severity:** S2: a valid program that `check` accepts fails in the C compiler.

**Status: FIXED** by #1411 (2026-10-16). Found 2026-10-14 by the v0.2.62 batch review. **Measured on:** develop a89b8356c and v0.2.61. Any `X` reproduces it (`i32`, `String`, a user struct). A bare local of type `Option(Box(String))`, `.clone()` included, compiles and runs correctly.

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

The C type collector emits the struct before the typedef of the field's `Option(Box(X))` type. This is the same ordering family as `issues/fixed/derive-clone-on-a-recursive-enum-over-an-arraylist-of-self-emits-invalid-c.md`, in a non-recursive shape. It blocks every derived `Clone`, `Hash` or `Eq` on such a struct.

## Re-check on develop 2132f8fb4 (2026-10-16)

The symptom program above (`Option(Box(i32))`) compiled and ran on develop 2132f8fb4 and on the v0.2.63 seed, but only by luck of the type collector's hash order: `Option(Box(String))` still failed (`unknown type name` on `__yo_v_o`), and so did `Option(Box(UBoxPoint))` inside `tests/rc.test.yo`'s batch. The bug was still open; the severity stays S2.

## Resolution

`generate_type_declarations` (`src/codegen/types/generation.yo`) orders struct, enum and tuple definitions with a dependency sort. For a struct field, `_walk_by_value_dep` added no edge for an enum optimized as a nullable pointer, because a pointer payload needs only the forward declaration. But `Option(Box(X))` is emitted as its payload's C type, and `Box(X)` is a newtype, a typedef the struct names by value. With no edge, the struct could be defined before the `Box` typedef.

The enum branch now adds an edge to the payload when the payload of a nullable-pointer enum field is a newtype. A pointer or reference-handle payload still adds none, so a recursive `struct(next : Option(Box(Self)))` gains no cycle: the `Box` typedef needs only the struct's forward declaration.

Regression test: `tests/rc.test.yo`, "unique Box: a struct field of type Option(Box(T)) compiles and reads back" (`String`, struct and `i32` payloads, plus a derived `Clone`). The batch fails to compile on a develop-built compiler without the fix (two `unknown type name` errors) and passes with it.
