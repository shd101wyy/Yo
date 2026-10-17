# `!` on a runtime bool in a `comptime(T)`-parameterized function is a false E1101

**Severity:** S2 — a valid program is rejected ("Parameter `self` is `comptime` and requires a compile-time argument") when the function is instantiated from a generic impl method; `(x : bool) = …; !x` or `== false` works around it.

**Status:** open, found 2026-10-16 while factoring `std/async/mutex.yo`'s
`_unlock_state` out of `Mutex.unlock` (#1380). Reproduces with the v0.2.63
release and with the tree.

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

## Workaround

Bind the operand first: `(was : bool) = unsafe(p.*.flag); if(!was, …)`
(`std/async/mutex.yo`'s `_unlock_state` does this).
