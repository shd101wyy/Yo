# An `unwind` type mismatch inside an exception handler was swallowed

**Status: FIXED** (2026-09-23). Found auditing `yo context`
(`plans/YO_CONTEXT.md` C7): `_significant_tokens` in
`src/doc/context_index.yo` handled a lexer throw with `unwind(())` inside a fn
returning `ArrayList(Token)`.

## Symptom (measured, tree-built binary)

```rust
parse_or_zero :: (fn(fail : bool) -> i32)({
  exn := Exception(throw : (_e -> { unwind(()); }));  // unit, not i32
  if(fail, { exn.throw(dyn(`boom`)); });
  i32(7)
});
```

`yo check` passed and `yo compile` exited 0. The binary printed `7` for the
non-throwing call, then died on the first throw:
`yo: FATAL: reached fn_yo_id_…, whose body failed to transpile - its
definition-time evaluation failed and was swallowed` (rc=134).

## Root cause

`unwind` type-checks its value against the ENCLOSING fn's return type and
throws E0601 on a mismatch. The handler is a closure, though, and a closure
body is trial-evaluated at definition time with its errors swallowed
(`YO_DEBUG_SWALLOW=1` showed `[anon-swallow] error[E0601]: Incompatible type
for unwind argument`). That wall exists because a closure body may fail
before its parameter types are known. This mismatch does not depend on them.

## Fix

The four `unwind` mismatch sites (`src/evaluator/exprs/unwind.yo`, and the
statement form in `begin.yo`) go through one helper,
`throw_unwind_type_mismatch`. When both types are concrete, the helper also
flags the flow-violation channel, which the anonymous-function trial
re-raises at check time. The statement form's zero-argument message still
said `escape`, the keyword's old name; it now uses the shared wording.

## Test

`tests/cli-cases/check-unwind-type-mismatch-in-handler`: `yo check` exits 1
with the E0601.
