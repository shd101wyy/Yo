# A type built from a binder bound to a substituted enum reuses another instantiation

**Severity:** S2: a generic function that builds a type from its binder (`Option(T)`, `JoinHandle(T)`) is rejected when it is called with futures of one generic producer at two types (two `JoinHandle(T).join` futures). The second call reuses the first call's type, and the evaluator reports `Cannot unify incompatible types: "bool" and "i32"` or `Incompatible types for field "value" … These are two different declarations with the same name`. This blocks `std/async`'s future-taking `timeout`, whose body is `(h : JoinHandle(T)) = io.spawn(fut, io)` (VBD §3.13 A4's std half).

**Status:** FIXED 2026-10-20 (`fix/ctfe-enum-arg-type-args`). **Found:** 2026-10-20, while fixing `issues/fixed/2026-10-16-a-generic-io-async-body-shares-one-capture-struct-across-futures-of-one-generic-producer.md`, whose "evaluator error instead" symptom this is. v0.2.66 and develop `6ccddf25d` both fail.

## Reproducer

```yo
{ assert } :: import("std/assert");
{ println } :: import("std/fmt");
import("std/async");
wrap :: (fn(generic(T : Type), fut : Impl(Future(T, Io)), io : Io) -> Option(T))({
  r := io.await(fut, io);
  Option(T).Some(r)
});
main :: (fn(io : Io) -> unit)({
  a := wrap(io.spawn(io.async((io : Io) => i32(3)), io).join(io), io);
  assert(a == .Some(.Some(i32(3))), "a");
  b := wrap(io.spawn(io.async((io : Io) => true), io).join(io), io);
  assert(b == .Some(.Some(true)), "b");
  println("ok");
});
export(main);
```

```text
error[E0601]: Incompatible types for field "value":
- Expected: Option(T)
- Given  : Option(T)
These are two different declarations with the same name.
 7 |     Option(T).Some(r)
note: in `wrap` with T = Option(T), instantiated here
```

The `io.async` and `io.spawn` forms of the same body fail the same way. With `(h : JoinHandle(T)) = io.spawn(fut, io)` the message is `Cannot unify incompatible types: "bool" and "i32"`; with the order of the two calls swapped it becomes `"i32" and "bool"`. The second instantiation always reads the first one's type. A plain generic FUNCTION producer (`mk(generic(T), v : T, io) -> Impl(Future(T, Io))`) does not fail. Neither does a binder that is only used bare (`(r : T) = io.await(fut, io)`).

## Cause

`join`'s result is `Option(T)` under its impl binder. The method-dispatch route builds each call's `Option(i32)` and `Option(bool)` by SUBSTITUTION. Substitution keeps the declaration's enum id and rewrites only `type_arguments`, so a traced dump of `wrap`'s binder shows the same `EnumT` id with arguments `[i32]` and `[bool]`. `T := Option(i32)` and `T := Option(bool)` are therefore two values of one id.

`wrap`'s body then calls the type constructor with that binder (`Option(T)`, `JoinHandle(T)`). The CTFE memo (`src/evaluator/calls/comptime_fn.yo`, `_ctfe_args_equal`) treats an enum argument whose id matches a cached entry as EQUAL without looking at its arguments:

```yo ignore
((a_enum_id.len() > usize(0)) && (a_enum_id == b_enum_id)) => true,
```

`_ctfe_types_era_equal` has the same shortcut one level down. So the second call's `Option(Option(bool))` memo-hit the first call's `Option(Option(i32))`. Structs got exactly this guard in `issues/fixed/ctfe-memo-shared-struct-id-fast-path-smell.md` (`_ctfe_same_id_type_args_agree`). Enums kept the shortcut because the guard's doc said "enums carry no type_arguments", which stopped being true once `EnumT` recorded them.

## Fix

`_ctfe_same_id_type_args_agree` reads `type_arguments` from an `EnumT` as well as a `Struct`, and both enum shortcuts call it. A recursive enum's `__self_shell` still unifies with its final, because the shell shares the arguments or records none, and a side with no recorded arguments still matches on the id alone.

Regression test: `tests/async/combinators.test.yo`, "A4: a type built from the binder of a join future at two types is two types". It covers `JoinHandle(T)` in a spawning `io.async` body, `Option(T)` in an `io.async` body, and `Option(T)` in a plain function, each at `i32` and `bool`. Its file fails on develop.
