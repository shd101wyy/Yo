# yo-self: index-trait deref RHS stored without dup (http UAF)

**Status: FIXED** (this commit). Flips `tests/http/http.test.yo` (7/9 → 9/9).

## Symptom

s1-compiled `parse_response` returned `body=""` where TS returns the parsed
body; harder variants SIGTRAP (rc=133). Minimal repro:

```rust
Resp :: ref(struct(code : i32, body : String));
parse :: (fn(raw : String) -> Resp)({
  lines := raw.split(`\r\n`);
  resp := Resp(code : i32(200), body : ``);
  resp.body = lines(usize(3));   // <-- the store
  resp
});
```

Emitted C (before):

```c
resp->body = (*yo_id_..._index(&lines, 3ULL));   // NO __dup
__yo_decr_rc(lines);                              // frees the element
```

TS emits `temp = (*index(...)); temp2 = __dup(temp); resp->body = temp2;`.

## Roots (two stacked, one enabler)

1. **Eval — index arms never attach the non-owning temp.** TS's index-trait
   dispatch ends with `attachTempVariableToExpr(expr, false)`
   (function.ts:2810). Both yo-self index arms
   (`evaluator/calls/function.yo`, FuncVal-callee + valueless-callee) set the
   ExprInfo and returned WITHOUT it → the RHS ExprInfo had no
   `variable_name` → `set_expr_as_needs_to_call_dup` no-ops at its first
   gate. FIX: call `attach_temp_variable_to_expr(expr, false, ctx)` in both
   arms.

2. **Eval enabler — `attach_temp_variable_to_expr` UnknownVal gate.** yo-self
   runtime results are `Some(UnknownVal)` where TS uses `undefined`; TS's
   `isCompileTimeOnly: Boolean(value)` must read UnknownVal as NO value or
   the new non-owning temp is marked compile-time-only (same convention note
   as `set_expr_as_needs_to_call_dup`). FIX: `has_inlinable_value` guard in
   `evaluator/utils.yo`.

3. **Codegen — deferred dup suppressed as undeclared.** With (1)+(2) the dup
   IS built (`deferred_dup_expressions` populated), but
   `generate_deferred_dup_expressions`' undeclared-temp gate silently dropped
   it: the dup's target temp (the index result) is never declared in C. TS's
   assignment codegen declares the RHS temp first (assignment.ts:184-199
   "If RHS has a variable name, we need to declare it first"); yo-self's
   `generate_assignment` skipped straight to `emit_deferred_dup_or_code`.
   FIX: `_rhs_code_with_deferred_dups` in `codegen/exprs/assignment.yo` —
   declare `T <rhs_temp> = <rhs_code>;` via `get_variable_type_string` (the
   declared_c_var_names choke-point), then emit the dup and use its result.

## Landmines recorded

- Any ExprInfo-producing eval arm that RETURNS EARLY (like the index arms)
  must check TS for a trailing `attachTempVariableToExpr` — its absence
  silently disables the whole dup/consume layer for that expression class.
- The `Some(UnknownVal)`-vs-`undefined` convention bites every port of a TS
  `Boolean(value)` / `if (expr.$.value)` gate. Now guarded in BOTH
  `set_expr_as_needs_to_call_dup` and `attach_temp_variable_to_expr`.

## Non-findings

- `tests/encoding/json.test.yo` (24/11) does NOT share this root — still red
  after the fix. Its `json_parse("[1, 2]")` heap corruption is a separate
  bug (see the handoff session update).

## Verification

- Repro: body=[Hello World], rc=0 (was rc=133).
- http.test.yo 9/9 (was 7 passed / 2 failed).
- codegen-bootstrap, check ./std 153/153, prior-green spot set, STRICT_FIXPOINT — see commit.
