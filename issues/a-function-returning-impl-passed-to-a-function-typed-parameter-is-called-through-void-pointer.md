# A function returning `Impl(Fn)` passed to a function-typed parameter is called through `void*`

**Status:** OPEN. **Found:** 2026-10-10, while probing
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
(`((int32_t (*)())__yo_v_g)()`).

## Repro B: a generic `Impl(Fn(...) -> Impl(Fn(...)))` parameter

```rust
use_mk :: (fn(imm(mk) : Impl(Fn(x : i32) -> Impl(Fn() -> i32)), v : i32) -> i32)({
  g := mk(v);
  g()
});
```

With `mk` a named function: before the fix above this crashed (rc=138) like
repro A; after it, the specialization's PARAMETER is concrete
(`__yo_t_S (*__yo_v_mk)(int32_t)`) but the body's `mk(v)` result is still the
inner unresolved `Impl(Fn() -> i32)`, so the C fails:

```
error: initializing 'void *' with an expression of incompatible type '__yo_t_…' (aka 'struct __yo_t_…_struct')
```

With `mk` a closure local (`(mk : Impl(Fn(x : i32) -> Impl(Fn() -> i32))) = ((x : i32) => {...})`)
the same C error appears on the unfixed tree too, and even a direct
`mk(i32(4))()` in the defining scope fails it: the nested `Impl` in a closure
type's RESULT is never bound to the concrete type the closure body returns.

## Direction

Repro A: a bare `fn(...)` type has ONE calling convention, so an opaque `Impl`
in its result has no representation. Either reject `Impl` in the result of a
`fn(...)` parameter/field type at `check` (pointing at the generic
`Impl(Fn(...) -> ...)` form or at `Dyn`), as `anonymous_function.yo` already
rejects an `Impl(Fn)` parameter on a literal; or make the argument check
compare REPRESENTATIONS so a concrete-result function is not accepted where
the erased one is expected. Repro B: the specialization must bind the
`Fn` carrier's result SomeT from the argument's concrete function type (its
result's resolution), the way the outer `Impl` is bound.
