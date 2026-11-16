# A `str` read through a raw pointer into an enum payload stores the pointer instead of the string

**Severity:** S1. This happened on the `str` flip's tree binary (decision 49 S2, `vbd/d49-str`). It never reached develop. The bug was a miscompile. `ArrayList(str).get(i)` built its `.Some((_ptr.add(index)).*)` payload from the element's address instead of the element. The C initialized the payload's `__yo_str` with a `__yo_str*`, so `.ptr` received the pointer and `.len` was left at 0.

Clang's `-Wincompatible-pointer-types` is an error by default under the test runner, so `tests/str.test.yo` failed to compile its batch: none of its 12 rows ran. The compiler's own C is built with warnings off, so the same code compiled silently in the compiler's own tree. In `src/expr.yo` it gave `ast_expr_is_atom_of_any` and the function-name scan at line 1185 a zero-length `v`. The fixpoint still held, because stage 2 and stage 3 both carry the defect.

Filed 2026-11-16 by the d49-str lane, from the final gate on `b6dbf25eb` (`finB`: `tests/str.test.yo` rc=1). It was fixed on the same branch before the branch was opened.

## Reproducer

```yo
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
first :: (fn(xs : &ArrayList(str)) -> str)({
  v := match(xs.get(usize(0)), .Some(s) => s, .None => "~");
  v
});
main :: (fn() -> unit)({
  mut(xs) := ArrayList(str).new();
  xs.push("hi");
  println(first(&xs));
});
export(main);
```

The emitted `get` specialization contained this line, which `clang` rejects:

```c
.data = { .__yo_v_Some = { .__yo_v_value = (_ptr + __yo_v_index) } }
```

## Root cause

`_generate_runtime_enum_construct` (`src/codegen/exprs/other_fn_call.yo`) handles a payload slot that holds a reference to an unsized pointee (`&(str, static)`, `&Dyn`). It folds the argument's `(*x)` to `x` with `unsized_lend_pair_code`. That is the right fold for a lent unsized place, such as `&b.*` or a literal at a `str` place, whose code reads through the fat pair. The argument here is different: `(p.add(i)).*` over a `*(&(str, static))` is a reference value, a read of the element. Its `(*p)` is that read, not a place, and the fold dropped it.

## Fix

The fold now applies only when the argument is not itself a reference to an unsized pointee (`f_arg_is_fat_value`). A reference value's code is already the pair. Struct fields were already right: `_StrHolder(name : (p.add(i)).*)` emitted `(*(p + i))`.

## Test

`tests/str.test.yo`, "a str read through a raw pointer fills a payload and a field". It covers `.Some((p.add(i)).*)`, a struct field and `ArrayList(str).get`. The row fails to compile on `yo-f1` (b6dbf25eb) with the error above and passes after the fix.
