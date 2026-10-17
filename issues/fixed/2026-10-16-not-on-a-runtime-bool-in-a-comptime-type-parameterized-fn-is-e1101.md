# `!` on a runtime bool in a `comptime(T)`-parameterized function is a false E1101

**Severity:** S2 — a valid program is rejected ("Parameter `self` is `comptime` and requires a compile-time argument") when the function is instantiated from a generic impl method; `(x : bool) = …; !x` or `== false` works around it.

**Status:** fixed 2026-10-17 (#1433). Found 2026-10-16 while factoring
`std/async/mutex.yo`'s `_unlock_state` out of `Mutex.unlock` (#1380).
Reproduced with the v0.2.63 release and with the tree.

## Reproducer

```yo
pragma(Pragma.AllowUnsafe);
S :: (fn(comptime(T) : Type) -> comptime(Type))(struct(flag : bool, v : T));
f :: (fn(comptime(T) : Type, p : *S(T)) -> unit)({
  if(!unsafe(p.*.flag), {
    __yo_panic("not set");
  });
  unsafe(consume(p.*.flag = false));
});
W :: (fn(comptime(T) : Type) -> comptime(Type))(struct(st : Box(S(T))));
impl(
  generic(T : Type),
  W(T),
  st_ptr : (fn(self : &Self) -> *S(T))(addr_of(self.st.*)),
  go : (fn(self : &Self) -> unit)({
    f(T, self.st_ptr());
  })
);
main :: (fn() -> unit)({
  w := W(i32)(st : box(S(i32)(flag : true, v : i32(1))));
  w.go();
});
export(main);
```

```
error[E1101]: Parameter `self` is `comptime` and requires a compile-time argument, but the argument is a runtime value of type bool
 4 |   if(!unsafe(p.*.flag), {
   |       ^^^^^^
note: in `f`, instantiated here
13 |     f(T, self.st_ptr());
```

The same `f` called directly from `main` with `f(i32, addr_of(s))` compiles,
and so does `if(unsafe(p.*.flag) == false, …)` from the generic method. The
`generic(T : Type)` spelling of `f`'s parameter fails the same way. The `!`
seems to resolve to the comptime-`bool` operator when the instantiation is
reached through a generic impl's `T`.

## Root cause

Neither the generic impl nor `!` itself is needed; what matters is a
pointer-typed argument that is a CALL'S RESULT, passed to a function with a
comptime parameter (so the call specializes it), and a `.*` of that parameter:

```yo
pragma(Pragma.AllowUnsafe);
f :: (fn(comptime(T) : Type, p : *bool) -> unit)({
  if(!unsafe(p.*), {
    __yo_panic("not set");
  });
});
sp :: (fn(b : &Box(bool)) -> *bool)(addr_of(b.*));
main :: (fn() -> unit)({
  b := box(true);
  f(i32, sp(&b));
});
export(main);
```

The specialization binds `p` to the argument's value, the call result's
RUNTIME-ONLY `UnknownVal` (`_call_result_unknown`). In the checking phase the
`.*` arm of `src/evaluator/exprs/property_access.yo` answers a deref of an
`UnknownVal` with a fresh `create_unknown_val(...)`, which drops the
runtime-only flag. An unmarked unknown is a compile-time placeholder as far as
`runtime_value_for_comptime_param` is concerned, so the `!` overload trial
accepted `comptime_not` (`comptime(self) : _Self`) and then rejected the
operand with E1101. A field access (`p.*.flag`) already propagates the flag
from its object, so the deref was the one link that lost it. `f(i32, addr_of(s))`
and `p := self.st_ptr(); f(T, p)` pass a pointer value or a variable, never an
unknown, which is why they compiled.

## Fix

The deref keeps the pointer's flag: a runtime-only pointer has a runtime-only
pointee. `std/async/mutex.yo`'s `_unlock_state` drops its workaround
(`(was_locked : bool) = …; if(!was_locked, …)`) and spells
`if(!unsafe(st.*._locked), …)` again. Test:
`tests/prefix_operators.test.yo`, "! on a runtime pointee through a
call-result pointer in a comptime-parameterized fn" (the issue's generic-impl
shape and the direct call above); it failed to compile with E1101 before. Each
call's result is bound before it is asserted: making the first call an operand
of `!` drops a store in the callee, a separate bug found while gating this fix
(`issues/2026-10-17-a-store-in-a-comptime-parameterized-fn-is-dropped-when-its-first-call-is-an-operand-of-not.md`).
