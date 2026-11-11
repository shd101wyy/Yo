# A `{ p }` capture of a reference parameter carries no origin, so the closure escapes its argument

**Severity:** S1. `mkd :: (fn(p : &Rc(S)) -> Dyn(Fn() -> usize))(dyn({ p }() => p.*.*.a.len()));` passes `yo check`:
the closure copies the reference into its capture record, is boxed and returned, and is called after the argument's
root has died (ASan: stack-use-after-scope; the `Impl(Fn)` form: heap-use-after-free). New with #1891 (capture PR1,
2026-11-11): v0.2.76 and develop before it reject the capture itself with E0926.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A9). Confirmed on develop `64f33c710`. Fix lane:
`fix/capture-param-origin`.

## Reproducers

`issues/repros/2026-11-11-a-capture-of-a-reference-parameter-carries-no-origin-so-the-closure-escapes-its-argument.yo`
(negative, expects E0909):

```yo
mkd :: (fn(p : &Rc(S)) -> Dyn(Fn() -> usize))(dyn({ p }() => p.*.*.a.len()));
main :: (fn() -> unit)({
  (mut(d) : Dyn(Fn() -> usize)) = dyn({}() => usize(0));
  {
    h := Rc.new(S(a : String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz")));
    d = mkd(&h);
  };
  println(`OUT: ${d().to_string()}`);
});
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: E0926 "`p` is a reference (`&Rc(S)`) …"
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: stack-use-after-scope
```

- `…-impl-result.yo` (negative, expects E0909 until P4, then E0911 at the caller's write):
  `mk :: (fn(p : &Rc(S)) -> Impl(Fn() -> usize))({ p }() => p.*.*.a.len());`, the caller reassigns `h` while the
  closure lives: heap-use-after-free.
- `…-pos.yo` (positive control): the closure over the parameter is called inside the function and never leaves it.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `dyn({ p }() => …)` returned as `Dyn(Fn(...))`, `p : &T` a parameter | accepted, UAF | E0909 |
| `{ p }() => …` returned as `Impl(Fn(...))`; the caller then writes the argument's root | accepted, UAF | E0909 (E0911 at the write once P4 lands) |
| a `self : &Self` method returning `dyn({ self }() => …)` or `{ self }() => …` | accepted, UAF | E0909 |
| the same with a `&String` parameter; the caller writes the root | accepted; the closure reads the new value | E0909 |
| `{ y }() => …` where `y := &x` is a LOCAL reference binding, returned or boxed | E0909 | E0909 |
| a holder / `Option(&T)` capture returned or boxed | E0909 / E0912 | — |

## Root cause

VERDICTS-44 R-CAP-2: a by-value capture of a reference contributes the reference's origin to the closure, and "a
parameter-rooted reference contributes the parameter's origin". `_capture_origin_borrows`
(`src/evaluator/values/anonymous_function.yo`, added by #1891) skips a root that names no binding of the current
scope ("`bind` already judged it"). A reference PARAMETER's origin is the parameter's lent place, which is not a
binding `bind` registered, so the capture contributes nothing: the closure is `Escapable`, it is not second-class,
`return_check` sees no origin to compare with the result, and R-CALL at the caller has no result origin to
substitute the argument into.

## Expected

The closure's origin is `{(p, &)}`, the parameter's place. Until P4 (first-class closures) lands that makes it
second-class: E0909 at the `dyn(...)` and at the return. After P4: returning it as `Impl(Fn(...))` is legal, the
caller's argument root stays frozen while the result lives (E0911 at the write), and `Dyn(Fn(...))` without an
origin still rejects it (its payload must be `Escapable`).

## Test

With the fix: the two negative programs and the positive control move to `tests/origins/unsound/`; rows in
`tests/closure_capture_list.test.yo` and corpus rows beside `closure-ref-capture-returned-over-local`.
