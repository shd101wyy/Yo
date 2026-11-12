# A call's result type keeps its callee's origin names, and `lend_through` reads them in the caller's scope

**Severity:** S1: `yo check` accepts a program that is a heap-use-after-free under ASan; safe code, no `unsafe`, on develop and the v0.2.76 seed. The same mechanism also rejects valid programs with a false E0923.

Found by G-E's totality audit (`YO_AUDIT_ORIGIN_TOTALITY`, O-6 of
`plans/backlog/BORROW_CHECKER_COMPLETENESS.md`): the call-argument sink of a `&mut`
holder had arguments whose origin `lend_through` never computed.

## Reproducer

`tests/origins/unsound/call-result-origin-name-capture.yo`:

```yo
{ println } :: import("std/fmt");
_H :: (fn(comptime(p) : Origin) -> comptime(Type))(struct(r : &(i32, p)));
_store :: (fn(generic(p : Origin), dst : &mut Option(&(i32, p)), v : _H(p)) -> unit)({
  dst.* = .Some(v.r);
});
_mk :: (fn(a : &i32) -> _H(a))(_H(a)(r : a));
main :: (fn() -> unit)({
  a := i32(1);
  (mut(slot) : Option(&(i32, a))) = .Some(&a);
  {
    yb := Box.new(i32(2));
    h := _mk(&yb.*);
    _store(&mut slot, h);
  };
  match(slot, .Some(r) => println(&r.*), .None => ());
  ()
});
export(main);
```

`yo check` accepts it. Compiled with `--sanitize address --allocator system` it
reports `heap-use-after-free` (READ of size 4) at the `println`: `slot` holds a
reference into `yb`'s box, freed at the inner block's end.

The same shape with the caller's binding named `x` instead of `a`
(`(mut(slot) : Option(&(i32, x)))`, `h := _mk(&x)`) is a valid program, and it
is rejected: `` `h` carries origin `a`, outside `x` `` (E0923).

## Root cause

A call's result type is the callee's declared result type, so it names the
callee's scope: `_mk(&yb.*)` is typed `_H(a)`, where `a` is `_mk`'s parameter.
Origins are not specialized per call (a `generic(p : Origin)` binder binds "as
the origin naming itself"), so the name survives into the caller, and `h := …`
stores it in `h`'s type.

`lend_through`'s step 2 (O3 step 3 at a call) compares an argument's SPELLED
origin names with the set the `&mut` holder's type fixes. `h`'s type spells
`a`; the holder's type spells the caller's local `a`; the strings are equal, so
the store of a reference into `yb` is accepted. With any other caller name the
comparison fails, which is the false E0923. An argument whose type leaves an
origin elided (a flow-inferred holder) was skipped entirely by the same step.

## Fix

- A user call's result type has every origin that names its callee's parameters
  or origin binders elided (`elide_callee_origin_names`, `src/evaluator/utils.yo`):
  those names mean nothing at the call. The value's origin is `origin_of`'s
  (R-CALL over the arguments), which `bind` registers for `h`.
- `lend_through`'s step 2 judges an argument position whose origin is elided by
  what the argument holds (`value_origin_names`: `origin_of`'s roots, a
  parameter by its declared slot), never by a type name.

Tests: `tests/origins/unsound/call-result-origin-name-capture.yo` (+ `-pos`),
and in `tests/borrow_spelling.test.yo` the positive (`a call's result holds what
its argument lent, not its callee's names`) and `bs_store_call_result_name_capture`.
