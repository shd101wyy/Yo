# A bare trait constructor in a `where` bound (`where(T <: Ord)`) is an uncoded error that does not name `Ord(T)`

**Severity:** S3 — the program is correctly rejected, but the message has no code and does not say that `Ord` takes an argument or what to write.

**Found:** 2026-11-26, VERDICTS-87, probe `d3`. Split out of `issues/fixed/2026-11-26-rust-shaped-trait-spellings-get-no-useful-help.md` (its item 3), whose other four items V87-C fixed.
**Owner:** lane v81-v84-pr2 (VERDICTS-84 PR 2, branch `wip/v0281-v84-pr2`), which owns every bound site: the `where` readers, a bare trait constructor on the right of `<:`, and the `(T <: Tr)` expression. That PR moves this doc to `issues/fixed/`.

## Reproducer

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");

bigger :: (fn(generic(T : Type), a : T, b : T, where(T <: Ord)) -> bool)(a > b);

main :: (fn() -> unit)({
  println(`${bigger(i32(2), i32(1))}`);
});
export(main);
```

```text
error: Expected trait type for right-hand side of where clause constraint.
  --> ./d3-bound-bare-ord.yo:3:59
  |
3 | bigger :: (fn(generic(T : Type), a : T, b : T, where(T <: Ord)) -> bool)(a > b);
  |                                                           ^^^
yo: error: check: 1 file(s) failed evaluator coverage
```

## Root cause

`Ord` is a function from a type to a trait (`fn(comptime(Rhs) : ?Sized) -> comptime(Trait)`). The where-clause readers in `src/evaluator/types/function.yo` evaluate the right-hand side, find a function value instead of a type value, and throw the uncoded "Expected trait type" message without saying that the trait constructor needs its argument.

## Fix

A coded error at the bound naming the applied constructor, `where(T <: Ord(T))` (E0603 in v84-pr2's draft), and a cli-case pinning it.

## Fixed (VERDICTS-84 PR 2, #2101)

A bare trait constructor on the right of `<:` is E0603 at the bound, naming the applied constructor (`bare_trait_constructor_bound_error`, `src/evaluator/utils.yo`): "`Ord` takes one type argument, `Ord(Rhs)`, and none was given: a bound names the trait applied, as in `T <: Ord(T)`." V87-C's derive check (`derive(P, Eq)`) reads the same `trait_constructor_params_of` and spells the same message at a derive argument.
