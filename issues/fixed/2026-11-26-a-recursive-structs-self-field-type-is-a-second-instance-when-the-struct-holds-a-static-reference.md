# A recursive struct's `Self` field type is a second instance when the struct holds a static reference

**Severity:** S1 — accepted code emits invalid C: a recursive struct or enum with a `str` (static
reference) field and an `Option(ArrayList(Self))` field compiles through the evaluator and then
fails in the C compiler. A v0.2.80 regression (v0.2.79 compiles it); it breaks `yo build` of the
README example markdown-it-yo.

Filed and fixed 2026-11-26 (lane fix-0280-examples), from the v0.2.80 README-projects sweep.

## Repro

```yo
{ println } :: import("std/fmt");
{ ArrayList } :: import("std/collections/array-list");
Token :: struct(
  tag : str,
  children : Option(ArrayList(Self))
);
derive(Token, Clone);
main :: (fn() -> unit)({
  t := Token(tag : "p", children : .None);
  u := t.clone();
  println(u.tag);
});
export(main);
```

`yo compile` (v0.2.80):

```text
a.c:2387:45: error: assigning to '__yo_t_5119282572397184270' (aka 'struct __yo_t_5119282572397184270_struct') from incompatible type '__yo_t_17351025546191227582' (aka 'struct __yo_t_17351025546191227582_struct')
a.c:2396:45: error: assigning to '__yo_t_5119282572397184270' (aka 'struct __yo_t_5119282572397184270_struct') from incompatible type '__yo_t_17351025546191227582' (aka 'struct __yo_t_17351025546191227582_struct')
yo: error: compile: C compiler failed (exit 1) on a.c
```

Both C types are `Option(ArrayList(<struct:…Token…>))`: the derived `Option.clone` is typed by
one instance and builds its `.None`/`.Some` in the other. markdown-it-yo's `Token`
(`src/token.yo`) has the same shape and fails the same way in `__yo_fs_…` (gcc: "incompatible types
when assigning to type …"). The same happens without `derive` (a local typed
`Option(ArrayList(Token))` stored into the field) and for a recursive enum
(`Branch(tag : str, kids : Option(ArrayList(Self)))`). With an `i32` in place of the `str` field,
everything compiles.

## Root cause

P12 (#2082, VERDICTS-74 rule 1) made the static bit of a type's origins part of its instance
identity: `_ctfe_args_equal` (evaluator/calls/comptime-fn.yo) refuses a CTFE memo hit when
`static_origin_marks_differ` says the cached and the given type arguments differ in it. The marks
walk (`_static_origin_marks`, types/utils.yo) descends into a struct's fields and an enum's
payloads.

Inside a recursive declaration, `Self` is the fieldless shell that shares the final struct's id (an
enum's is the variantless `__self_shell`). `Option(ArrayList(Self))` is instantiated over that
shell, whose empty field list marks as nothing; `Option(ArrayList(Token))` after the declaration
is asked with the final, whose `tag : str` field marks `s`. The marks differ, so the memo misses
and mints a second `Option` instance, although the next check in `_ctfe_args_equal` (same id ⇒
same type, written for exactly this shell/final pair) would have hit. Two instances become two C
types.

## Fix

`_static_origin_marks` reads a shell as its final (`resolve_enum_shell(resolve_struct_shell(…))`,
the pattern every other field-reading walk in types/utils.yo uses). Shell and final now mark the
same, the memo hits, and the field type and the later spelling are one instance.

## Verification

- `tests/recursive-type-with-a-static-reference.test.yo` (struct with `derive(Clone)`, a value
  typed after the declaration stored into the `Self` field, a recursive enum): fails on v0.2.80 in
  the C compiler, passes on the fixed tree.
- markdown-it-yo `yo build` with the tree binary and the tree std: green.
