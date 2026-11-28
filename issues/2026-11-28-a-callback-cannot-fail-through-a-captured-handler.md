# A callback cannot fail through a captured handler

**Severity:** S3 — expressiveness: a closure passed to a higher-order function may not capture a handler even when it cannot escape, so the everyday shape "fail from inside the callback" (`each(xs, x => raise(...))`) is rejected; the workaround is a loop in the handler's own frame or a callback that returns a `Result`.

- Filed: 2026-11-28, finding F7 of VERDICTS-95 (Fable 5.2, §7), with its probe `q10`.
- Status: open, not fixed: retired with the mechanism at E-5 of [`plans/backlog/ERRORS_AS_VALUES.md`](../plans/backlog/ERRORS_AS_VALUES.md) (VERDICTS-96 §5). `ctl` and `unwind` are deleted, and this doc moves to `issues/retired/` with E-5.

## Reproducer

`issues/repros/2026-11-28-a-callback-cannot-fail-through-a-captured-handler.yo`:

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");
{ ArrayList } :: import("std/collections/array-list");
Raise :: (ctl(msg : &String) -> i32);

each :: (fn(xs : &ArrayList(i32), f : &mut Impl(FnMut(x : i32) -> unit)) -> unit)({
  mut(i) := usize(0);
  while(i < xs.len(), {
    f(xs.get(i).unwrap_or(i32(0)));
    i = (i + usize(1));
  });
});

// the everyday higher-order use: fail from inside the callback
sum_positive :: (fn(xs : &ArrayList(i32), raise : Raise) -> i32)({
  mut(sum) := i32(0);
  (mut(f) : Impl(FnMut(x : i32) -> unit)) = ({ &mut sum }(x : i32) => {
    if(x < i32(0), {
      _ := raise(`negative`);
    });
    sum.* = (sum.* + x);
  });
  each(xs, &mut f);
  sum
});

main :: (fn() -> unit)({
  (raise : Raise) = (
    msg -> {
      unwind(());
    }
  );
  mut(xs) := ArrayList(i32).new();
  xs.push(i32(1));
  xs.push(i32(-2));
  println(`sum=${sum_positive(&xs, raise)}`);
});
export(main);
```

`yo check` (v0.2.80, its bundled std, 2026-11-28), rc 1:

```text
error: Closures cannot capture a value of control-bound type. The captured value `raise` has type `ctl(msg : &String) -> i32` which transitively contains a `ctl(...) -> ret` function. Closures can escape their enclosing frame, taking the captured control function with them — which would unwind to a dead install frame.

Pass `raise` as a regular function parameter instead of capturing it in a closure.
   --> issues/repros/2026-11-28-a-callback-cannot-fail-through-a-captured-handler.yo:19:12
   |
19 |       _ := raise(`negative`);
   |            ^^^^^
yo: error: check: 1 file(s) failed evaluator coverage
```

Expected: accepted. `f` is a local lent to `each` by `&mut` and cannot outlive `sum_positive`'s frame, which is inside `main`'s.

## Root cause

As VERDICTS-95 §7 states it, rule 4 of `docs/en-US/ALGEBRAIC_EFFECTS.md` ("Closures cannot capture control-bound values … the closure could escape its enclosing frame") rejects every capture, because the escape rules have no way to tell a closure that can escape from one that cannot. The predicate is positional (`type_is_control_bound`), not origin-based.

## Fix

Not built (VERDICTS-96 §5): with errors as values a callback fails by returning a `Result`, and E-5 deletes the mechanism. The repair the doc was filed with, K-7 of [`plans/archive/CAPABILITIES_AND_HANDLERS.md`](../plans/archive/CAPABILITIES_AND_HANDLERS.md), was:

K-7: a handler value carries its installer's origin, so a closure that captures one carries it too, and O3, O4 and O10 reject only the closures that actually escape. With P4 (second-class closures) a non-escaping closure may capture a handler. The diagnostic's help stays valid until then.

## Test

None: the limitation is not lifted. Its reproducer stops compiling at E-5, when `ctl` and `unwind` leave the language.
