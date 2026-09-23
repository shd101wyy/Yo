# An `unwind` type mismatch inside an exception handler was swallowed

**Status: FIXED** (2026-09-23). Found auditing `yo context`
(`plans/reference/YO_CONTEXT.md` C7): `_significant_tokens` in
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

## Latent instances the fix exposed

With the mismatch re-raised, `yo check ./src` failed at two sites in
`src/evaluator/calls/function_type.yo`: the verifier's soft evaluation of a
generic fn's `requires` and `ensures` clauses. Each defined
`Exception(throw : ((_err) -> { ...; unwind(()); }))` inline in a fn returning
`AstExpr`, so its `unwind(())` would have exited that fn with `unit`. It was
swallowed, the handler compiled to an abort() stub, and a deferred predicate
that failed to evaluate killed the compiler instead of soft-failing.

Both sites now go through `_soft_evaluated_for_verify`, which gives the
handler a fn of its own to unwind out of (returning
`Option(AstExpr).None`). It also restores `ctx.is_ghost_context`, which the
unwind skips inside `evaluated_for_verify`. The same `yo check ./src` is the
regression gate: it rejects the old shape.

## Test

`tests/cli-cases/check-unwind-type-mismatch-in-handler`: `yo check` exits 1
with the E0601.
