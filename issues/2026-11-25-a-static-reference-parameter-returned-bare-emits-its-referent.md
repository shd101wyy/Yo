# A static reference parameter returned bare emits its referent

**Severity:** S2 (a valid program does not compile: the emitted C returns a struct where the function returns a pointer).

**Status:** OPEN. Found 2026-11-25 by the P12 lane (VERDICTS-74) on `v0280/p12-static-origin` at `41f23ee2a`. Before P12's rule-3 fix the checker rejected the program (E0923), so codegen never saw it.

## The repro

```yo
{ assert } :: import("std/assert");
X :: struct(n : i32);
G := X(n : i32(7));
id :: (fn(v : &(X, static)) -> &(X, static))(v);
main :: (fn() -> unit)({
  a := id(&G);
  assert(a.*.n == i32(7), "reads");
});
export(main);
```

`yo check` accepts it; `yo compile` fails in the C compiler:

```text
error: returning 'struct X' from a function with incompatible result type 'const struct X *'; take the address with &
  return (*__yo_v_v);
```

`.Some(v)` from the same parameter compiles and runs (`-> Option(&(X, static))`): the constructor's argument
is a lend (`expr_info_converted_runtime_type` is a `Reference`), so its C takes the place's address,
`&((*__yo_v_v))`.

## Root cause

A `&(T, static)` result over a sized `T` is a by-value slot (`ValueSlot(&T)`, decision 49), not a projection, so
`fn_result_is_ref` is false and no return path takes the address of a place. The parameter `v` is
pointer-passed (`fn_param_is_ptr_borrow`'s static-slot arm), and an atom read of a pointer-passed reference
binding is its referent, `(*v)`. The tail `v` is emitted as that read.

## Where the fix belongs

The evaluator records the tail (and every `return(...)` operand) of a function whose result is a by-value
reference slot as a reference VALUE read: the conversion a constructor's reference argument gets. The tail and
return code paths (`functions/generation.yo`'s `__yo_scope_ret`, `exprs/return.yo`, a `cond`/`match` arm tail)
then take the address, folding `&(*v)` to `v`.

## The test

A row of `tests/unsized-places.test.yo` returning the bare parameter (`_UpStaticId`), beside the
`_UpStaticWrap` row, called with `&_UpG`.
