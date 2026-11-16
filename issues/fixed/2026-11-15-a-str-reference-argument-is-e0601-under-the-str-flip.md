# A `&str` argument is E0601 under the `str` flip: the literal and the `&str` binding arrive as references where the slot lends a `str` place

**Severity:** S2. On the `str` flip's tree binary (decision 49 S2, `vbd/d49-str`; never on develop), every
program failed `yo check` in the prelude: `str.len`'s body `__yo_str_len(self)` was E0601 "Cannot unify
incompatible types: "str" and "&str"", and so was a literal passed to any `(s : &str)` parameter. No valid
program could be checked, so nothing past the prelude was reachable.

Filed 2026-11-15 by the d49-str lane, fixed on the same branch before it was opened.

## Reproducer

```yo
impl(str, byte_count : (fn(self : &Self) -> usize)(__yo_str_len(self)));
count :: (fn(s : &str) -> usize)(s.len());
main :: (fn() -> unit)({
  s := "abc";
  _ := (__yo_str_len("abcd"), count(s), s.byte_count());
});
export(main);
```

## Root cause

A `(x : &T)` parameter takes a PLACE of type `T`: its argument is evaluated against the pointee `T`, and a
reference binding `r : &T` passed bare reads as the place it refers to. Under the flip the pointee of `&str` is the
unsized `str`, and two of the flip's own rules handed the slot a reference instead:

1. A runtime string literal lowered to `&(str, static)` whatever it was expected to fill
   (`convert_comptime_type_to_runtime_type_with_expected`, `src/types/env_lookup.yo`), so a literal at a `&str`
   slot was a reference where the slot expects the `str` place.
2. A `&str` binding or field read as the reference itself in every position (the value-`str` arm A2,
   `src/evaluator/exprs/identifer_and_operator.yo` and `src/evaluator/exprs/property_access.yo`), including the
   positions where `r : &T` reads as its place: a receiver, a lend to a reference slot, and the place a `&str`
   slot expects. `self` in `str.len`'s body was such a lend.

The extern declaration was a red herring of the first probe (both an extern and a Yo function fail the same way).

## Fix

A literal expected as the bare `str` is that place (static bytes; codegen renders the same `__yo_str` value), and a
`&str` binding or field reads as the `str` place at a receiver, at a lend (`deref_is_exempt`) and where a bare
`str` is expected; every other position keeps the A2 reading (the reference).

Test: `tests/str.test.yo`, "a &str parameter takes a literal, a &str binding and a receiver" (E0601 in the
prelude on the branch binary before the fix).
