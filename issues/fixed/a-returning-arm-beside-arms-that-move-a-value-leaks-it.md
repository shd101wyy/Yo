# A returning arm beside arms that move a value leaks it

**Severity:** S2: a leak of a move-only value on a `return` path (a resource
is never released).

> Found 2026-10-09 by the adversarial review of the partial-move drop
> elaboration. Pre-existing: the v0.2.54 seed leaks the same way.

## Reproducer

```yo ignore
_Fd :: struct(n : i32);
impl(_Fd, Dispose(dispose : (fn(imm(self) : Self) -> unit)(())));
take :: (fn(f : _Fd) -> i32)(f.n);
f :: (fn(k : i32) -> i32)({
  a := _Fd(n : i32(60));
  cond(
    (k == i32(0)) => take(a),
    (k == i32(1)) => {
      return(i32(77));
    },
    true => take(a)
  )
});
```

`f(i32(1))` returns without disposing `a`.

## Root cause

Every arm that reaches the join moves `a`, so the join marks it moved at the
first arm's move token. The early-return pass (`_attach_early_return_only_drop_to_returns`,
`src/evaluator/exprs/begin.yo`) gives a `return` the drop only when the
return lies before that token, and the returning arm comes after the first
arm in the source, so its `return` got no drop. The returning arm is not in
the join's `bodies`, so nothing else drops `a` there.

## Fix

`merge_and_check_envs` (`src/evaluator/utils.yo`) receives the whole branch and
marks the value moved at the branch's END, both when every reaching arm moves
it and when only some do. Every `return` inside the branch is then before the
mark, and the flow log decides: a return after a move in its own arm sits in
that arm's `UndoneMove` window and gets no drop, any other return does.
`tests/move_only.test.yo`, "a returning arm beside arms that move a value
drops it at the return", counts the disposals on every path.
