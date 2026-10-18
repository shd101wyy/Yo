# A borrowed projection of a move-only value is disposed twice

**Severity:** S1 — double dispose (a double free for a `Box` or a buffer-owning part) on every call that lends a projection through an `Rc` to a callee whose mutation summary is unknown, such as a recursive call.

**Status:** fixed 2026-10-12 on `feat/vbd-v1-step2-box` (V1 step 2). Found while
testing the unique `Box`: a recursive `sum(&l.*)` over a `Box` tree freed
every inner cell. It reproduces on the v0.2.59 seed through an `Rc`.

## Reproducer

```yo
{ eprintln } :: import("std/fmt");
(g : i32) = i32(0);
Fd :: struct(n : i32);
impl(
  Fd,
  Dispose(
    dispose : (fn(self : &Self) -> unit)({
      g = (g + i32(1));
    })
  )
);
rec :: (fn(x : &Fd, n : i32) -> i32)(
  cond(
    (n == i32(0)) => x.n,
    true => {
      r := rc(Fd(n : x.n));
      rec(&r.*, n - i32(1))
    }
  )
);
main :: (fn() -> unit)({
  {
    a := Fd(n : i32(1));
    eprintln(rec(&a, i32(2)));
  };
  eprintln(&g); // 3 expected (a and two cells); printed 5
});
export(main);
```

## Root cause

Aliasing Stage 0 (`consume_argument_for_parameter`, 4c) gives a projection
through an `Rc` passed to a borrowing parameter a caller-owned +1 for the
call, unless the callee's mutation summary proves it read-only (Stage 1). A
recursive callee has no summary yet, so the mark is taken.
`set_expr_as_needs_to_call_dup_for_borrowed_projection` dups the projected
value and drops it after the call. For a move-only value the dup is a bit
copy (a `Dispose` part, a `Box` cell, has nothing to count), and the drop
disposes the borrowed value's parts: once per call.

## Fix

`set_expr_as_needs_to_call_dup_for_borrowed_projection` (`src/evaluator/utils.yo`)
takes no +1 for a move-only value: the projection is lent as the place itself.
The same guard landed on develop independently in #1325
(`issues/fixed/a-method-call-on-a-move-only-element-disposes-a-copy-of-it.md`,
a method call on a move-only list element). That fix covers the `inout`-aliased
`force` path too, and this branch took it when it rebased. This doc keeps the
`Rc`-projection and recursive-call trigger and its regression tests.

### What the fix trades, and what it leaves

- **The trade.** The +1 was meant to keep a borrowed projection alive while the
  callee runs. With no +1, a callee that holds `x : &Fd` (lent from `r.*`) and
  replaces the payload through another alias of the same `Rc` disposes the
  value `x` names, and then reads a disposed value. Before the fix, every such
  call disposed the payload twice, aliased or not. The remaining case is
  the exclusivity gap of `plans/VALUES_BY_DEFAULT.md` §3.10: a shared borrow
  and a write through another handle to the same cell. It closes with V2c
  (shared `Rc` handles) and the §3.10 exclusivity check, not here.
- **The `inout`-aliased `force` path** runs when the same call also lends the
  projection's root as `&mut`. It takes no +1 for a move-only value either.
  Probed 2026-10-12 with the tree compiler: `f(&r.*, &mut r)` (`r : Rc(Fd)`)
  and `fb(&b.*, &mut b)` (`b : Box(Fd)`) each dispose their `Fd` exactly
  once. Accepting the call at all, a shared borrow of `b`'s payload next to
  `&mut b`, is the same §3.10 gap. Rust rejects it (E0502).
