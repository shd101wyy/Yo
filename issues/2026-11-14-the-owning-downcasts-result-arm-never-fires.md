# The owning downcast's `Result` arm never fires (it fell through to the Option tail)

**Severity:** S1 (blocks the flip's owning-downcast rows — VERDICTS-61 A: the
owned `downcast` on a `Box(Dyn)` is `Result(Box(V), Box(Dyn))`; every such row
of `tests/dyn_pointer_kinds.test.yo` and `tests/dyn.test.yo` emits invalid C)

**Date:** 2026-11-14

## Verbatim error

```text
tmp/p/p6a.c:2502:312: error: use of undeclared identifier '__YO_T_1012956584234043074_SOME'; did you mean '__YO_T_1012956584234043074_OK'?
tmp/p/p6a.c:2502:389: error: used type '__yo_t_1742317475074148138' (aka 'struct __yo_t_1742317475074148138_struct') where arithmetic or pointer type is required
tmp/p/p6a.c:2502:601: error: use of undeclared identifier '__YO_T_1012956584234043074_NONE'; did you mean '__YO_T_1012956584234043074_OK'?
```

## Reproducer (`tmp/p/p6a.yo`, minimized)

```yo
Speak :: trait(speak : (fn(self : &Self) -> i32));
Cat :: struct(n : i32);
impl(Cat, Speak(speak : ((self : &Self) -> self.n)));
main :: (fn() -> unit)({
  (b : Box(Dyn(Speak))) = dyn(Box.new(Cat(n : i32(3))));
  r := downcast(b, Cat);
});
export(main);
```

## Root cause (found 2026-11-14 19:30)

`src/codegen/exprs/downcast.yo`'s owning arm matched the result type with
`Rc(.EnumT({ name : res_name, ... })) => if(res_name == "Result", ...)`. But
`Result` is a comptime type CONSTRUCTOR (`std/prelude.yo`: `Result :: (fn(
comptime(OkType), comptime(ErrorType)) -> comptime(Type))( enum(Ok(value :
OkType), Err(error : ErrorType)) )`) — the EnumT it builds is an ANONYMOUS
enum whose `name` is synthesized, never the string `"Result"`. The arm's
condition was always false, control fell through to the generic Option tail,
which then emitted `.Some`/`.None` designators on the Result type (undeclared
tags) and the pre-flip Rc-extraction cast (`((Cat)fat.data)->n` — a struct
used as a pointer). The evaluator's type IS `Result(Box(Cat),
Box(Dyn(Speak)))` (E0601 mismatch probe confirms); only the codegen name
compare was wrong.

## Fix (commit a02586cd0)

Detect the shape structurally: `Rc(.EnumT({ variant_names : res_vns,
type_arguments : res_targs }))` with `res_vns` exactly `["Ok", "Err"]`
(`_vn_at_is`). The arm then emits the Ok/Err tags and hands the box's data
word (placed bit kept) back retyped as `Box(V)`, the whole fat pair as
`.Err`.

## Test

`tmp/p/p6a.yo`; the owning rows of `tests/dyn_pointer_kinds.test.yo`
("downcast(&b...)"/owning rows) and `tests/dyn.test.yo`.
