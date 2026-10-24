# An FnOnce call with an argument, used as an operator operand, is E0910

**Severity:** S2: a valid program is rejected with a false E0910 ("This argument moves `f`, which an earlier argument of the same call lends to it"), and `tests/fn_once.test.yo` fails to compile as a whole (0 of 23 tests run). The workaround is to bind the call's result first (`n := f(true); n == usize(3)`).

**Status:** open. **Found:** 2026-10-24, on develop `27431e4be` (#1573, which extended E0910 to deref and element receivers), while running the B12 Tier 1 selection (`feat/b12-dyn-gen-a`). The develop binary built from `27431e4be` fails the same way, so B12 did not cause it.

## Reproducer

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");
take :: (fn(sink(s) : String) -> usize)(s.len());
main :: (fn() -> unit)({
  s := String.from("abc");
  (f : Impl(FnOnce(go : bool) -> usize)) = ({ s }(go : bool) => take(s));
  println(f(true) == usize(3));
});
export(main);
```

```text
error[E0910]: This argument moves `f`, which an earlier argument of the same call lends to it (`f(true)`): the arguments are evaluated in order, so the callee would read and write a place whose value was already moved out and dropped (decision 28's argument exclusivity, plans/VALUES_BY_DEFAULT.md).
```

The same call with no argument (`f() == usize(3)`), or bound to a local first (`n := f(true);`), checks clean.

## Root cause (not yet confirmed)

The call `f(true)` consumes `f` (an `FnOnce` call moves its closure). Inside the operator call `==(f(true), usize(3))`, the argument-exclusivity check seems to see `f` both as a lent place (the callee position of the inner call, reached as a receiver by #1573's new deref/element receiver walk) and as a moved one (the consuming call), and reports the overlap of the operand with itself.

## Test

`tests/fn_once.test.yo`, "FnOnce: an early return drops the captures the body did not move" (`assert(f(true) == i32(5), ...)`), fails to compile before a fix and must pass after it.
