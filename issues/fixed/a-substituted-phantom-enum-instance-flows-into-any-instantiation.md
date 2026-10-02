# A substituted phantom enum instance flows into any instantiation

**Severity:** S2 — an ill-typed program is accepted. The result of a generic function returning a phantom-indexed enum, such as `_Phantom(T)` at `T := bool`, is assignable to `_Phantom(i32)`, so a phantom index no longer separates its instantiations. The C layouts of the instantiations are identical, so nothing is miscompiled.
**Found:** 2026-10-01, writing the regression test of `issues/fixed/method-on-a-phantom-generic-enum-is-not-found-through-a-comptime-type-param.md`.

## Reproducer

```rust
_Phantom :: (fn(comptime(T) : Type) -> comptime(Type))(enum(A(x : i32), B(y : bool)));
_phantom_of :: (fn(generic(T : Type), _t : T) -> _Phantom(T))(_Phantom(T).A(i32(1)));
main :: (fn() -> unit)({
  x := _phantom_of(true);
  (_y : _Phantom(i32)) = x;
});
export(main);
```

The develop-built compiler accepts it. `(_z : i32) = x` shows the result type
as `_Phantom(T)`, the definition-era instance.

## Cause

Two gaps, both about phantom positions.

1. The call's return type is the declared `_Phantom(T)` substituted at
   `T := bool`. The substitution map is built from the SomeTs
   `get_all_some_types` finds, which walks payloads only, and no payload
   mentions `T`. So `T` was never a substitution key. The return-type era repair
   (`calls/function.yo`, `rre_era_suspect`) would have re-evaluated the return
   expression to the memo's `_Phantom(bool)`, but its trigger,
   `_collect_type_arg_somes` (`evaluator/types/function.yo`), read only a
   struct's `type_arguments`.
2. Even a correctly substituted instance carried no arguments of its own. The
   arguments lived in an id-keyed side table, and substitution keeps the id,
   so the instance reported the definition-era `[T]`. Compatibility treats an
   open position as a wildcard, so `_Phantom(T)` matched `_Phantom(i32)`.

## Fix

`EnumT` carries its `type_arguments`, which substitution rewrites (see the
phantom-method issue above). `_collect_type_arg_somes` now also returns an
enum's phantom type-variable arguments (`enum_phantom_type_arg_somes`,
`types/utils.yo`), so the era repair re-evaluates `-> _Phantom(T)` to the
memo's `_Phantom(bool)`, and the assignment is rejected:

```
error[E0601]: Incompatible types:
- Expected: _Phantom(i32)
- Given   : _Phantom(bool)
```

The regression test is "soundness: a substituted phantom enum instance keeps
its type argument" in `tests/type_soundness.test.yo`. It fails with the
develop-built compiler and passes after.

## Scope

The fix covers the reproducer's shape: a phantom argument that is itself the
type variable (`-> _Phantom(T)`), with `T` bound from an argument whose own
type is `T` or that carries `T` in a field or payload. Three neighbouring
shapes still let a phantom index flow into any instantiation, for structs and
enums alike, and were accepted before this fix too: `T` bound only by a
phantom argument (`_pid(_Phantom(i32)...)` returns something assignable to
`_Phantom(bool)`), a phantom argument checked against a `T` another argument
fixes, and a compound phantom argument in a generic return
(`-> _Phantom(Option(T))`). They are open in
`issues/generic-inference-ignores-phantom-type-arguments-of-structs-and-enums.md`.
