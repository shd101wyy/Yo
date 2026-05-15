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

## Profiler dive (2026-05-16)

Self-time profiling was added to `tryToCallFunctionWithArguments` (now
emitted by `_printCallProfile()` when `YO_DEBUG_CALL_PROFILE=1`).
Compile of `yo-self/main.yo` with the heavy `get_variable_info` body:

```
[CALL PROFILE] tryToCallFunctionWithArguments: 3,466,837 calls
[CALL PROFILE] createSpecializedFunctionInline:    3,248 calls (cache hit: 3,004, miss: 244)
[CALL PROFILE] Total self-time inside tryToCall: 480,809 ms
[CALL PROFILE] Top tryToCall by self-time (ms):
  fn_yoa98c08fb_id_259_+:               214,945 ms / 1,056,016 calls (203.5 µs/call)   <- String '+'
  fn_yo8245ee87_id_102_to_string:       128,279 ms /   703,768 calls (182.3 µs/call)   <- String.to_string
  fn_yo8245ee87_id_108_to_string:        97,186 ms / 1,408,586 calls ( 69.0 µs/call)   <- str.to_string
  ___drop:                                9,573 ms /    64,644 calls (148.1 µs/call)
  type_to_string:                         7,572 ms /    66,915 calls (113.2 µs/call)
  ...
```

Findings:

- **The bottleneck is `tryToCallFunctionWithArguments` itself**, not
  any single hot Yo function. 3.47M invocations total; the top three
  callees (`+`, `String.to_string`, `str.to_string`) account for
  ~440 of the 497 wall-clock seconds.
- **`analyzeCtfeCapability` is not the culprit.** All 375 CTFE
  analyses complete in ~0 ms each (instrumented under
  `YO_DEBUG_CTFE_ANALYZE=1`). The cost is in normal type-check /
  specialization, not in CTFE try-evaluation.
- **Specialization cache is healthy** (92% hit rate, 3,004 hits vs
  244 misses). Re-specialization isn't the issue.
- **Per-call cost is high** (~200 µs for `+`, ~180 µs for
  `String.to_string`). For trivial operators this is far more than
  it should cost; even cutting the per-call overhead in half would
  recover ~4 minutes.
- The 1.4M / 700K to_string counts and 1M `+` counts strongly suggest
  the evaluator is **walking the desugared `${…}` chain
  (`a.to_string() + b.to_string() + …`) recursively for every nested
  function call**. Each outer call walks its callee body; each callee
  body has its own `${…}` chain that walks its callees; the cost
  compounds multiplicatively, which matches the observed +30s / +80s
  / +340s steps seen when adding one extra interpolation at a time.

## Likely fix location

`src/evaluator/calls/helper.ts:tryToCallFunctionWithArguments` (3,100
LoC). When invoked with `isValidatingFunctionDefinition: true` and the
callee has a fixed signature, the function still walks the callee body
to compute deferred-drop and effect information. Candidate
improvements:

1. Skip the body walk when validating a caller's definition and the
   callee's signature is already known. Reuse cached
   `specializedFunctionCaches` entries by signature alone when no
   compile-time args differ.
2. Memoize the per-callee body walk keyed by `(funcId, parameter
types)` for the validation pass — the result is purely a function
   of those inputs.
3. Reduce per-call setup cost. Most of the 200 µs is going to env
   cloning, parameter matching, and forall-arg / implicit-arg
   bookkeeping that is unnecessary for plain monomorphic calls (e.g.
   `String.+(String)`).

## Tooling left in place

- `YO_DEBUG_CALL_PROFILE=1 ./yo-cli compile …` now prints a top-30 list
  of callees by both invocation count and self-time-ns inside
  `tryToCallFunctionWithArguments`.
- `YO_DEBUG_CTFE_ANALYZE=1 ./yo-cli compile …` prints a line per
  `analyzeCtfeCapability` invocation with elapsed ms.

Both env-flag profilers are zero-cost when their respective flag is
unset.

## Next steps

1. Build a minimal in-process reproduction (single-file Yo source
   that exhibits the explosion) so the fix can be benchmarked without
   rerunning the full ~8m yo-self compile each iteration.
2. Patch `tryToCallFunctionWithArguments` along one of the fix
   directions above, measuring both the synthetic repro and
   `yo-self/main.yo`.
3. Once the underlying perf is fixed, restore the rich
   `get_variable_info` body shown in the symptom section.
