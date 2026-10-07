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

An explicit `return` flushes the pending function-scope drops through
`_keep_pending_drop` (`src/codegen/exprs/return.yo`). Its last gate keeps a drop
only when the target's `initialized_at_token` comes before the return. A
parameter has NO initialization token, because it is live from the function's
entry. The `.None` arm answered `false`, so every owned parameter's drop was
filtered out of every explicit early return. The effect-escape path skips that
gate, which is why its `if (__yo_effect_escaped)` block did release `u`. The
fall-through end uses the scope-end flush, so it was correct.

## Fix

A binding with no initialization token is kept when it is a parameter, or an
`FnOnce` closure's owned capture (the same function-scope kind of drop,
tagged `is_fnonce_capture_drop`).

## Verification

`tests/fn_once.test.yo` adds two tests. "an early return drops the captures the
body did not move" covers the `FnOnce` case, and "an early return releases an
owned parameter it did not move" covers the plain `sink` parameter case. Both
fail before the fix and pass after it.
