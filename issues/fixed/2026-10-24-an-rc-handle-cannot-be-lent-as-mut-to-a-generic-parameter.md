# An `Rc` handle cannot be lent as `&mut` to a generic `&mut T` parameter

**Severity:** S2 — a valid program is rejected with a false E0919. Lending an
`Rc` handle itself (not its payload) as `&mut` to a bare generic binder, such as
`std/mem`'s `replace(&mut r, rc(x))`, `swap(&mut r, &mut r2)` or
`replace(&mut h.r, rc(x))`, fails to check. The same call through a
non-generic `dst : &mut Rc(i32)` parameter is accepted. An `Rc` wrapped in
something else (`Option(Rc(T))`, a struct with an `Rc` field) is unaffected.

**Found:** 2026-10-24, reviewing V2b B6-0 (`std/mem`). The tree binary at
`f271ed005` and the v0.2.68 seed fail identically.

## Reproducer

`issues/repros/2026-10-24-an-rc-handle-cannot-be-lent-as-mut-to-a-generic-parameter.yo`:

```yo
{ println } :: import("std/fmt");
set_mono :: (fn(dst : &mut Rc(i32), v : Rc(i32)) -> unit)({
  dst = v;
});
set_gen :: (fn(generic(T : Type), dst : &mut T, v : T) -> unit)({
  dst = v;
});
main :: (fn() -> unit)({
  mut(r) := rc(i32(1));
  set_mono(&mut r, rc(i32(2)));
  println(&r.*);
  set_gen(&mut r, rc(i32(3)));
  println(&r.*);
});
export(main);
```

```text
Cannot lend `r` as `&mut`: it is in the payload of the `Rc` handle `r` (`Rc(i32)`), and an `Rc`'s payload is shared, so it is read-only through the handle, as Rust's (plans/VALUES_BY_DEFAULT.md decision 46). ...
```

## Root cause

`reject_write_through_rc` (`src/evaluator/utils.yo`) treats a `&mut` argument
whose place is an `Rc` handle as auto-dereferenced (so the payload is what is
lent) whenever the parameter's type is not itself an `Rc`. That is right for a
receiver: `xs.push(x)` on an `Rc(ArrayList(T))` finds `push` on the payload. The
call path (`src/evaluator/calls/function.yo`) passes the parameter's declared
type, and for a generic `dst : &mut T` that is the unresolved binder `T`, a
`SomeT`. `T` is not an `Rc`, so the handle was taken to be dereferenced, but a
plain argument for a bare binder is never dereferenced: inference binds `T` to
the argument's own type, `Rc(i32)`, and the handle itself is lent.

## Fix

`reject_write_through_rc` counts a bare generic binder as taking the handle
for a plain argument (`kind == "mut-arg"`), as an `Rc`-typed parameter already
did. A receiver keeps the old rule: a method found on the payload may have a
bare `Self` binder, and there the payload is what is lent. A place under the
handle (`&mut h.n`, `&mut h.*`) is found by `place_rc_handle` before the
parameter type is consulted, so it stays E0919 for a generic parameter too.

Tests:

- `tests/rc.test.yo`: a generic `&mut T` rebinding a local handle and a
  struct field holding one (the other handle still sees the old cell), and
  `&mut h.n` / `&mut h.*` through the same generic parameter still E0919.
- `tests/move_only.test.yo`, "std/mem: an Rc place": `replace` and `swap` on a
  local handle and a handle field, counting the payloads' drops.
