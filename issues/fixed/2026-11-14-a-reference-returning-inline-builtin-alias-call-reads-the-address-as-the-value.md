# A reference-returning inline-builtin alias call reads the address as the value

**Severity:** S2: a direct call of the prelude's `Array` `index`/`index_mut`
(`arr.index(j).*`), or of any user wrapper that aliases `__yo_array_index`, yields the
element's address where the element is wanted. Usually that is invalid C or a checked
overflow panic. An unchecked context could read a wrong value.

Filed 2026-11-14 by the `rider` lane. The Tier 1 run of the deref seed rider found it:
the rider makes `__yo_array_index(addr_of(a.*), i)` wrappers aliases again
(`issues/fixed/2026-11-14-an-inline-builtin-alias-that-derefs-its-reference-parameter-emits-a-type-as-the-operand.md`),
and the new regression test's `_arr_at(&arr, j).*` aborted. v0.2.77 has the same bug for
`arr.index(j).*`.

## Reproducer

```yo
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  arr := Array(i32, 4)(i32(1), i32(2), i32(3), i32(4));
  (j : usize) = usize(2);
  c := arr.index(j).*;
  println(&c);
  d := (arr.index(j).* + i32(1));
  println(&d);
});
export(main);
```

```text
$ yo compile tmp/idx.yo --optimize 0 -o tmp/idx.bin       # yo 0.2.77
tmp/idx.bin.c:2358:11: error: incompatible pointer to integer conversion initializing 'int32_t' (aka 'int') with an expression of type 'int32_t *'
 2358 |   int32_t _file____home_temp_… = (&(((&(__yo_v_arr)))->data[__yo_v_j]));
```

Without the `c` line the program compiles, and `d`'s line casts the pointer to
`long long` before the add. The checked add then panics with `integer addition overflow`.
`m.index_mut(j).* = x` fails with `cannot take the address of an rvalue of type 'int32_t *'`.

## Root cause

A projection call (decision 24, a function whose result is `&T`/`&mut T`) returns its
place's address in C, and the call is the place `(*f(args))`. The direct-call and
dispatched-method paths of `src/codegen/exprs/other_fn_call.yo` wrap it so
(`call_projection_mode`). When the callee is elided as an alias of an inline builtin
(`is_function_value_with_only_builtin_yo_inline_function_call`), both paths returned the
builtin's code without the wrap. `__yo_array_index` emits the address `&(a->data[i])`,
as the wrapper's function form returns `T*`. A subscript `arr(j)` takes another path (the
`Index` dispatch in `generation.yo`/`ptr_fns.yo`), which derefs, so only a direct call
of `index`/`index_mut` or of a user wrapper showed it.

## Fix

`_inline_alias_call_code` (`other_fn_call.yo`) emits the alias at both sites and wraps a
projection call in `(*…)`, as the direct projection call is wrapped.

Test: `tests/inline_builtin_alias.test.yo` ("a reference-returning inline-builtin alias
call is the element's place"): `_arr_at(&arr, j).*`, `arr.index(j).*` as an initializer and
in arithmetic, and a write through `m.index_mut(j).*`. Before the fix the batch failed in
the C compiler.
