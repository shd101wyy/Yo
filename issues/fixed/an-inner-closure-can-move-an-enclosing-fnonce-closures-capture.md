# An inner closure can move an enclosing `FnOnce` closure's capture

**Severity:** S1: a value disposed twice. An `Fn` closure nested in an
`FnOnce` closure that moves the outer closure's by-value capture was accepted,
and each call of the inner closure moved the same value.

> Found 2026-10-09 by the adversarial review of the V3b flip's closure
> changes (in the predicate those changes edit). Pre-existing.

## Reproducer

```yo ignore
Tok :: struct(n : i32);
impl(Tok, Dispose(dispose : (fn(imm(self) : Self) -> unit)(())));
eat :: (fn(t : Tok) -> i32)(t.n);
run_twice :: (fn(imm(g) : Impl(Fn() -> i32)) -> i32)(g() + g());
run_once :: (fn(h : Impl(FnOnce() -> i32)) -> i32)(h());
main :: (fn() -> unit)({
  t := Tok(n : i32(7));
  r := run_once({ t }() => run_twice(() => eat(t)));
});
export(main);
```

It compiled, and `t` was disposed twice. The same shape with the outer value
reaching the inner closure as a closure PARAMETER was already E0913.

## Root cause

`_is_implicit_closure_capture` (`src/evaluator/utils.yo`) exempted every
`FnOnce` capture-list frame below the body from the capture rule, at any
depth. Only the current closure's own capture list holds values its body may
move; an enclosing closure's capture list is, for the inner closure, an
implicit capture like any other.

## Fix

Walking down from the body, the closure's own parameter frame comes first,
then its own capture-list frame, then the enclosing closure's frames. A
capture-list frame is exempt only before an enclosing closure's parameter
frame has been passed. The CLI case
`tests/cli-cases/an-inner-closure-cannot-move-an-enclosing-fnonce-capture`
pins the E0913.
