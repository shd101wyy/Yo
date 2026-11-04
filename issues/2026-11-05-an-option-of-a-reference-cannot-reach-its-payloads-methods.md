# An `Option(&T)` cannot reach its payload's methods

**Severity:** S2. A function may return `Option(&T)`, and the body that builds one checks, but the caller cannot use the payload. `unwrap()` fails inside the prelude, and a `match` binding of the payload has none of `T`'s methods, with or without `.*`. Valid programs are rejected, and a std API cannot lend an optional part of its receiver.

**Status:** open. **Owner:** the d43 N2 lane (decision 43 references; its N2b-r residue includes `match-arm-binding-origin`, and its `&Dyn` method-dispatch piece is related). **Found:** 2026-11-05, implementing VERDICTS-20 §3's `ParsedArgs.get_subcommand_args -> Option(&ParsedArgs)` (V5 part B, `vbd/v5-part-b-std`). Develop `ac14b5d50`.

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
  a := h.get().unwrap().len();                                 // 1
  b := match(h.get(), .Some(p) => p.len(), .None => usize(0));   // 2
  c := match(h.get(), .Some(p) => p.*.len(), .None => usize(0)); // 3
});
export(main);
```

1. `h.get().unwrap()`: E0601 "Expected: `*(P)`, Actual: `&P`", raised in `std/prelude.yo`'s `Option.unwrap` (`.Some(value) => value`).
2. `.Some(p) => p.len()`: E0610 "No method `len` on `&P`".
3. `.Some(p) => p.*.len()`: E0610 "No method `len` on `(p.(*))`".

## Expected

An `Option(&T)` payload is a reference with the origin of the value it was lent from (REFERENCES_AND_ORIGINS O2/O3). `unwrap` returns the `&T`, and a binding of it reaches `T`'s methods as any `&T` binding does.

## Interim in std

`ParsedArgs.get_subcommand_args` returns `Option(ParsedArgs)`, a clone (`derive(ParsedArgs, Clone)`), until this is fixed. Then it flips to `Option(&ParsedArgs)` as VERDICTS-20 §3 specifies. `tests/cli/arg_parser.test.yo`'s subcommand tests are the regression test for the flip.
