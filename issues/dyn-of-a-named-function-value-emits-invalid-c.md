# `dyn(f)` of a named function value emits invalid C

**Severity:** S2 — a valid `Dyn(Fn(...))` built from a `fn(...)` value passes `check` and dies in the C compiler; wrapping it in a closure literal (`dyn(s => f(s))`) works.

**Status:** OPEN
**Found:** 2026-10-10, writing the runtime canary for
`issues/fixed/a-function-argument-is-not-checked-against-a-function-typed-parameter.md`
(`tests/dyn.test.yo`). Pre-existing: the v0.2.56-era compiler at `c9bc66987` emits the same C.

## Repro (`issues/repros/dyn-of-a-named-function-value.yo`)

```rust
{ String } :: import("std/string");
{ println } :: import("std/fmt");
lent :: (fn(imm(s) : String) -> usize)(s.len());
main :: (fn() -> unit)({
  s := String.from("four");
  (h : Dyn(Fn(imm(s) : String) -> usize)) = dyn(lent);
  println(`${h(s)}`);
});
export(main);
```

`yo check` exits 0; `yo compile --optimize 2` fails in clang:

```
error: a parameter list without types is only allowed in a function definition
  } __yo_dyn_box_unknown_fn(imm(s) : String) -> usize;
```

## Analysis (not yet root-caused)

The dyn box type for the payload is named from `type_to_string` of the `fn(...)` type
(`__yo_dyn_box_unknown_` + the printed signature), the same family as
`issues/dyn-of-a-static-method-call-in-a-bare-tail-fn-body-loses-the-payload-type.md`: the box
naming has no C name for a `Func` payload, and the `Fn`-trait vtable path
(`issues/fixed/yo-self-dyn-fn-field.md`) handles only a dyn'd CLOSURE, whose capture struct is the
boxed value. A `fn(...)` value needs either its own box (a code pointer) with a call slot that
forwards to it, or lowering as a capture-less closure.
