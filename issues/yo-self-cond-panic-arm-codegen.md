# yo-self: `cond(... => panic(msg))` arm — codegen "Failed to transpile"

## Status: PARTIALLY FIXED

- **FIXED (committed):** `evaluate_panic`'s `str`-type check. It used an inline
  `match(msg_type, .Struct({name}) => name == "str", _ => false)`, but `str` is
  the fieldless `.Str` TypeValue variant (NOT a Struct) — so a `panic(msg : str)`
  threw "panic message must be a comptime_str or str", was swallowed by the
  def-time trial-eval, and left the enclosing `cond` without ExprInfo →
  "Failed to transpile cond(...)". Replaced with the `is_str_type` guard
  (handles `.Str`). Verified: a USER-defined `myassert(flag, msg : str)` with
  `cond(flag => (), true => panic(msg))` now transpiles + runs (was 1 error → 0).
- **STILL OPEN:** the std/prelude `assert` (and any prelude-defined
  `panic(str_param)` function) STILL emits "Failed to transpile cond(...)". With
  the panic fix, instrumentation confirms `panic` now evaluates cleanly
  (`is_str=true type=str`, no throw) — yet codegen still finds NO ExprInfo on the
  cond node. So this is a SEPARATE, deeper issue: a body-AST / ExprInfo identity
  mismatch specific to how a prelude-defined (non-specialized) function reaches
  codegen — codegen walks a cond node whose id differs from the one the def-time
  body eval recorded ExprInfo on. error.yo/expr.yo transpile counts are unchanged
  by the panic fix because their remaining cond/panic is the imported std assert.

## Symptom

A `cond` with a diverging `panic(...)` arm in a non-generic function body emits
`// Failed to transpile cond(...)` in the self-hosted compiler. The canonical
case is `std/prelude.yo`'s `assert`:

```rust
assert :: (fn(flag : bool, (msg : str) ?= "Assertion failed.") -> unit)(
  cond(flag => (), true => panic(msg))
);
```

Wherever `assert` (or any panic-arm cond) is **emitted**, yo-self produces
`// Failed to transpile cond(flag => (), true => panic(msg))`. The assert becomes
a silent no-op (valid C, so passing programs still run — but a failing assert
does NOT panic in self-hosted-compiled output). Also seen verbatim in
`yo-self/error.yo` (the survey's error.yo error #5).

## Minimal repro (TS passes, yo-self fails)

```rust
f2 :: (fn(flag : bool, msg : str) -> unit)(cond(flag => (), true => panic(msg)));
main :: (fn() -> unit)({ f2(true, "x"); () });
export(main);
```

`./yo-cli compile` (TS) → compiles + runs. `/tmp/yo-self-bin compile --emit-c` →
1 `Failed to transpile cond(...)`. A cond WITHOUT a panic arm
(`cond(flag => (), true => ())`) emits fine — it is specifically the `panic`
(diverging) arm. The error only appears when the function is actually EMITTED
(reachable from `main`); an unreferenced panic-arm cond is never emitted.

## Root cause (NOT yet pinned — needs instrumentation)

The emitted `// Failed to transpile cond(...)` is `generate_func_call`'s EARLY
fallback (the `get_expr_info(expr)` lookup returned `.None`) — i.e. the cond node
has **no ExprInfo**, so the BK_COND dispatch / `generate_cond_expression` is never
reached. ExprInfo is recorded during body evaluation, so the cond's body eval must
have thrown (swallowed) or recorded under a different node id.

Static reading is INCONCLUSIVE and a quick hypothesis was ruled out:
- `evaluate_cond` (evaluator/exprs/cond.yo) for `cond(runtime_flag => (), true =>
  panic)` takes the `.None` "evaluate all non-false arms" branch (arm 1 `flag` is
  runtime, not comptime-false, so `first_true_index` is None). That branch *appears
  to* record the cond ExprInfo (line ~612, `has_case_without_control_flow` path),
  and arm types unify (`()` unit vs `panic` typed as the fn return `unit`).
- `evaluate_panic` (builtins/panic.yo) throws only when the fn-body context is
  absent (line 40) or during CTFE-capability analysis (line 59). The "def-time eval
  lacks fn-body context" theory is **contradicted** by the fact that the SAME
  failure occurs for the ArrayList `index` method, which is emitted via
  `create_specialized_function_inline` (that path DOES set
  `is_evaluating_function_body_or_async_block`, helper.yo:1194).

So the throw site is not yet identified from static reading. **Next step:** add a
print to the def-time trial-eval swallow handler (`_trial_eval_fn_body`,
function_type.yo:217 `((_err) -> unwind(()))` → print `_err.to_string()`),
rebuild, compile the minimal repro, and read the actual thrown message. Then fix
the throwing site (likely make a diverging/value-less `panic` arm acceptable —
mirror TS treating `panic`/divergent arms as "never", compatible with any expected
type, src/evaluator/exprs/match.ts:507).

## Impact / priority

Latent: passing programs are unaffected (assert no-ops), but failing asserts do
not panic, and this blocks clean codegen of every module that emits an assert
(pervasive). Surfaced by the Index-trait fix (the ArrayList `index` method body
contains `assert(idx < self._length, …)`). See
`issues/fixed/yo-self-index-trait-codegen.md`.
