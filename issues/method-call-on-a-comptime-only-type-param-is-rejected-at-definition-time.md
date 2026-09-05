# A method call on a value typed from a `comptime(T) : Type` parameter is rejected at definition time

**Status:** OPEN
**Found:** 2026-09-04, measuring the `error`/`assert` row of the std API audit —
writing the row's `is(err, T)` helper as
`downcast(err, T).is_some()` does not compile.
**Severity:** papercut. A clean rewrite exists (use `match`), but the diagnostic
blames the user's method call rather than saying `T` is unresolved, and it makes
the prelude's `Option`/collection method surface unreachable inside
comptime-generic helpers.

## Symptom

```rust
{ AnyError } :: import("std/error");
open(import("std/string"));
open(import("std/fmt"));

err_is :: (fn(err : AnyError, comptime(T) : Type) -> bool)(downcast(err, T).is_some());
```

```
error: No matching call found with arguments:
(downcast(err, T).is_some)()
  --> d6.yo:5:76
  |
5 | err_is :: (fn(err : AnyError, comptime(T) : Type) -> bool)(downcast(err, T).is_some());
  |                                                                            ^
```

`downcast` is not the trigger — ANY method call on a value whose type is built
from the comptime parameter fails the same way:

```rust
none_is :: (fn(comptime(T) : Type) -> bool)({
  (o : Option(T)) = Option(T).None;
  o.is_some()                       // error: No matching call found with arguments: (o.is_some)()
});
```

```rust
list_len :: (fn(comptime(T) : Type) -> usize)({
  (l : ArrayList(T)) = ArrayList(T).new();   // error: No matching call found with arguments: (ArrayList(T).new)()
  l.len()
});
```

### What DOES work (the boundary)

| shape | verdict |
| --- | --- |
| `(fn(comptime(T) : Type) -> bool)({ (o : Option(T)) = Option(T).None; o.is_some() })` | **rejected** |
| `(fn(err : AnyError, comptime(T) : Type) -> bool)(downcast(err, T).is_some())` | **rejected** |
| `-> Option(T)` with a `.is_some()` call in the body: `({ b := downcast(err, T); match(b.is_some(), true => …, false => …); b })` | **rejected** (a `T`-bearing RETURN type does not help) |
| `(fn(err : AnyError, comptime(T) : Type) -> bool)(match(downcast(err, T), .Some(_) => true, .None => false))` | compiles, runs |
| `(fn(err : AnyError, comptime(T) : Type) -> Option(T))(downcast(err, T))` | compiles, runs |
| `(fn(comptime(T) : Type, o : Option(T)) -> bool)(o.is_some())` | compiles, runs |
| `(fn(comptime(T) : Type, x : T) -> bool)({ (o : Option(T)) = Option(T).Some(x); o.is_some() })` | compiles, runs |
| `(fn(generic(T : Type), x : T) -> bool)({ (o : Option(T)) = Option(T).Some(x); o.is_some() })` | compiles, runs |

So: the rejection fires exactly when `T` appears ONLY as a `comptime(T) : Type`
parameter and in no runtime parameter. Adding any runtime parameter mentioning
`T` makes the function deferred-generic — its body is not evaluated at
definition time at all — and the same code is accepted.

## Root cause

With `YO_DEBUG_DISPATCH=1`, the tail of the failing lookup for `o.is_some()`:

```
[tm-try] recv=enum_yo_id_7478 pat=enum_yo_id_2635 trial=false
[rfb-id-miss] name=T own_id=1015 bound_id=1015 trial=false
[bfta] fa=T fa_lvl=2 pat_ta= con_ta=
[tm-end] recv=enum_yo_id_7478 pat=enum_yo_id_2635 all_bound=false
[dispatch-miss] name=is_some recv=enum_yo_id_7478 raw=0 resolved=0
error: No matching call found with arguments:
(o.is_some)()
```

Reading it back through the code:

1. `Option`'s methods come from a GENERIC impl —
   `impl(generic(T : Type), Option(T), … is_some : …)` (`std/prelude.yo:6465`,
   `is_some` at `:6485`) — so resolution goes through
   `find_methods_from_generic_impls` (`src/evaluator/values/impl.yo:1542`) →
   `try_match_generic_impl` (`:852`).
2. Matching the pattern `Option(T)` against the receiver enum succeeds
   structurally (no `[tm-synth-swallow]`) but binds nothing for the impl's
   forall `T`. `_resolve_one_forall_binding` (`:511`) then finds `T` bound to
   ITSELF — `own_id=1015 bound_id=1015`, an unresolved `SomeT`. Accepting an
   abstract binding there is gated on `in_def_time_trial()` (`:543-545`):

   ```rust
   if(in_def_time_trial() && (bt_id.len() > usize(0)) && (bt_id != fa_some_id), {
     return(Option(TypeValue).Some(bound_type));
   });
   ```

   and this evaluation is NOT a def-time trial — `trial=false` on every line
   above. The flag is set only around the deferred-generic body trial
   (`set_in_def_time_trial(true)`, `src/evaluator/calls/function_type.yo:1538-1540`,
   and the pending re-run at `:802-804`), and a function whose only type
   parameter is `comptime(T) : Type` does not take that path: its body is
   evaluated eagerly at definition time with the flag false. (It is not the
   result-type guard at `:1471` — the `-> Option(T)` row of the table above
   mentions `T` in its result and still reports `trial=false`.) Add a runtime
   parameter mentioning `T` and the definition becomes deferred-generic, its
   body is not evaluated at definition time at all, and the same call is
   accepted — which is exactly the boundary the table shows.
3. The last-resort fallback `_bind_forall_from_type_args`
   (`src/evaluator/values/impl.yo:707-745`) cannot help for an ENUM receiver: it
   reads `type_arguments` off `.Struct({ type_arguments : ta })` only, and
   `TypeValue.EnumT` (`src/types/definitions.yo:235-245`) has no
   `type_arguments` field at all — hence `[bfta] pat_ta= con_ta=`, both empty.
4. `all_bound = false` (`src/evaluator/values/impl.yo:1188`), so
   `try_match_generic_impl` returns `.None` (`:1270`), no candidate is produced,
   the instance-dispatch lookup reports a miss (`[dispatch-miss]`,
   `src/env.yo:4117-4119`), property access degrades `o.is_some` to a unit-typed
   valueless callee, and the call gate throws "No matching call found with
   arguments" at `src/evaluator/calls/function.yo:6714`. Confirmed with
   `YO_DEBUG_CTFE=1`: `[vcall-throw] callee=(o.is_some) ty=unit`.

## Fix

Two candidate repairs; the first is narrow and matches the existing design, the
second is the faithful port and is bigger.

- **Preferred**: treat a function whose only type parameters are
  `comptime(_) : Type` the same way a deferred-generic definition is treated —
  wrap its definition-time body evaluation in `set_in_def_time_trial(true)`
  (the same pairing as `src/evaluator/calls/function_type.yo:1538-1540`), so
  `_resolve_one_forall_binding`'s abstract-binding acceptance applies and the
  stamps it leaves are correctly treated as discardable. The observable to fix
  is the `trial=false` in the `[rfb-id-miss]` line above; the implementer should
  locate the eager path that evaluates such a body (it is not the
  deferred-generic branch — the `-> Option(T)` row shows the result-type guard
  at `:1471` is not what decides it).
- **Alternative**: give `EnumT` the same `type_arguments` provenance `Struct`
  carries, so `_bind_forall_from_type_args` can bind `T` from the receiver's
  instantiation regardless of the trial flag. This mirrors what TS reads off
  `concreteType.env` and would fix the whole family of enum receivers, but it
  touches type construction everywhere `EnumT` is built.

Either way, the diagnostic deserves fixing too: when a method lookup misses on a
receiver whose type still carries an unresolved `SomeT`, say so ("`T` is not
resolved at this point") instead of "No matching call found".

## Regression test

`tests/comptime_type_arg_binding.test.yo` (or
`tests/comptime_option_result.test.yo`, which already covers comptime `Option`
shapes): a helper `(fn(comptime(T) : Type) -> bool)` that constructs an
`Option(T)` locally and calls `.is_some()` / `.is_none()` on it, plus the
`ArrayList(T).new()` form, both asserted to compile and return the right value.
Verified RED first. Keep the passing rows of the table above as
over-acceptance canaries — especially the `generic(T : Type)` and
`comptime(T) : Type, x : T` forms, which must not change.

## Not a breaking change

Purely an acceptance widening.
