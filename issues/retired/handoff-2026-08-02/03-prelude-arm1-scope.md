## 1. MINIMAL REPRO

`/Users/yiyiwang/Workspace/Yo/scratchpad/t4/r2.yo` (11 lines, no TryFrom needed):

```rust
{ assert } :: import("std/assert");
Num :: struct(value : i32);
impl(Num, TryInto(i32)(Error : str, try_into : ((self, _) ->.Ok(self.value))));
impl(Num, TryInto(i64)(Error : str, try_into : ((self, _) ->.Ok(i64(self.value)))));
main :: (fn() -> unit)({
  n := Num(value : 10);
  b := n.try_into(i64).unwrap();
  assert(b == i64(10));
  ();
});
export(main);
```

| command                                                      | measured                                                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `./yo-cli compile scratchpad/t4/r2.yo --release -o /tmp/x`   | rc=0, **0** `Failed to transpile`, `int64_t b`                                                         |
| `/tmp/sh172 compile scratchpad/t4/r2.yo --release -o /tmp/x` | **1** `Failed to transpile`, `int32_t b`, line dropped: `// Failed to transpile assert(b == i64(10));` |

`b` is typed **i32**: `try_into(i64)` dispatched to the `TryInto(i32)` impl (`yo_id_2628_rtparam0_enum_yo_id_4976_i32_str_ret_i32`). Then `i32 == i64` has no impl → the whole `assert(...)` statement is dropped. Order-dependence proves "first-declared wins", not "last": swapping the two `impl` lines (`scratchpad/t4/r4.yo`) gives `int64_t b`, hollow=0; asking for `try_into(i32)` (`scratchpad/t4/r3.yo`) gives hollow=0 by accident.

Per-arm hollow on the real file under `/tmp/sh172` (`subset_arms.py`): **arm0=0, arm1=1, arm2=0, arm3=1**.
Note: the recorded bisection is partly wrong on the full file — `sed '64d' tests/prelude.test.yo` still measures **hollow=1**, because arm 3 is independently hollow.

## 2. ROOT

`yo-self/evaluator/calls/helper.yo:817-841` — `check_if_function_parameter_matches_argument` Step 5 ends at the comptime check and goes straight to the closure-refinement block. **There is no assigned-value guard anywhere in yo-self** (`grep -rn "Value mismatch for parameter" yo-self/` → 0 hits). Consequently `FuncParam` (`yo-self/evaluator/types/function.yo:604-636`) has no `assigned_value` field: the value _is_ computed at `types/function.yo:1226-1258` but is only used to seed the def-time variable binding (`:1676`), then discarded.

Why that is fatal here: `std/prelude.yo:7639-7647` declares

```rust
try_into : (fn(self : Self, (comptime(_To) : Type) = To) -> Result(To, Self.Error))
```

`= To` is an **assigned** value, not a default (`?=`). Both impls therefore expose a `try_into` whose parameter _types_ are byte-identical (`self : Self`, `comptime(_To) : Type`). The assigned value is the **only** discriminator; without the guard both candidates survive the checking phase and yo-self takes the first.

## 3. TS MECHANISM

`src/evaluator/calls/helper.ts:481-497` — the comment names this exact case:

```ts
// If the parameter has an assignedValue, check that the argument value matches it.
// This is used for overload resolution based on value matching (e.g., TryInto(i32) vs TryInto(i64)).
if (parameter.assignedValue && evaluatedArgExpr.$?.value) {
  if (
    !areValuesEqual(
      { value: parameter.assignedValue, env: calleeEnv },
      { value: evaluatedArgExpr.$.value, env: callerEnv }
    )
  ) {
    throw formatErrorMessage({
      token: argExpr?.token ?? PlaceholderToken,
      errorMessage: `Value mismatch for parameter "${parameter.label}":
Expected: ${valueToString(parameter.assignedValue)}
Got:   ${valueToString(evaluatedArgExpr.$.value)}`,
    });
  }
}
```

Supporting: `src/types/definitions.ts:429-432` (`assignedValue?: Value` on `FunctionParameter`), `src/evaluator/types/function.ts:379` + `:788` (set and carried), `src/value.ts:699-705` (two `TypeValue`s compare with `areTypesCompatible(expected, given, /* requireExactMatch */ true)` → `are_types_compatible_exact` in yo-self).

## 4. YO-SELF DELTA (all anchors verified `count == 1`)

| file                                     | anchor                                                                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `evaluator/types/function.yo`            | `  ty_expr : Option(AstExpr)\n);` (FuncParam tail)                                                                                 |
| `evaluator/types/function.yo`            | `    default_value_expr,\n    type_expr\n  )\n});` (FuncParam return, ~:1746)                                                      |
| `evaluator/types/function.yo`            | `get_func_param_defaults :: (fn(func_id : String) -> ArrayList(Option(EvalValue)))(`                                               |
| `evaluator/types/function.yo`            | `  param_comptime_flags := ArrayList(bool).new();`                                                                                 |
| `evaluator/types/function.yo`            | `    param_comptime_flags.push(pp.is_compile_time_only);`                                                                          |
| `evaluator/types/function.yo`            | `  register_func_param_comptime(ast_expr_id(expr).to_string(), param_comptime_flags);`                                             |
| `evaluator/types/function.yo`            | `  register_func_param_comptime,\n  copy_func_param_comptime,\n  get_func_param_comptime,` (export list)                           |
| `evaluator/calls/function_type.yo`       | `copy_func_param_comptime, get_func_param_comptime,` (import) and `          copy_func_param_comptime(ast_expr_id(fn_type_box)...` |
| `evaluator/values/anonymous_function.yo` | `  copy_func_param_comptime,` (import) and `      copy_func_param_comptime(_oid.clone(), func_id.clone());`                        |
| `evaluator/calls/helper.yo`              | `{ set_expr_as_consumed, set_expr_as_needs_to_call_dup } :: import("../utils.yo");`                                                |
| `evaluator/calls/helper.yo`              | `  get_func_param_comptime,` (import)                                                                                              |
| `evaluator/calls/helper.yo`              | `    runtime_arg_exprs_in_order : ArrayList(AstExpr),\n    exn : Exception\n  ) -> CheckParamResult`                               |
| `evaluator/calls/helper.yo`              | `` `Cannot assign runtime argument to compile-time parameter "${param_label}"`, `` (Step 5 end)                                    |
| `evaluator/calls/helper.yo`              | `          .FuncVal(__fvd13, _) => get_func_param_comptime(__fvd13.*.func_id.clone()),`                                            |

The `anonymous_function.yo` copy is **required**, not optional: the impl method body is a bare closure (`(self, _) -> …`), so its `FuncVal` id is minted there and the side tables are re-keyed via `meta.origin_id` (`:1194-1206`), not via `function_type.yo`.

## 5. PROPOSED PATCH — validated

Full diff: `/Users/yiyiwang/Workspace/Yo/scratchpad/t4/patch1.diff`. Idempotent applier with the anchor assertions: `/Users/yiyiwang/Workspace/Yo/scratchpad/t4/apply.py <yo-self-root>`.

Core pieces (literal Yo):

`evaluator/types/function.yo` — FuncParam tail (defaulted, so the 8 synthetic `FuncParam(...)` sites need no change):

```rust
  ty_expr : Option(AstExpr),
  (assigned_value : Option(EvalValue)) ?= Option(EvalValue).None
);
```

side table (inserted after `get_func_param_defaults`), mirroring the `g_func_param_comptime` two-step keying: `g_func_param_assigned_values` + `register_func_param_assigned_values` (sparse) + `copy_func_param_assigned_values` + `get_func_param_assigned_values`; `param_assigned_values.push(pp.assigned_value)` in the param loop; `register_func_param_assigned_values(ast_expr_id(expr).to_string(), param_assigned_values);` next to the comptime registration; the three names added to `export(...)`.

`evaluator/calls/helper.yo` — new trailing parameter and the guard immediately after Step 5:

```rust
    exn : Exception,
    (param_assigned_value : Option(EvalValue)) ?= Option(EvalValue).None
  ) -> CheckParamResult
```

```rust
  match(
    param_assigned_value,
    .Some(pav) => match(
      arg_value,
      .Some(agv) => {
        (pav_matches : bool) = match(
          pav,
          .TypeVal(pav_ty) => match(
            agv,
            .TypeVal(agv_ty) => are_types_compatible_exact(agv_ty, pav_ty),
            _ => false
          ),
          _ => are_values_equal(pav, callee_env_r, agv, caller_env_r)
        );
        if(!(pav_matches), {
          exn.throw(
            dyn(
              format_error_message(
                ast_expr_token(actual_arg),
                `Value mismatch for parameter "${param_label}"`,
                false,
                .None
              )
            )
          );
        });
      },
      .None => ()
    ),
    .None => ()
  );
```

plus `are_values_equal` added to the `../utils.yo` import, `get_func_param_assigned_values` to the `../types/function.yo` import, a `call_param_assigned` read parallel to `call_param_comptime`, and the extra argument at the explicit-arg call site:

```rust
          exn,
          match(call_param_assigned.get(pi),.Some(a) => a,.None => Option(EvalValue).None)
```

(The omitted-default call site at `:4914` intentionally keeps the default `.None` — TS also never applies the guard to a synthesized default.)

**Validation actually performed** (not claimed):

- Applied to a copy at `scratchpad/t4/ys/`, `./yo-cli fmt` clean.
- `./yo-cli check scratchpad/t4/ys` → **240/242**, byte-identical FAILED set to the unpatched copy (`evaluator/eval.yo`, `evaluator/index.yo` — both pre-existing standalone-check failures, present in the baseline log too).
- Built `/tmp/t4_patched` (`./yo-cli compile scratchpad/t4/ys/main.yo --release`, 3m43s, rc=0).
- `r2.yo` under `/tmp/t4_patched`: **0 markers**, `int64_t b`, correct callee `..._i64_str_ret_i64`. `r1.yo` (real 4-impl shape): **0 markers**.
- `tests/prelude.test.yo` arm 1 in batch form: hollow **1 → 0**.

## 6. BLAST RADIUS

Reached by: every function call with at least one `= <value>` parameter. In-tree that is exactly `std/prelude.yo:7645` (`TryInto.try_into`) plus two never-called definitions in `tests/basic.test.yo:1963,1967` (`generic((T : Type) = Impl(Id))`) and `tests/basic.test.yo:1688` (a binding, not a param). The side table is sparse (`register_` no-ops when every entry is `.None`), so functions without an assigned param are untouched.

Realistic regression modes: (a) `are_types_compatible_exact` being _too_ strict for `= Impl(Trait)` — TS uses `areTypesCompatible(..., requireExactMatch=true)`, which is the same predicate, so this should be faithful, but it is the untested corner (those two `test1`/`test2` fns are defined and never called); (b) the guard firing on a comptime param whose arg value is a resolved `SomeT` alias rather than the canonical type instance.

Measured (each file run under `/tmp/sh172` and `/tmp/t4_patched`, comparing rc / `__yo_user_main` marker count / passed / failed — **all 16 identical**):
`arc 15p`, `impl 6p`, `fn 24p (h=1 both)`, `iso 3p`, `closure 9p`, `imm_vec 47p (h=0 both)`, `derive 30p`, `dyn 8p`, `negative_impl 1p`, `explicit_type_args 3p`, `higher_kinded_types 20p`, `option_result_combinators 54p`, `iterator_combinators 19p (h=1 both)`, `type_reflection 35p`, `where_clause_fn_inference 2p`, `variadic_comptime 10p`.
Also `check ./std`: **153/153, 0 `error in`** under both binaries.

## 7. FURTHER HOLLOW ARMS — YES, arm 3

`tests/prelude.test.yo` arm 3 (`Test 'MaybeUninit'`) is independently hollow, and **both** of its inner blocks are. Ladder bisection (`scratchpad/t4/L{1..9}`, `M{4..10}`): L1–L4 hollow=0, **L5 hollow=1**; M4–M5 hollow=0, **M6 hollow=1**. Both breaking lines are the `comptime_expect_error(... uninit.assume_init())`.

Root: `assume_init : (fn(own(self) : Self) -> BaseType)` (`std/prelude.yo:7569`). Calling it twice must error. Measured on `scratchpad/repro_assume_init_twice.yo`:

- `./yo-cli check` → `Error: use of moved value: \`uninit_arr\``+`value moved here`
- `/tmp/sh172 check` → **evaluator OK**

So `comptime_expect_error` sees no error and throws itself, hollowing the batch main.

TS mechanism: `src/evaluator/calls/helper.ts:400-401`, unconditional, not gated on ownership:

```ts
// Check if the argument variable has been consumed (moved)
requireExprNotConsumed(evaluatedArgExpr, callerEnv);
```

(body at `src/expr.ts:2596-2632`). yo-self has a faithful 1:1 port, `require_expr_not_consumed` (`yo-self/evaluator/utils.yo:389`), but **never calls it from the call path** — only from `exprs/assignment.yo:391,913` and `exprs/initialization_assignment.yo:304`. The missing line belongs immediately after Step 4 in `helper.yo` (unique anchor `  arg_value := arg_info.value;` + the runtime-arg push block):

```rust
  require_expr_not_consumed(evaled_arg, caller_env_r, ctx, exn);
```

**Do not land this as-is.** I built and measured it (`scratchpad/t4/apply2.py`, binaries `/tmp/t4_patched2` = patch1+2 and `/tmp/t4_p2only` = patch2 alone):

- arm 3 hollow **1 → 0**, and it genuinely passes (`1 passed`, 0 C errors).
- **Regression: `tests/imm_vec.test.yo` hollow 0 → 1**, reproduced twice, and reproduced with **patch 2 alone** (so it is not an interaction with patch 1). Odd shape worth noting for whoever picks it up: neither half of the file reproduces it — `subset_arms 0..23` → hollow=0 and `24..46` → hollow=0, only the full 47-arm file goes hollow, i.e. cross-arm/global consumed-state pollution. Something in yo-self marks a variable consumed where TS does not, and this guard is what surfaces it. That divergence must be found first.

## 8. NEXT BLOCKER AFTER PATCH 1 (arm 1 is still RED, just not hollow)

With patch 1, `tests/prelude.test.yo` arm 1 stops being hollow but fails C compilation with **9 errors**, e.g.
`error: call to undeclared function 'fn_yo_id_5944'`. `grep -nE "try_from|try_into"` over the emitted batch `.c` returns **nothing**: the trait-impl closure bodies are never emitted as C functions at all. TS emits both a prototype and a specialized definition (`fn_yo9d90afc2_id_60_try_into_i64_idi64_rtparam0_Num_...`, `/tmp/t4_r2_ts.c:1298,1361,9268`).

This is independent of the selection bug and pre-existing: `/tmp/sh172 compile scratchpad/t4/r5.yo` (a **single** `TryInto(i64)` impl, no ambiguity) → 0 hollow markers, still `error: call to undeclared function 'fn_yo_id_4977'`. This is the "different bug" the earlier verifier saw with one impl. Full-file measurement with patch1+2: `tests/prelude.test.yo` hollow **1 → 0**, rc **0 → 1**, 9 C errors — i.e. the file converts from a vacuous green to an honest red whose sole remaining cause is this emission gap.

## 9. CONFIDENCE

Patch 1 root cause and fix: **high** — TS's own comment names the exact trait pair, the missing code is a whole-mechanism omission (not a subtle divergence), and the fix was built and measured on the minimal repro, the real arm, 16 test files and `check ./std` with zero deltas.

Cheapest observation that would close what remains open: run `tests/basic.test.yo` under `/tmp/t4_patched` vs `/tmp/sh172` (it is the only file in the tree containing `= Impl(Id)` parameters — the one construct my sweep did not exercise) and, for the stage-2 gate, `/tmp/t4_patched check ./yo-self` compared against `/tmp/sh172 check ./yo-self` counting `error in` lines. I did not run either; everything else I report was measured.
