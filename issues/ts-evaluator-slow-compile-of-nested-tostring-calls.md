# TS reference evaluator: ~10x compile slowdown when a function body

# calls `type_to_string` / `value_to_string` through template-string

# interpolations

## Status

Open. Reproduced 2026-05-16 in commit `bd05a8c1` of `bootstrap/phase-4`.

## Symptom

Adding a single function body that uses both `type_to_string(...)` and
`value_to_string(...)` inside a template-string changes the compile
time of `yo-self/main.yo` from ~50s to ~500s — a 10x slowdown — even
though the new function is never _called_ by anything in the
already-compiled program.

The function in question is `get_variable_info` in `yo-self/env.yo`:

```rust
get_variable_info :: (fn(v : Variable) -> String)({
  is_undefined := v.initialized_at_token.is_none();
  is_consumed := v.consumed_at_token.is_some();
  owning_alias := match(
    v.is_owning_the_same_rc_value_as,
    .Some(boxed) => boxed.*.name,
    .None => String.from("<none>")
  );
  value_part := match(
    v.value,
    .Some(eval_val) => value_to_string(eval_val),
    .None => String.from("<none>")
  );
  `{id: ${v.id}, name: ${v.name}, type: ${type_to_string(v.ty)}, value: ${value_part}, isCompileTimeOnly: ${v.is_compile_time_only.to_string()}, isUndefined: ${is_undefined.to_string()}, isOwningTheRcValue: ${v.is_owning_the_rc_value.to_string()}, isOwningTheSameRcValueAs: ${owning_alias}, isReassignable: ${v.is_reassignable.to_string()}, isConsumed: ${is_consumed.to_string()}}`
});
```

It's referenced from `print_env_var_names` / `print_env_frame`, both
of which are also never invoked at compile time.

## Bisect

Targeted edits to the body of `get_variable_info` on commit `bd05a8c1`:

| Body of `get_variable_info`                                             | `compile yo-self/main.yo` wall time |
| ----------------------------------------------------------------------- | ----------------------------------- |
| `(&(v.name)).clone()` (single field)                                    | ~52s                                |
| Template-string with `${v.id}`, `${v.name}`, `${bool.to_string()}` only | ~79s                                |
| + `${type_to_string(v.ty)}`                                             | ~161s                               |
| + `${value_to_string(eval_val)}` (committed form)                       | ~500s                               |

The slowdown is roughly additive across each added call:

- The template-string desugaring alone (a chain of `.to_string() + …`)
  adds ~30s, presumably from per-interpolation `ToString` trait
  resolution.
- Adding the `type_to_string(...)` call adds ~80s.
- Adding the `value_to_string(...)` call adds ~340s.

`type_to_string` and `value_to_string` are both wide pattern matches
over `TypeValue` / `EvalValue` (each enum has ~30 variants, each arm
calls back into the same family of formatters). Embedding them in a
template-string in another function body appears to trigger a TS
evaluator hot path whose cost scales with the size of the callee body
rather than being amortized per-function.

## What we ruled out

- **It is not a yo-self bug.** The Yo source compiles successfully and
  the generated C is identical in shape to neighbouring helpers.
- **It is not a circular import.** `value.yo` and `types/string.yo` do
  not import `env.yo` (only `types/utils.yo` does, and is not pulled in
  here). All the bisect points above use the same import set.
- **It is not template-string parsing.** Template strings desugar at
  parse time (`src/parser.ts:109`); the bisect above shows the cost
  comes from _evaluating_ the interpolation expressions, not from
  parsing the literal.
- **The new `get_variable_info` is dead code at compile time.** No
  module under `yo-self/main.yo` calls it; only `print_env_*` reference
  it, and those are not called either. The slowdown is entirely in the
  type-check / specialization pass on the function _body_.

## Hypothesis

The TS evaluator (`src/evaluator/`) re-walks each callee's full body
when type-checking a caller, instead of caching the callee's resolved
type signature. With two deep wide-match callees referenced from
several `${…}` slots of a template literal, the work explodes
multiplicatively.

A targeted fix would be in `src/evaluator/calls/` — the call-site
analysis path. The cheap workaround at the yo-self side is to drop
`type_to_string` / `value_to_string` from `get_variable_info`, which
loses some debug fidelity vs the TS `getVariableInfo` but restores the
sub-minute build.

## Next steps

1. Decide whether to absorb the slowdown (this hits _every_ yo-self
   rebuild — currently ~8m vs ~50s) or simplify `get_variable_info`
   until the TS evaluator is fixed.
2. Profile `src/evaluator/calls/` against a minimal reproduction
   (`get_variable_info` alone, exported from a tiny test module).
   Likely candidates:
   - Repeated full-body specialization on each `${…}` site instead of
     once per callee.
   - Trait-resolution loop that retries `ToString` against every
     monomorphized callee.
3. Add a guardrail: print a warning when type-checking a single
   function body exceeds some threshold (e.g. 5s), to catch future
   regressions at the offending source location rather than blaming
   the top-level driver.
