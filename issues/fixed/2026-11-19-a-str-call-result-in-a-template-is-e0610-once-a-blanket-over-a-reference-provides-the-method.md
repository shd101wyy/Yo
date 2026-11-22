# A `str` call result in a template is E0610 once a blanket over `&T` provides the method

**Status:** FIXED 2026-11-20 on `v0279/blanket-tostring` by VERDICTS-69's probe order (see "Fix" below).

**Severity:** S2 — with std's planned `impl(generic(T), where(T <: ToString), &T, ToString(...))` in place, `${f()}`
where `f` returns `str` (the legacy value `str`, a `&str` value) is rejected with E0610, so the compiler's own
`src/evaluator/utils.yo` (`${_lb_verb(kind)}`) stops `check ./src`; a `&String` call result and a bound `str` local are
unaffected.

Found 2026-11-19 by the ToString lane rehearsing the blanket (`v0280-deref-bin/blanket-hash-tostring.patch`, its
`std/fmt/to_string.yo` half) after fixing
`issues/fixed/2026-11-13-a-blanket-tostring-impl-over-a-reference-answers-an-rc-receiver-whose-payload-has-the-method.md`,
whose E0616 had masked it (`check ./src` stops each importer at its first error). Develop `d8f0d89fa` behaves the same
with the blanket applied, so it is not caused by that fix.

## Reproducer

With the blanket in `std/fmt/to_string.yo`:

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
verb :: (fn(k : i32) -> str)(cond((k == i32(0)) => "read", true => "write"));
main :: (fn() -> unit)({
  println(`a ${verb(i32(0))} b`);
});
export(main);
```

```
error[E0610]: `append_to` is implemented for the reference type `&str` with a receiver slot `&&str`, and
`verb(i32(0))` is not a reference binding whose own storage the call could lend: bind the reference to a local first
(`r := &verb(i32(0)); r.append_to(...)`), or call it qualified (`Trait.append_to(&r, ...)`).
```

Without the blanket it prints `a read b`. `v := verb(i32(0)); println(`a ${v} b`)` prints it with the blanket too.

The same with today's std, through a user trait (E0610 for `wh`, slot `&&str`; expected `4`):

```yo
{ println } :: import("std/fmt");
Wh :: trait(wh : (fn(self : &Self) -> usize));
impl(str, Wh(wh : (fn(self : &Self) -> usize)(self.len())));
impl(generic(T : Type), where(T <: Wh), &T, Wh(wh : (fn(self : &Self) -> usize)(T.wh(self.*) + usize(100))));
verb :: (fn(k : i32) -> str)(cond((k == i32(0)) => "read", true => "write"));
main :: (fn() -> unit)({
  println(verb(i32(0)).wh());
});
export(main);
```

## Root cause

`_find_receiver_method_of` (`src/evaluator/calls/function.yo`) has the Q-B arm (`unsized_legacy_spellings`,
VERDICTS-62 decision 5): a `&str` VALUE receiver "with no method of its own" selects `str`'s methods, its value filling
the `&Self` slot. The blanket gives `&str` a method of its own (`append_to` at `T := str`, slot `&&str`), so the arm no
longer fires; R-PROBE's value-receiver filter keeps only candidates whose impl receiver is a reference (the blanket),
and its `&&str` slot needs the receiver's own storage, which a call result does not have
(`_lend_reference_receiver_at_double_slot`, E0610).

## Fix

VERDICTS-69 (Fable, adopted) rejected the recommendation below as a patch: the discriminator is the receiver slot,
not whether the impl is a blanket (a concrete `impl(&str, Wh)` taking `self : &Self` reproduces the same E0610, and
`rr.*.wh()` on `rr : &&C` breaks the same way). A receiver of type `&U` probes the slot `&U` first, then `&&U` (only a
binding can lend its storage, else E0610), then deref, so an impl over references never shadows the referent's own
method. In `src/evaluator/calls/function.yo`:

- The Q-B arm fires unless `&str` has a candidate at the slot `&str` (`_has_slot_step_zero`, probe step 0) and `str`
  has the method, so `str`'s own method (slot `&str`) wins over `&&str` candidates; a method of `&str` alone stays the
  answer.
- R-PROBE's value-receiver filter keeps a reference impl's candidate only when no dropped candidate of the referent
  has an earlier step; otherwise `hits` is left empty and the deref step answers. A tie at the same step keeps both, so
  two trait methods are E0616 and an inherent method wins.

With the ToString half of the blanket patch applied, `check ./src` is 273/273.

## Recommendation (superseded by VERDICTS-69)

The arm's question is whether the receiver's method comes from `str` or from an impl written for references. Read "no
method of its own" as "no method other than a reference blanket's" (a candidate whose impl pattern is `&T` or `T`,
`_is_blanket_receiver_pattern`), so `str`'s own `append_to` (slot `&str`, filled by the value) answers first, as it did
before the blanket and as Rust's by-value probe step would. The arm is deleted with S3b-`str`; until then a seed that
must check `src` against a std carrying the blanket needs this fix: binding the `src` sites to locals is not one edit
(with `${_lb_verb(kind)}` bound, `check ./src` stops at the next placeholder on the same line, `${_lb_mode(info)}`, 135
reports again; every `str`-returning call inside a template is a site).

## Test

`tests/impl_ref.test.yo` `(vii-d)`: VERDICTS-69's six rows (a `str` call result beside a blanket over `&T` and beside
a concrete `impl(&str, …)`; a `str` binding and the blanket's qualified call; a method of `&str` alone at `&&str`, E0610
for a call result; two methods at the slot `&str`, E0616; `rr.*.m()` on `rr : &&C`).
