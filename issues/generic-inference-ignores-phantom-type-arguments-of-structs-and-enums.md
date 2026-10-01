# Generic inference ignores the phantom type arguments of structs and enums

**Severity:** S2 — a phantom index stops separating instantiations when it reaches a `generic(T)` function: `_Phantom(i32)` flows into `_Phantom(bool)` through `_pid`, and a body that reads such a `T` (`sizeof(T)`) emits C that does not compile.
**Found:** 2026-10-01, reviewing `issues/fixed/method-on-a-phantom-generic-enum-is-not-found-through-a-comptime-type-param.md`. Every case below is accepted by the develop-built compiler too, so none is a regression of that fix, and each has a struct twin that behaves the same way.

## Reproducers

A phantom position is a type parameter of a constructor that no field or
payload mentions:

```rust
_Phantom :: (fn(comptime(T) : Type) -> comptime(Type))(enum(A(x : i32), B(y : bool)));
_PS :: (fn(comptime(T) : Type) -> comptime(Type))(struct(x : i32));
_PhantomTag :: (fn(comptime(K) : Type) -> comptime(Type))(enum(A, B(n : u8)));
```

1. **`T` inferred only from a phantom argument stays unbound.** The identity
   function accepts `_Phantom(i32)` and returns something assignable to
   `_Phantom(bool)` (`check` rc 0). The struct twin, `_pid` over `_PS(T)`, is
   accepted too.

   ```rust
   _pid :: (fn(generic(T : Type), p : _Phantom(T)) -> _Phantom(T))(p);
   main :: (fn() -> unit)({
     x := _pid(_Phantom(i32).A(i32(1)));
     (_y : _Phantom(bool)) = x;
   });
   export(main);
   ```

   When the body reads `T`, codegen has no type for it:

   ```rust
   { assert } :: import("std/assert");
   _ksize :: (fn(generic(K : Type), _t : _PhantomTag(K)) -> usize)(sizeof(K));
   main :: (fn() -> unit)({
     assert(_ksize(_PhantomTag(u8).A) == usize(1), "u8");
     assert(_ksize(_PhantomTag(i64).A) == usize(8), "i64");
   });
   export(main);
   ```

   ```
   error: expected expression
    2240 |   return sizeof(/* Error: no C type name for K */);
   yo: error: compile: C compiler failed (exit 1)
   ```

   The struct twin (`_ksize` over a `struct(n : u8)` constructor) fails the
   same way.

2. **A phantom argument is not checked against a `T` that another argument
   fixes.** `T := bool` from `y`, and `_Phantom(i32)` is accepted for the
   parameter `_Phantom(T)` (`check` rc 0; the `_PS` twin too):

   ```rust
   _pick :: (fn(generic(T : Type), y : T, _p : _Phantom(T)) -> T)(y);
   main :: (fn() -> unit)({
     r := _pick(true, _Phantom(i32).A(i32(1)));
   });
   export(main);
   ```

3. **A compound phantom argument in a generic return is not substituted.**
   `_Phantom(Option(T))` at `T := bool` is assignable to
   `_Phantom(Option(i32))` (`check` rc 0; the `_PS` twin too):

   ```rust
   _phantom_of :: (fn(generic(T : Type), _t : T) -> _Phantom(Option(T)))(_Phantom(Option(T)).A(i32(1)));
   main :: (fn() -> unit)({
     x := _phantom_of(true);
     (_y : _Phantom(Option(i32))) = x;
   });
   export(main);
   ```

## Cause

The three share one gap: a generic function's type variables are found and
bound through the fields of a struct and the payloads of an enum, and a phantom
position is in neither.

- The synthesizer binds `T` of `p : _Phantom(T)` by unifying fields and
  payloads, so (1) leaves `T` unbound and (2) never compares the argument's
  `i32` with `T := bool`. Compatibility then treats the open position as a
  wildcard. An impl's `generic` parameter does not have this problem: impl
  matching falls back to the instantiation's `type_arguments`
  (`_bind_forall_from_type_args`, `evaluator/values/impl.yo`), which call-site
  inference has no counterpart for.
- In (3) the substitution map is built from the SomeTs `get_all_some_types`
  finds, which also walks payloads only, so `T` is never a key.
  `_collect_type_arg_somes` (`evaluator/types/function.yo`) triggers the
  return-type era repair for a phantom argument that IS a type variable
  (`-> _Phantom(T)` is rejected correctly), not for one nested in a compound
  argument.

## Recommendation

Bind and substitute through type arguments the way impl matching does: when
synthesis leaves a `generic` parameter unbound, take it from the matching
position of the argument's `type_arguments` (struct or enum), and when it is
bound, check that position against the binding. Collect a phantom position's
SomeTs, compound or not (`enum_phantom_positions` in `types/creators.yo`
records an enum's phantom positions; a struct's are the type arguments its
fields do not mention), into the substitution map and the era-repair trigger.
`type_key` already keys phantom positions, so each binding would reach codegen
as its own specialization.
