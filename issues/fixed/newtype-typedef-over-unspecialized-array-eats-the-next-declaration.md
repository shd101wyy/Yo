# A newtype over an UNSPECIALIZED generic array emits a `typedef` that is a comment

**Status: FIXED 2026-09-18.** Repro:
`issues/repros/newtype-typedef-over-unspecialized-array.yo`.

## Symptom

`yo compile` exits **0** and the emitted C carries, in the declarations
section:

```c
typedef // Unknown type: Array(T : (Comptime), U) __yo_t_6010983213113916395; //  : MaybeUninit(Array(T : (Comptime), U)) (newtype - zero-cost abstraction)
```

The type of the `typedef` is a LINE COMMENT, so it swallows the rest of its own
line **and the declaration that follows**. The C compiler then fails pointing at
innocent code far below. Nothing in the Yo-side exit code, `yo check`, or the
test suite sees it — only a C compile does, which is why CI catches this class
in the stage-2 self-emit step and not before
(`.github/workflows/test.yml`, "emitted C has a `// Unknown type:` comment
mid-declaration").

## Root cause (measured)

`get_type_string` (`src/codegen/utils/index.yo`) has no way to signal failure:
a type with no C form is rendered as the string `// Unknown type: <type>`. An
`Array(T, U)` whose length is still the VARIABLE `U` takes that path — the
`length_var.len() == 0` arm is the only one that renders an array.

`generate_struct_declaration` (`src/codegen/types/generation.yo`) then
interpolates that straight into `typedef ${uts} ${c_name};` for the newtype
case, without ever asking whether `uts` is a type.

`MaybeUninit(T)` is exactly such a newtype, so `MaybeUninit(Array(T, U))` in an
unspecialized generic body reaches the emitter.

## Why emitting nothing is correct, not a suppression

An unspecialized type cannot be referenced by any emitted code, and that is
measured rather than assumed: the mangled name occurs **exactly once** in a
138 MB self-emit of `src/main.yo` — in this declaration alone — and once in the
small reproducer. So the declaration is dead output.

The guard is deliberately narrow. Only the unknown-type fallback is
unemittable; an unresolved `SomeT` legitimately renders as `void*` and must
keep its typedef.

## Not a regression from the run-time `fill`

It predates it. The same reproducer through a compiler built from `develop`
emits the identical broken typedef. What the run-time `Array(T, U).fill`
(PR #759) changed is *reach*: it put a `MaybeUninit(Array(T, U))` newtype into
`std/prelude.yo`, so every program — `src/main.yo` included — began emitting
it, and the stage-2 guard started failing. Before that, no prelude or std code
carried the shape in a form that reached codegen unspecialized.

## Verification

| | mid-declaration `// Unknown type:` |
| --- | --- |
| develop's compiler on the repro | 1 |
| fixed compiler on the repro | 0 |

The repro's emitted C compiles with clang and runs, printing `7 7`.
`check ./src` 275/275, `check ./std` 176/176.
