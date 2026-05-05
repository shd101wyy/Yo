# Proto-evaluator: Method dispatch only invoked for StructVal receivers

## Status: Fixed (Phase 3al)

## Summary

The dot-dispatch branch in `yo-self/evaluator/eval.yo` (the `(fval == ".") =>` arm)
only delegated to `handle_method_dispatch` when the receiver evaluated to a
`StructVal`. For all other receiver types (`StrLit`, `TypeVal`, `IntLit`, `BoolVal`,
etc.) the branch returned `Option(EvalResult).None` unconditionally.

This made every shim in `handle_method_dispatch` that handles non-StructVal receivers
completely unreachable:

- Phase 3ai: `StrLit.to_string()`, `StrLit.+(rhs)` (string concat)
- Phase 3aj: `TypeVal.from(s)` (String.from), `TypeVal.new()` (String.new)
- Phase 3ak: `StrLit.as_str()`, `StrLit.len()`
- Phase 3al: `StrLit.starts_with()`, `StrLit.ends_with()`, `StrLit.contains()`

All integration tests added in those phases would fail (return None) because the
dispatch never reached the shims.

## Root cause

In `eval.yo` (~line 2463), the match arm:

```rust
match(recv_res.value,
  .StructVal(_, fnames, fvals) => match(rhs, ...),
  _ => Option(EvalResult).None   // ← BUG: drops all non-StructVal method calls
)
```

The `_ => None` should instead dispatch to `handle_method_dispatch` when the RHS
is a method-call expression (`.FnCall`).

## Fix

Changed the `_ => Option(EvalResult).None` arm to:

```rust
_ =>
  match(rhs,
    .FnCall(_, method_func_box2, method_call_args2, _, _) =>
      handle_method_dispatch(recv_res.value, method_func_box2, method_call_args2, env),
    _ => Option(EvalResult).None
  )
```

This routes all non-StructVal method calls through `handle_method_dispatch`, which
already has the shim dispatch table for `TypeVal` and `StrLit` receivers.

Field access (`.Atom` RHS) on non-StructVal receivers still returns `None`, which
is correct (no field access on primitive values in the proto-evaluator).

## Files changed

- `yo-self/evaluator/eval.yo`: Expanded dot-dispatch `_ =>` arm (Phase 3al fix)
