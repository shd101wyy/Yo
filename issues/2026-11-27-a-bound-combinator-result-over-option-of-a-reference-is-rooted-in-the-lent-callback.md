# A bound combinator result over `Option(&T)` is rooted in the lent callback: `r := opt.as_ref().filter(p)` is E0911

**Severity:** S3 — a correct program is rejected: binding the `Option(&String)` that `opt.as_ref().filter(s => …)` or `.inspect(…)` returns is R-TEMP E0911 naming the closure literal as the temporary, although the result borrows `opt` and not the predicate.

Filed 2026-11-27 by the `v81-s1` lane (STD_RUST_ALIGNMENT S-1) from VERDICTS-93 §2.4 item 2 and §6 finding 2. It predates
S-1 (`Option.filter` already lent its predicate); S-1's `Option.as_ref` makes it reachable.

## Reproducer

`issues/repros/2026-11-27-a-bound-combinator-result-over-option-of-a-reference-is-rooted-in-the-lent-callback.yo` (needs the
S-1 std for `as_ref`):

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");
main :: (fn() -> unit)({
  opt := Option(String).Some(String.from("hello"));
  r := opt.as_ref().filter(s => (s.*.len() > usize(2)));
  n := match(r, .Some(s) => s.len(), .None => usize(0));
  println(`${n} ${opt.is_some()}`);
});
export(main);
```

```text
error[E0911]: Cannot bind `r` to `((opt.as_ref)().filter)(s => (((s.(*)).len)() > usize(2)))`: its value holds a reference into `s => (((s.(*)).len)() > usize(2))`, a temporary that ends with this statement, while `r` lives on (decision 43, plans/backlog/BORROW_CHECKER_COMPLETENESS.md §3 R-TEMP).
```

`.inspect({ &mut seen }(s) => …)` bound the same way is the same error. The chain consumed in one statement
(`match(opt.as_ref().filter(…), …)`) works, and so does a named predicate lent with `&mut pred`; both are pinned in
`tests/option-result-combinators.test.yo` beside the E0911. A free function or a user method returning `Option(&T)`
followed by the same `filter` binds fine.

## Root cause

`filter : (fn(self : Self, predicate : &mut Impl(FnMut(a : &T) -> bool)) -> Option(T))` with `T := &String`: the result
carries a reference, and with the origin elided it names every reference parameter, so the lent closure temporary counts
as a root of the result. `BORROW_CHECKER_COMPLETENESS.md` §11 records the same defect fixed for `Iterator.find` on
2026-11-09 ("a generic call's by-value result is rooted by its SPECIALIZED type"): the root set should come from the
specialized result type's origins (the receiver's), not from every reference argument.

## Fix

Root a generic call's by-value result by its specialized type's origins, as `find`'s fix did, for the `Option`/`Result`
combinators' lent callback; the pin in `tests/option-result-combinators.test.yo` then flips to accepted. PR P-5 (by-value
`FnOnce` slots) removes the lend altogether.
