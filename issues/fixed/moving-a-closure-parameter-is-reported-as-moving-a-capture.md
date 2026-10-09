# Moving a closure's own parameter is reported as moving a capture

**Severity:** S2: a valid program is rejected. Since the flip (V3b
Generation B, `plans/VALUES_BY_DEFAULT.md` decision 30) a closure parameter
typed by value owns its argument, and moving it is ordinary code; the
compiler rejected it with E0913.

> Found 2026-10-09 while probing the fix for
> `issues/fixed/a-closures-by-value-parameter-is-never-dropped.md`.

## Reproducer

```yo
_Res :: struct(n : i32);
impl(_Res, Dispose(dispose : (fn(imm(self) : Self) -> unit)(())));
_run :: (fn(imm(f) : Impl(Fn(r : _Res) -> i32)) -> i32)(f(_Res(n : i32(5))));
main :: (fn() -> unit)({
  a := _run((r) => {
    x := r;
    x.n
  });
});
export(main);
```

```
error[E0913]: Cannot move `r` out of the closure: it is captured implicitly, ...
   --> adv.yo:16:10
```

## Root cause

`_is_implicit_closure_capture` (`src/evaluator/utils.yo`) calls any binding
in a frame below the closure body's frames an implicit capture. A closure's
parameters are bound in its parameter frame, which is also below the body,
so a move of one read as a move of a capture. Before the flip a closure
parameter borrowed, so moving it was an error anyway and the wrong wording
went unnoticed.

## Fix

The closure evaluator marks its parameter frame
(`mark_closure_param_frame`, `src/env.yo`). Walking down from the body, the
first marked frame is the closure's own; its bindings are not captures. A
marked frame further down belongs to an enclosing closure, whose parameters
are captures of this one.

`tests/parameter_modes.test.yo` moves a closure parameter into a local, into
a collection, and out as the result, counting `Dispose` calls.
