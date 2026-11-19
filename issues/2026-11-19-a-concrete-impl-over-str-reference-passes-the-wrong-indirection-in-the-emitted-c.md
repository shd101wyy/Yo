# A concrete `impl(&str, …)` method passes the wrong indirection in the emitted C

**Severity:** S2: a program the evaluator accepts fails in the C compiler — a call to a `self : &Self` method of a
concrete `impl(&str, Tr)` passes the `&str` value (`__yo_str`) where the `&&str` slot (`__yo_str *`) is expected, and
inside such a method `str.m(self.*)` passes `self` (`__yo_str *`) where `str`'s `&str` slot (`__yo_str`) is expected.

Found 2026-11-19 by Fable's VERDICTS-69 probes (`c.yo`), confirmed by the ToString lane on develop `d8f0d89fa`. The
generic blanket `impl(generic(T), where(T <: Tr), &T, Tr(...))` at `T := str` compiles and runs (`(&str).wh(&v)` is
`104`), so the defect is in the concrete `&str` impl's lowering, not in the slot rule.

## Reproducers

Both directions (C compiler: "passing '__yo_str' to parameter of incompatible type '__yo_str *'" at the call and
"passing '__yo_str *' to parameter of incompatible type '__yo_str'" in the body; expected `104`):

```yo
{ println } :: import("std/fmt");
Wh :: trait(wh : (fn(self : &Self) -> usize));
impl(str, Wh(wh : (fn(self : &Self) -> usize)(self.len())));
impl(&str, Wh(wh : (fn(self : &Self) -> usize)(str.wh(self.*) + usize(100))));
main :: (fn() -> unit)({
  v := "read";
  println((&str).wh(&v));
});
export(main);
```

The call half alone, through a binding that lends its storage (expected `5`):

```yo
{ println } :: import("std/fmt");
M :: trait(m : (fn(self : &Self) -> usize));
impl(&str, M(m : (fn(self : &Self) -> usize)(usize(5))));
verb :: (fn(k : i32) -> str)(cond((k == i32(0)) => "read", true => "write"));
main :: (fn() -> unit)({
  v := verb(i32(0));
  println(v.m());
});
export(main);
```

## Root cause (not yet traced)

`&str` is the legacy value `str` (a fat pointer, `__yo_str`), so `&&str` is `__yo_str *`. Codegen for a concrete impl
over `&str` appears to treat `Self = &str` as `str` (the unsized pointee) at the argument boundary in both directions:
the address-of for the `&Self` slot is not emitted at the call, and the `.*` of `self : &Self` is not emitted when it is
passed on. The blanket path specializes `Self` from the receiver and gets both right.

## Test that will pin it

`tests/impl_ref.test.yo`: both reproducers, asserting `104` and `5`.
