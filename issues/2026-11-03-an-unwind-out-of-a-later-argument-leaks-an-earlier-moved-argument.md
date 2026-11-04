# An unwind out of a later argument leaks an earlier moved argument

**Severity:** S2 — a call or struct literal that moves a local into an earlier argument, then unwinds while evaluating a later argument, never releases the local: one value leaks per unwind through that shape. Only the unwind path is affected, and it is not a use-after-free or a double free.

## Reproducer

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
{ Exception } :: import("std/error");
(mut(g_drops) : i32) = i32(0);
_Key :: struct(n : i32);
impl(
  _Key,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      g_drops = (g_drops + i32(1));
    })
  )
);
_Pair :: struct(key : _Key, w : i32);
_mk :: (fn(fail : bool, exn : Exception) -> i32)({
  if(fail, {
    exn.throw(dyn(String.from("x")));
  });
  i32(1)
});
_take :: (fn(k : _Key, w : i32) -> i32)(k.n + w);
_ctor :: (fn(fail : bool, exn : Exception) -> i32)({
  k := _Key(n : i32(2));
  p := _Pair(key : k, w : _mk(fail, exn));
  p.key.n
});
_call :: (fn(fail : bool, exn : Exception) -> i32)({
  k := _Key(n : i32(2));
  _take(k, _mk(fail, exn))
});
_run :: (fn(which : i32, fail : bool) -> i32)({
  exn := Exception(throw : (_err -> unwind(i32(-1))));
  if(which == i32(0), _ctor(fail, exn), _call(fail, exn))
});
main :: (fn() -> unit)({
  b := g_drops;
  r := _run(i32(0), true);
  d := (g_drops - b);
  println(`struct literal: r=${r.to_string()} drops=${d.to_string()}`);
  b2 := g_drops;
  r2 := _run(i32(1), true);
  d2 := (g_drops - b2);
  println(`call: r=${r2.to_string()} drops=${d2.to_string()}`);
});
export(main);
```

On develop `ce827ae52` both lines print `drops=0`; the expected value is `drops=1`, since `k` is still owned when `_mk` unwinds. The paths that do not unwind drop it once.

## Cause

`generate_consumed_var_drops_for_escape` (`src/codegen/exprs/return.yo`) skips a consumed variable whose consumption comes before the escape point (`_variable_moved_before_cleanup_point`, which compares `consumed_at_token` with the escape point's last token). An argument's consumption token is the argument's own position, but the C moves it only when the call or struct literal executes, after every argument has been evaluated. A later argument that unwinds therefore sees the earlier argument as already moved, and nothing releases it.

## Fix direction

Order an argument's consumption at its enclosing call (the end of the call's argument list), not at the argument token. In other words, when the escape point lies inside a later argument of the same call that consumes the variable, the variable is not moved yet. The test goes in `tests/shadowed_binding_early_return_drop.test.yo` next to the shadowed-drop cases. Before 2026-11-03, one compiler site (`_compile_const_expr`'s `return(Pattern.Const(ty : const_ty, ..., subject : _test_subject(&test), ...))`) was balanced only by the separate S1 bug, `issues/fixed/2026-11-03-an-unwind-drop-names-a-shadowing-local-of-another-type.md`. After that fix, this leak shows there as well.
