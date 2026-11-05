# A holder bound from a generic call freezes nothing past its own statement

**Severity:** S2. An invalid program is accepted: a place is written while a holder that borrows it is still live, when a call that the evaluator specializes at the call site made the holder.

> Found 2026-11-05 while building decision 43 step 4's `Future(T, p)` (N3-1). `s := select(fa, g, io)` over a bound borrowing future did not keep `fa`'s places frozen, and the cause turned out to be N2b's, not the future's.

## Reproducer

```yo
_View :: (fn(comptime(p) : Origin) -> comptime(Type))(struct(x : &(i32, p), k : i32));
_mk :: (fn(generic(T : Type), x : &i32, t : T) -> _View(x))({
  k := i32(1);
  _View(x)(x : x, k : k)
});
main :: (fn() -> unit)({
  mut(a) := i32(1);
  v := _mk(&a, u8(0));
  a = i32(2); // accepted; E0911 is expected: `v` borrows `a` and is used below
  _r := v.x.*;
  ()
});
export(main);
```

The same program with a non-generic `_mk` is E0911.

## Root cause

A borrow binding's live range comes from a look-ahead. `evaluate_begin_expression` hands the binding the statements after it (`local_borrow_set_lookahead`) just before it evaluates the binding, and the binding reads them back when it registers its freeze (`local_borrow_range_of`).

The look-ahead was a single global slot, gated by the binding statement's id. A `generic(...)` callee's body is evaluated at the call, while the right-hand side is being evaluated. Every binding statement in that body armed the slot with its own id. When the outer binding read its range, the id no longer matched, so it fell back to a range that ends at its own statement. The holder then froze nothing past the line that made it.

An earlier comment recorded the same loss for a comptime constructor (`v := View(x)(...)`), and the fix then only made sure that a stale arm could not be read.

## Fix

The look-ahead is now one frame per binding statement (`g_lb_lookaheads`, `src/evaluator/utils.yo`), and a binding finds its own frame by statement id. A nested body's bindings add their own frames instead of replacing the outer one. Frames are replaced when the same statement is evaluated again, and the list is capped at 64 frames: an unread frame belongs to a binding that bound a plain value.

Test: `tests/borrow_spelling.test.yo`, "a holder bound from a generic call stays frozen until its last use" (the positive half), and `bs_generic_holder_freezes` (E0911). On develop `2b9db068d`, the second one fails: the expected error is not raised.
