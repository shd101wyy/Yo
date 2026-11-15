# A temporary `dyn(Box.new(v))` lent to a `&AnyError` parameter is dropped as a legacy `Dyn`, leaking the box

**Severity:** S1 (every `f(dyn(Box.new(v)))` / `f(dyn(v))` whose parameter is `&AnyError` or another
`&Box(Dyn)` leaks the payload block: `error_chain(dyn(Box.new(e)))` is the documented spelling, and a
leak-checked build reports it)

## Symptom

```yo
_take :: (fn(e : &AnyError) -> usize)(usize(1));
n := _take(dyn(Box.new(_Inner.Boom)));
```

LeakSanitizer: `Direct leak of 4 byte(s) in 1 object(s)` from the `Box.new` specialization.
`tests/error_source_chain.test.yo`'s "error_chain of a lone error yields exactly one link" row. The
emitted C drops the temporary with `__yo_dyn_release(tmp.data, tmp.vtable)` (the legacy retain/release
pair, a no-op on a `_P` payload vtable) instead of the box's dispose.

## Root cause

`_evaluate_dyn_erasure` (`src/evaluator/values/dyn.yo`) types the erasure as the `Dyn` and attaches the
expression's temp variable (`attach_temp_variable_to_expr`) at that type. `evaluate_dyn_value` then
retypes the expression to its handle (`Box(Dyn(...))`), but the temp variable keeps `Dyn`, and the
call's temporary drop reads the variable's type: `generate_drop_code_for_type` takes its `is_dyn_type`
arm. A named binding drops through its own declared type, which is why `(e : AnyError) = dyn(...)` was
correct.

## Fix

After the retype, `evaluate_dyn_value` updates the ExprInfo's origin type and re-attaches the temp
(the existing variable takes the handle type).

## Test

`tests/error_source_chain.test.yo` "error_chain of a lone error yields exactly one link" (leak verdict
on); probe `tmp/p/p21.yo`. Fails before, passes after.
