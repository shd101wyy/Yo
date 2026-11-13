# A blanket `ToString` impl over `&T` answers an `Rc` receiver whose payload has the method

**Severity:** S2 — adding a blanket `impl(generic(T), where(T <: ToString), &T, ToString(...))` makes `${r}` on an
`r : Rc(String)` a compile error (E0616), although `Rc(String)` does not implement `ToString`; G2 piece 3's
`ToString(&T)` therefore breaks the compiler's own `src/evaluator/types/synthesizer.yo` and cannot be added to std

Found 2026-11-13 by the `g2` lane rehearsing G2 piece 3 (VERDICTS-49, VERDICTS-58 decision 17) on the v0.2.77 seed.
The seed's evaluator is develop's, so the tree compiler behaves the same.

## Reproducer

With the blanket added to `std/fmt/to_string.yo` (G2 piece 3's placement):

```yo
impl(
  generic(T : Type),
  where(T <: ToString),
  &T,
  ToString(
    to_string : (fn(self : &Self) -> String)(T.to_string(self.*)),
    append_to : (fn(self : &Self, out : &mut String) -> unit)(T.append_to(self.*, out))
  )
);
```

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
mk :: (fn() -> Rc(String))(Rc.new(String.from("x")));
main :: (fn() -> unit)({
  r := mk();
  println(`a ${r} b`);
});
export(main);
```

```
error[E0616]: "append_to" is a method of Rc(String) and of its payload String, so r.append_to(...) could mean either
(plans/VALUES_BY_DEFAULT.md decision 32).
  --> ts1.yo:6:11
```

Without the blanket the program prints `a x b`: `Rc(String)` has no `append_to` of its own, so the call auto-derefs to
the payload's. The same error in `src` is at `synthesizer.yo:1283`, `${ee.module_path()}` (an `Rc(String)` result),
the only such site in the tree (89 reports, one per importer).

## Root cause

R-PROBE consults the reference lookups when a bare-binder blanket registers the method (`reference_blanket_method_noted`,
VERDICTS-50 index (ii)); at the `&R` step the blanket's pattern `&T` matches `&Rc(String)` with `T := Rc(String)`, and
the candidate is kept without the impl's `where(T <: ToString)` being judged, so `Rc(String)` appears to have its own
`append_to` and decision 32's wrapper/payload check (`_reject_wrapper_payload_clash`) fires. A blanket candidate whose
`where` does not hold at the probed type must not be a candidate (the clash check and the winner both).

## What it blocks

G2 piece 3's `ToString(&T)`: the v0.2.77 seed cannot stage-1-check `src` with it in std, so per the schedule's rule
`ToString` over `&T` moves to v0.2.79, behind a fix here and a seed carrying it. `Eq(&T)` and `Ord(&T)` land without it.

## Test that will pin it

`tests/impl_ref.test.yo`: a user blanket of a user trait over `&T` with a `where` bound, beside an `Rc(C)` receiver whose
payload has the method and whose `C` does not meet the bound; the call auto-derefs to the payload.
