# A closure that returns its reference parameter is E0912: `opt.as_ref().map(s => s)` names "a local"

**Severity:** S3 — a correct program is rejected: a closure whose result is its own `&T` parameter (Rust's `opt.as_ref().map(|s| s)`) is E0912 "the origin names a local of this function".

Filed 2026-11-27 by the `v81-s1` lane from VERDICTS-93 §6 finding 3 (probes `p2`, `p3`, on the installed v0.2.80 with the
S-1 std, under both callback slots).

## Reproducer

`issues/repros/2026-11-27-a-closure-that-returns-its-reference-parameter-is-e0912.yo`:

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");
main :: (fn() -> unit)({
  mut(opt) := Option(String).Some(String.from("hello"));
  r := opt.as_ref().map(s => s);
  n := match(r, .Some(s) => s.len(), .None => usize(0));
  opt = Option(String).None;
  println(`${n} ${opt.is_some()}`);
});
export(main);
```

```text
error[E0912]: Cannot return a value holding `s`: the origin names a local of this function, and a result may name only origin parameters or reference-typed parameters' places (decision 43, plans/backlog/REFERENCES_AND_ORIGINS.md O3).
```

## Root cause

The closure's parameter `s` is typed by the slot as a by-value `a : T` with `T := &String`, so the return check treats `s`
as a by-value local of the closure and its value's origin as that local, instead of the origin the `&String` it holds
carries (the caller's `opt`). `docs/en-US/FUNCTIONS.md` admits a closure literal "whose body yields `&place` reached from its
own parameters" at a projection slot (`Fn(s : &T) -> &U`); a by-value parameter of a reference type is the other half of
that rule and is not handled.

## Fix

In the closure's return check, a by-value parameter whose type is a reference contributes the origin its type carries
(per call, the argument's), not the parameter's own place.
