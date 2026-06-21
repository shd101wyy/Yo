# yo-self: anonymous-function param binding never inherits `is_ref` from the expected type

## Status: FIXED (pending validation) — yo-self-only port bug; TS reference is correct

## Symptom

An impl method declared with a `ref(self)` parameter on a **value struct**, written
as a bare lambda, reads `self.field` without dereferencing the C pointer:

```c
static inline size_t fn_..._get(__yo_struct_..._T* self) {
  return self.a;            // C error: `self` is a pointer — needs (*self).a
}
```

Minimal repro (no derive needed):

```rust
open(import("std/string"));
{ println } :: import("std/fmt");
T :: struct(a : usize, b : usize);
Foo :: trait(get : (fn(ref(self) : Self) -> usize));
impl(T, Foo(get : ((self) -> self.a)));
main :: (fn() -> unit)({ x := T(a : usize(5), b : usize(9)); println(x.get().to_string()); });
export(main);
```

This is the second layer of the `derive(Clone)` failure
(`issues/yo-self-derive-clone-typename-quote.md` is the first): `Clone` is declared
`clone : fn(ref(self) : Self) -> Self`, so the derived clone body
`T(self.a.clone(), …)` reads `self.field` through a `ref(self)` and hit exactly
this bug once the type-name corruption was fixed.

## Root cause

`evaluate_anonymous_function_implementation` (`yo-self/evaluator/values/anonymous_function.yo`)
binds every regular parameter via `add_variable_to_env(... false, false, false, false ...)`
— and `add_variable_to_env` has **no `is_ref` parameter** at all (its four bools
are is_compile_time_only / is_reassignable / is_owning_the_rc_value / is_implicit).
So a bare-lambda param's `Variable.is_ref` is always left **false**, regardless of
the expected type's `param_is_ref`.

The expected Func type's `param_is_ref` IS correct (it drives the `T* self` C
signature), but the body env's `self` variable never inherited it, so
`generate_atom` / `_var_read_code` (codegen) saw `is_ref=false` and emitted bare
`self` instead of `(*self)`. (The field-access dispatch in `property_access.yo`
relies on the receiver already being dereferenced by `generate_atom` — see its
line-313 comment.)

The def-time (`_build_def_time_body_env`) and generic-specialization
(`create_specialized_function_inline`, helper.yo:~1316) body-eval paths already
stamp `is_ref` after binding; the **anonymous-function** path was the missing
third one.

Confirmed with an instrumented `_var_read_code`: codegen saw `self count=1
[0].is_ref=F` for the bare-lambda impl method (and `is_ref=T` for self bound via
the other two paths).

## Fix

`yo-self/evaluator/values/anonymous_function.yo` — extract `param_is_ref` from the
expected Func type, and stamp it onto the bound `Variable` (an `object`, so the
mutation persists in the env) after `add_variable_to_env`:

```rust
param_is_ref := match(function_type, .Func({ param_is_ref : pir }) => pir, _ => ArrayList(bool).new());
...
rp_v_opt := add_variable_to_env(env, param_name, rp_ty, ...);
if(match(param_is_ref.get(rp_i), .Some(b) => b, .None => false), {
  match(rp_v_opt, .Some(rp_v) => { rp_v.is_ref = true; }, .None => ());
});
```

Mirrors TS `anonymous-function.ts:559` (`isRef: expectedParam.isRef`).

## Faithfulness note / follow-up

TS also sets `isReassignable: expectedParam.isRef` (anonymous-function.ts:560),
enabling writes *through* a `ref` param (`(*self) = …`). This fix sets only
`is_ref`, which resolves the read-deref bug (derive(Clone) and all `ref(self)`
value-struct field reads). A `ref(self)` method that **writes** `self.field` on a
value struct may need the `is_reassignable` half too; defer until such a case
surfaces, to keep this change surgical and avoid perturbing the borrow/flowability
gates.
