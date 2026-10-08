# An early `return` skips the drop of an owned (`sink`) parameter

**Severity:** S2 — an unbounded leak: a function that takes two values by `sink` and returns early after moving one never releases the other (its `Dispose` never runs, an RC payload leaks).

> Found 2026-10-07 by the adversarial review of PR #1266 (decision 37's `FnOnce`), whose capture drops inherit the parameter path. **FIXED same day.**

## Reproducer

```rust
take :: (fn(sink(t) : Tok) -> i32)(t.n);
two :: (fn(sink(t) : Tok, sink(u) : Tok, go : bool) -> i32)({
  if(go, {
    return(take(t));
  });
  take(u)
});
```

`two(Tok(n : 5), Tok(n : 6), true)` disposes 1 `Tok` where it should dispose 2;
`u` leaks. develop's compiler (`v0.2.53`-era tree) behaves the same.

## Root cause

`u` is consumed at the body's tail (`take(u)`), so the function-body drop pass
(`_schedule_scope_end_drops`, `src/evaluator/exprs/begin.yo`) skips it: a
consumed binding gets no scope-end drop. For a consumed LOCAL, the M3 driver
covers the paths that run before the move: it attaches an early-return-only
`___drop` to every `return` that precedes the consumption, and it adds an
effect-escape drop. The parameters-frame pass mirrored only the second half.
It pushed consumed parameters onto `consumed_escape_drops`, which is why the
`if (__yo_effect_escaped)` block released `u`, but it never attached them to
the `return`s. An early return before the parameter's move therefore leaked it.

## Fix

The parameters-frame pass also calls `_attach_early_return_only_drop_to_returns`
for each consumed owned parameter, as the M3 driver does for locals. The new
`FnOnce` capture-frame pass does the same for consumed captures (decision 37).

## Verification

`tests/fn_once.test.yo` adds two tests. "an early return drops the captures the
body did not move" covers the `FnOnce` case, and "an early return releases an
owned parameter it did not move" covers the plain `sink` parameter case. Both
fail before the fix and pass after it.
