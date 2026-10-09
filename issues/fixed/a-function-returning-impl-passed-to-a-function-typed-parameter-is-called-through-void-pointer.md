# A function returning `Impl` passed to a function-typed parameter is called through `void*`

**Status:** FIXED 2026-10-10 (`fix/impl-fn-returning-fn-as-argument`). **Found:** 2026-10-10, while probing
`issues/fixed/a-local-function-value-returning-an-impl-fn-calls-through-a-void-pointer-signature.md`
(reproduces on the tree before and after that fix, with a module-level `mk` as
well as a local one).
**Severity:** S1 — a valid-looking program passes `check` and compiles without a
diagnostic, then crashes at runtime (SIGBUS, rc=138, at `-O2` and `-O0`).

## Repro A: a plain `fn` parameter type

```rust
{ println } :: import("std/fmt");
use_mk :: (fn(mk : (fn(x : i32) -> Impl(Fn() -> i32)), v : i32) -> i32)({
  g := mk(v);
  g()
});
mk :: (fn(x : i32) -> Impl(Fn() -> i32))({
  (f : Impl(Fn() -> i32)) = ({ x }() => (x * i32(2)));
  f
});
main :: (fn() -> unit)({
  println(`${use_mk(mk, i32(21))} (want 42)`);
});
export(main);
```

`use_mk` is emitted once, with `void* (*__yo_v_mk)(int32_t)`; `mk` returns its
closure's capture struct BY VALUE. Nothing checks that the argument's concrete
result has the parameter's representation, so the call is an ABI mismatch and
`g()` then calls the struct's bits as a plain function pointer
(`((int32_t (*)())__yo_v_g)()`). A struct FIELD of that type
(`Holder :: struct(mk : (fn(x : i32) -> Impl(Fn() -> i32)))`) and a function
RESULT of it (`get_mk :: (fn() -> (fn(x : i32) -> Impl(Fn() -> i32)))(mk)`)
crash the same way; a parameter whose function type TAKES an `Impl(Fn(...))`
(`p : (fn(imm(f) : Impl(Fn() -> i32)) -> i32)`) emitted C calling an
undeclared symbol.

## Repro B: a generic `Impl(Fn(...) -> Impl(Fn(...)))` parameter

```rust
use_mk :: (fn(imm(mk) : Impl(Fn(x : i32) -> Impl(Fn() -> i32)), v : i32) -> i32)({
  g := mk(v);
  g()
});
```

The specialization's PARAMETER is concrete (`__yo_t_S (*__yo_v_mk)(int32_t)`)
but the body's `mk(v)` result is the inner, unresolved `Impl(Fn() -> i32)`, so
the C fails:

```
error: initializing 'void *' with an expression of incompatible type '__yo_t_…' (aka 'struct __yo_t_…_struct')
```

The Rust spelling of the same API fails identically:
`fn(generic(G : Type), imm(mk) : Impl(Fn(x : i32) -> G), v : i32, where(G <: (Fn() -> i32))) -> i32`
(`G` IS bound to `mk`'s concrete result — the specialization's name carries
the capture struct — but `mk(v)` is typed from the trait's declared `G`). With
`mk` a closure local
(`(mk : Impl(Fn(x : i32) -> Impl(Fn() -> i32))) = ((x : i32) => {...})`) even a
direct `mk(i32(4))()` in the defining scope failed: the BINDING itself lowered
to `void*` and received the capture struct by value.

## Root cause

Two independent defects.

1. **No rule for an `Impl` inside a bare function type.** A `fn(...) -> R`
   type is one C function-pointer type, but `Impl(Fn(...))` names a
   different concrete type in each function of that signature (every closure
   is its own struct, returned by value; a function taking one is specialized
   per closure). Nothing rejected such a type as the type of a slot that many
   functions can fill, so it lowered the `Impl` to `void*` and accepted any
   function of the "same" signature.
2. **A call through an `Impl(Fn(...) -> R)` value typed its result from the
   trait's declared `R`.** `try_to_call_function_with_arguments`
   (`src/evaluator/calls/helper.yo`, the `norm_func_type` normalization) built
   the callee's signature from the `FnTraitT` alone, so an open `R` (an inner
   `Impl(...)`, a `generic` `G`) stayed open even when the callee's
   resolution chain reached its concrete function: the argument's `Func` (whose
   result carries the `Impl` resolution since #1294) or a closure's capture
   struct (whose closure's registered type carries its body's result). And a
   closure annotated `Impl(Fn(...) -> Impl(...))` never took on its own
   capture struct as the binding's resolution
   (`src/evaluator/values/anonymous_function.yo`, the `w_has_concrete_fn` gate
   admitted only a non-SomeT trait result), so the local lowered to `void*`.

## Decision

Rust-like and sound (maintainer directive: strict, explicit, sound; match
Rust where possible).

- **A bare, monomorphic `fn(...)` type used as the type of a runtime
  parameter, a struct/enum/tuple/union field or a function result may not
  mention an unresolved `Impl(...)` in its own parameter or result types.**
  It has no single representation. Rust rejects `fn(i32) -> impl Fn() -> i32`
  and `fn(impl Fn())` for the same reason (`impl Trait` is not allowed in
  `fn` pointer types). The diagnostic names the slot and points at the two
  sound alternatives: a generic `Impl(Fn(...) -> ...)` parameter (specialized
  per argument) or a `Dyn(Fn(...))` result (one boxed representation).
- **Exempt, because they ARE sound:** `Impl(Future(...))` — every future
  lowers to one pointer to a state machine, so
  `(fn(x : i32, io : Io) -> Impl(Future(i32, Io)))` is one representation
  (measured: two different async functions through one such parameter return
  42 and 24); a `comptime(f)` parameter (specialized per value); a generic
  (`forall`) function type (compile-time only; a runtime parameter of one is
  already rejected, and the builtin `Io` slots are of this kind); a RESOLVED
  `Impl` (a definition's own type, one hidden concrete type); a LOCAL
  annotation `(h : (fn(x : i32) -> Impl(Fn() -> i32))) = mk`, which takes
  `mk`'s own function type exactly as an `Impl(Fn(...))` annotation takes its
  closure's (reassigning `h` to a function with another closure result is
  already E0601). A trait method's or a definition's own
  `fn(...) -> Impl(...)` signature is untouched — that is what `Impl` results
  are for.
- **The generic forms work.** `imm(mk) : Impl(Fn(x : i32) -> Impl(Fn() -> i32))`
  and `generic(G), imm(mk) : Impl(Fn(x : i32) -> G), where(G <: (Fn() -> i32))`
  are specialized per argument, so `mk(v)` has that argument's concrete
  result. Stable Rust rejects the nested-`impl` spelling
  (`impl Fn(i32) -> impl Fn() -> i32`, E0562) only as an implementation
  limit (`impl_trait_in_fn_trait_return`); per specialization the inner type
  is as determined as a `G` generic, and Yo already accepts the nested form in
  a definition's result (`-> Impl(Fn() -> Impl(Fn() -> i32))`,
  `tests/ref_closure_capture.test.yo`), so it stays accepted.

Recorded in `docs/en-US/DESIGN.md` / `docs/zh-CN/DESIGN.md` (Existential
Types → "A bare function type never mentions `Impl(Fn(...))`") and
`.github/instructions/yo-syntax.instructions.md`.

## Fix

- `src/types/utils.yo` `fn_type_unrepresentable_impl` (+ message/help): the
  first unresolved, non-`Future` `Impl(...)` in a monomorphic `Func`'s own
  parameter/result types (recursing into nested function types only — a
  struct named there, e.g. `Io`, is no part of the signature's
  representation).
- Rejected at: a runtime parameter (`src/evaluator/types/function.yo`
  `evaluate_function_parameter`), a function result (`evaluate_function_type`),
  a runtime field (`src/evaluator/types/field.yo` `evaluate_type_field`).
- `src/evaluator/calls/helper.yo` `_impl_fn_callee_result`: when the declared
  `R` of an `Impl(Fn(...) -> R)` callee is open and the callee's resolution
  chain reaches a concrete `Func` (or a capture struct → its closure's
  registered `Func`) whose result is closed, the call has that result.
- `src/evaluator/values/anonymous_function.yo`: a closure whose expected
  trait result is itself an unresolved `Impl(Fn(...))` takes on its capture
  struct as the binding's resolution (its registered type already carries the
  body's concrete result).

## Probes (`--std-path ./std`, -O2; the working rows also at -O0)

| probe | before (tree at 22ec1be49) | after |
| --- | --- | --- |
| A: `fn(...) -> Impl(Fn)` parameter | compiles, rc=138 | check error: cannot be the type of parameter "mk" |
| struct field of that type | compiles, rc=138 | check error: … struct field "mk" |
| function result of that type | compiles, rc=138 | check error: … a function result |
| `fn(imm(f) : Impl(Fn)) -> i32` parameter | C error (undeclared symbol) | check error: … parameter "p" |
| B: nested `Impl(Fn(x) -> Impl(Fn()))` parameter, named `mk` | C error (`void*` init) | 42 |
| B with a closure argument | C error | 43 |
| closure local annotated nested `Impl`, `mk(4)()` | C error | 8 |
| `where(G <: (Fn() -> i32))` generic | C error | 42 |
| generic `R` returned to the caller | 42 | 42 |
| local annotation `(h : fn(...) -> Impl(Fn)) = mk` | 42 | 42 |
| `comptime(mk) : fn(...) -> Impl(Fn)` | 42 | 42 |
| two async fns through `fn(...) -> Impl(Future(i32, Io))` | 42, 24 | 42, 24 |

## Tests

- `tests/closure.test.yo`: "a function returning Impl(Fn) through a generic
  Impl(Fn) parameter", "a closure returning Impl(Fn) through a nested
  Impl(Fn) slot", "a function's Impl(Fn) result through a generic parameter
  releases its capture once", "a local or comptime slot of a function type
  returning Impl(Fn)" — the file fails to compile on the parent build (C
  `void*` initialization errors), 35/35 after.
- `tests/async_future_parameter.test.yo`: "two async functions through one
  function-typed parameter" (guards the `Impl(Future)` exemption).
- CLI cases `check-fn-type-{param,field,result,impl-param}-rejects-an-opaque-impl`:
  `check` exits 1 naming the slot; on the parent build `check` passes, so the
  keep-match finds nothing and each case fails (NO-GOLDEN, vacuous).
