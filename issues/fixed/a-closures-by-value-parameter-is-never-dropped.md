# A closure's by-value parameter is never dropped

**Severity:** S2: a leak. A closure literal passed where an `Fn(r : T)` is expected, with `T` not `Copy`, receives its argument by value (the caller moves it in) but never drops it: one `Dispose` short per call, and the counted payload is never released.

> Found 2026-10-09 while landing V3b Generation B's flip
> (`plans/VALUES_BY_DEFAULT.md` decision 30). Before the flip a plain `Fn`
> parameter borrowed, so nothing was moved in and nothing leaked.

## Reproducer

```rust
(g_disposed : i32) = i32(0);
_Res :: struct(n : i32);
impl(_Res, Dispose(dispose : (fn(imm(self) : Self) -> unit)({ g_disposed = (g_disposed + i32(1)); })));
_run :: (fn(imm(f) : Impl(Fn(r : _Res) -> i32)) -> i32)(f(_Res(n : i32(5))));
// _run(r => r.n): g_disposed stays 0
```

## Root cause

A closure literal binds its parameters with `add_variable_to_env`
(`src/evaluator/values/anonymous_function.yo`), non-owning, and stamps only
`is_ref` from the expected type. The closure type built from an `Fn` trait
(`_func_from_fn_trait`) also carried an empty `param_is_owning`. After the flip
the caller moves the argument into a by-value `Fn` parameter, so the argument's
only owner was a binding that never drops.

## Fix

`_func_from_fn_trait` carries the trait's by-value flags
(`FnTraitT.call_param_is_owning`), and the closure-literal binder marks a
by-value, non-`Copy` parameter owning (`type_is_bitwise_copy` decides, as in
`bind_parameter`), so the closure's scope end drops it.

Test: `tests/parameter_modes.test.yo` "a closure's by-value parameter owns its
argument and drops it once" (a `Dispose` counter; fails before the fix).
