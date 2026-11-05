# An `Option(&T)` cannot reach its payload's methods

**Severity:** S2. A function may return `Option(&T)`, and the body that builds one checks, but `unwrap()` on it fails inside the prelude. Valid programs are rejected.

**Status:** open, narrowed. #1771 (N2g-0, `a4071e380`) fixed repros 2 and 3: a `match` binding of the payload is a reference binding and reaches `T`'s methods. Repro 1, `Option(&T).unwrap()`, is still rejected. **Owner:** the d43 N2c lane. **Found:** 2026-11-05, implementing VERDICTS-20 §3's `ParsedArgs.get_subcommand_args -> Option(&ParsedArgs)` (V5 part B, `vbd/v5-part-b-std`). Develop `ac14b5d50`.

## Reproducer

```yo
pragma(Pragma.AllowUnsafe);
{ ArrayList } :: import("std/collections/array_list");
{ String } :: import("std/string");
P :: struct(s : String);
impl(P, len : (fn(self : &Self) -> usize)(self.s.len()));
Holder :: struct(inner : Option(Box(P)));
impl(
  Holder,
  get : (fn(self : &Self) -> Option(&P))(
    match(&self.inner, .Some(b) => .Some(&b.*), .None => .None)
  )
);
main :: (fn() -> unit)({
  h := Holder(inner : .Some(Box.new(P(s : `abc`))));
  a := h.get().unwrap().len(); // 1
  b := match(h.get(), .Some(p) => p.len(), .None => usize(0)); // 2
  c := match(h.get(), .Some(p) => p.*.len(), .None => usize(0)); // 3
});
export(main);
```

1. `h.get().unwrap()`: E0601 "Expected: `*(P)`, Actual: `&P`", raised in `std/prelude.yo`'s `Option.unwrap` (`.Some(value) => value`). Still open.
2. `.Some(p) => p.len()`: E0610 "No method `len` on `&P`". Fixed by #1771.
3. `.Some(p) => p.*.len()`: E0610 "No method `len` on `(p.(*))`". Fixed by #1771.

## Expected

An `Option(&T)` payload is a reference with the origin of the value it was lent from (REFERENCES_AND_ORIGINS O2/O3). `unwrap` returns the `&T`, and a binding of it reaches `T`'s methods as any `&T` binding does.

## In std

`ParsedArgs.get_subcommand_args` returns `Option(&ParsedArgs)`, as VERDICTS-20 §3 specifies (flipped from an interim clone once #1771 landed). `tests/cli/arg_parser.test.yo`'s subcommand tests read the result through a `match`. Once `unwrap()` works, a test that calls `get_subcommand_args().unwrap()` is the regression test for repro 1.
