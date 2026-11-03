# A second instance of an origin-parameterized composite names the first one's origin

**Severity:** S2: an invalid program is accepted. A function declared `-> V(a)` may return a holder built over its other parameter `b`, so the caller freezes `a` and not `b`. Nothing reads a reference field before N1e-2, so no run-time access dangles yet. It is still a hole in the return rule that N3's cursors and entries would inherit.

## Reproducer

`issues/repros/2026-11-03-a-second-instance-of-an-origin-parameterized-composite-names-the-first-ones-origin.yo` passes `yo check`. Without `f`, `h` is still accepted, and a two-place probe shows the cause:

```yo ignore
v := V(x)(at : &x, lo : usize(2));
w := V(y)(at : &y, lo : usize(2));
(n : i32) = w; // E0601 "Given: V(origin(x))", where V(origin(y)) is expected
```

## Root cause

N2a's T3 erases origins from the constructor memo (`_arg_vals_equal`), and `_restamp_instance_origins` restamps a memo HIT of the type-constructor call `V(y)`. The struct-construction call `V(y)(at : …)` then canonicalizes its result type through `canonicalize_instantiation_via_ctfe_memo` (`src/evaluator/calls/function.yo:8984`, `:13020`). That function returns the memo's instance as it was first stamped, with the origin of the first call, and so drops the call's own origin.

## Fix

`canonicalize_instantiation_via_ctfe_memo` restamps the instance it adopts with the origins of the type it was given. The fix lands with tests in `tests/borrow_spelling.test.yo` (a second instance's method and the return rule) on decision 43 step 4's branch.
