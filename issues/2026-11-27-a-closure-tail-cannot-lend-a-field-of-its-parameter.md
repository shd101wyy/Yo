# A closure tail cannot lend a field of its parameter: Rust's `.map(|u| &u.name)` has no spelling, and the error is uncoded

**Severity:** S3 — `opt.as_ref().map(u => &u.name)` is rejected by an uncoded error ("`&u.name` lends a borrow … is not an expression of its own"), and no other spelling projects a field reference out of a combinator's item.

Filed 2026-11-27 by the `v81-s1` lane from VERDICTS-93 §6 finding 4 (probe `p4`, under both callback slots).

## Reproducer

`issues/repros/2026-11-27-a-closure-tail-cannot-lend-a-field-of-its-parameter.yo`:

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");
User :: struct(name : String, age : i32);
main :: (fn() -> unit)({
  opt := Option(User).Some(User(name : String.from("ada"), age : i32(36)));
  r := opt.as_ref().map(u => &u.name);
  n := match(r, .Some(s) => s.len(), .None => usize(0));
  println(`${n} ${opt.is_some()}`);
});
export(main);
```

```text
error: `&u.name` lends a borrow: it is written as a call argument to a `&T` parameter, as a `match` scrutinee, as a tuple element, or as a local borrow (`y := &u.name`), and is not an expression of its own. Take a raw pointer with `addr_of(u.name)`; a method receiver is written bare (`u.name.m()`).
```

## Root cause

`&place` is admitted only in the positions the message lists (`src/evaluator/exprs/dispatch.yo`); a function or closure tail
is not one of them, so a projection closure cannot be written as an expression. This is the `&x`-as-an-expression item of
`BORROW_CHECKER_COMPLETENESS.md` P2. Even once a closure returning its `&T` parameter is accepted
(`issues/2026-11-27-a-closure-that-returns-its-reference-parameter-is-e0912.md`), a field of it has no spelling.

## Fix

Under P2: admit `&place` as a closure (and function) tail whose place is reached from a reference parameter, checked by the
return rule. Independently, give this error a code.
