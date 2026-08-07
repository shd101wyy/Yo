# yo-self: single-expression `begin` clobbers the inner expression's ExprInfo (shared AstExpr id)

**Status:** durable merge inversion LANDED (2026-08-07, validating) — the main
tail path now starts from a copy of the tail's info
(`clone_expr_info_for_shared_begin_result`, expr_info.yo) and applies the old
carries' gates as explicit CLEARS (`variable_name`,
`runtime_arg_exprs_in_order` + index triplet); every other inner field —
including the whole `rare` group — is preserved by default. Remaining
instances of the class: the early-escape set sites inside
`evaluate_begin_expression` (begin.yo ~1363/1461/1652/1677/1701/1770/1826,
control-flow escapes storing fresh infos on `expr_to_eval`) still replace
whatever the escape node recorded — same mechanism, separately reachable
(e.g. a shared-id `return(x)` body's early-return-only drops); convert them
the same way if one surfaces.

## The mechanism

`evaluate_begin_expression` (`yo-self/evaluator/exprs/begin.yo:1348-1357`) accepts an
expression that is _not_ a `begin(...)` call and treats it as a one-element begin
block by wrapping it in a 1-element `ArrayList`:

```rust
begin_args := if(is_begin_call, /* expr.args */, {
  single := ArrayList(AstExpr).new();
  single.push(expr);              // <-- the SAME node
  single
});
```

So `last_expr == expr` and `ast_expr_id(last_expr) == ast_expr_id(expr)`.

At the end of the function a **fresh** `out_info := new_expr_info(env, return_type)`
is stored on `ast_expr_id(expr)` (`begin.yo:2135`, `:2197`) — which **overwrites the
inner expression's own ExprInfo on that shared id**. Everything the inner
expression's evaluator path recorded for codegen is lost unless it appears in the
hand-picked carry-across list.

TypeScript does not have this problem: `evaluateBeginExpression`
(`src/evaluator/exprs/begin.ts:1027-1046`) synthesises a real begin node with
`args: [cloneExpr(expr)]` and mutates `expr` into it via
`replaceFuncCallExprWithFuncCallExpr`. The begin node and the inner node are
distinct objects, so `expr.$` and `arg.$` never collide.

### Why yo-self can't just copy TS here

TS materialises the begin node, so its codegen sees a begin block and descends into
the cloned arg. yo-self **returns `expr` itself** — no begin node is materialised —
and codegen dispatches on the expression's _shape_ (`&(...)` → `generate_address_of`,
`match(...)` → the match emitter, …). The begin-ness is purely an evaluator-side
treatment, so that one id must serve **both** roles and the info must be a _merge_,
not a replacement. Cloning the inner expr with a fresh id would move all the inner
metadata onto an id codegen never looks up — strictly worse.

## Which expressions hit it

Any expression evaluated as a bare (unbraced) body:

- `match` / `cond` arm bodies — `.Some(bytes) => &(bytes(idx))`
- bare function bodies — `(fn() -> T)(expr)` with no `{ … }`
- comptime-fn bodies such as `struct(value : T)` (the case the wrapper was added for)

## Instances found so far

Each was a separate "Failed to transpile" / miscompile investigation; all four are
the same root cause.

| Field dropped                                                       | Symptom                                                        | Carry added at  |
| ------------------------------------------------------------------- | -------------------------------------------------------------- | --------------- |
| `runtime_arg_exprs_in_order`                                        | bare runtime call as an arm body → `Failed to transpile`       | `begin.yo:2172` |
| `index_trait_ptr_type` / `index_method_type` / `index_method_value` | bare `xs(i)` arm body → `Failed to transpile`                  | `begin.yo:2184` |
| `deferred_dup_expressions`                                          | `.Ok(map) => map` freed the map while the caller still held it | `begin.yo:2194` |
| `is_index_trait_address_of`                                         | **dangling stack pointer** (below)                             | `begin.yo:2189` |

### The `is_index_trait_address_of` instance (fixed)

`std/string/string.yo:2397` — `String`'s `Index(usize)` impl:

```rust
index : (fn(inout(self) : Self, idx : usize) -> *(Self.Output))(
  match(
    self._bytes,
    .Some(bytes) => &(bytes(idx)),
    .None => __yo_panic("String: index on empty string")
  )
)
```

`&(bytes(idx))` is an unbraced arm body, so its ExprInfo is clobbered.
`evaluate_address_call` (`yo-self/evaluator/builtins/ptr_fns.yo:200`, mirroring
`src/evaluator/builtins/ptr-fns.ts:198`) had stamped
`is_index_trait_address_of = Some(true)`; `generate_address_of`
(`yo-self/codegen/exprs/ptr_fns.yo:79`, mirroring `src/codegen/exprs/ptr-fns.ts:64`)
reads it to emit the index method's returned pointer **directly**. With the flag
gone, codegen fell through to the rvalue temp-spill fallback:

```c
static inline uint8_t* yo_id_4288(__yo_t0* self, size_t idx) {
  ...
  uint8_t _file____User_temp_4314 = (*yo_id_2884_...(&bytes, idx));
  _file____User_temp_4318 = (&_file____User_temp_4314);   /* address of a DEAD local */
```

versus TS, which forwards the pointer:

```c
static inline uint8_t* fn_yoa98c08fb_id_813_index(__yo_struct_yoa98c08fb_id_41* self, size_t idx) {
  ...
  _yoa98c08fb_temp_37832 = fn_yo51ba7706_id_246_index_specialized_T_u8_...(&bytes, idx);
```

Every `s(i) = …` byte write therefore mutated a dead stack slot. Covered by
`tests/for_macro_borrow.test.yo:98` ("String byte index writes mutate in place"),
which was RED under s1 and is green after the carry.

**Debugging recipe** (reusable for the whole class): copy `yo-self` to `/tmp/ydiag2`,
add one `eprintln` in `evaluator/builtins/ptr_fns.yo` reporting what the evaluator
_set_ and one in `codegen/exprs/ptr_fns.yo` reporting what codegen _saw_, rebuild
(`./yo-cli compile /tmp/ydiag2/main.yo --release -o /tmp/s1_dbg2`, ~4 min), and run
the repro. The two probes printing disagreeing values localises the loss to whatever
runs between them:

```
__DBGE itp=true  imv=true sameid=true arg=bytes(idx)     <- evaluator DID set it
__DBGP is_idx=false isfc=true aei=true imv=true arg=bytes(idx)   <- codegen did NOT see it
```

## Still-latent fields (not yet carried, not yet proven to occur)

These are `ExprInfo` fields that codegen reads and that a bare arm/fn body could
plausibly carry. Each needs an empirical check before adding a carry — several of
the existing carries are **conditionally** gated (see `carry_runtime_args`), because
an unconditional carry regressed `match_arm_folded_fncall` and
`runtime_enum_construct`.

| Field                                                                               | Reachable via                                 |
| ----------------------------------------------------------------------------------- | --------------------------------------------- |
| `converted_runtime_type`                                                            | bare `` `str` `` arm body coerced to `String` |
| `dyn_call_trait_values`                                                             | bare `dyn(x)` arm body                        |
| `closure_function_value`, `capture_type`                                            | bare `(x) => …` arm body                      |
| `is_primitive_match`, `primitive_pattern_values`                                    | nested unbraced `match` arm body              |
| `await_analysis`, `async_state_machine_struct_name`                                 | bare `await(…)` / async arm body              |
| `effect_analysis`                                                                   | bare effectful call as arm body               |
| `consumed_variable_drop_expressions`, `early_return_only_deferred_drop_expressions` | bare `return(x)` arm body                     |
| `is_compile_time_only_assignment`                                                   | bare assignment as arm body                   |
| `comptime_unrolled_bodies`                                                          | bare `while(…)` arm body                      |
| `original_expr`                                                                     | test codegen                                  |

`macro_expansion` is already immune — it was moved to a durable side-table for
exactly this reason (`recur` codegen, commit `4529a1b94`).

### The durable fix (landed 2026-08-07)

Invert the merge on the shared-id path: instead of a fresh `out_info` plus a
whitelist, start from a copy of `last_info`
(`clone_expr_info_for_shared_begin_result` in expr_info.yo — shares payloads
including the `rare` group; overrides `env` to the post-pop snapshot, `ty` to
the begin return type, `path_collection` to empty, `popped_env_frame` to None
per the eval-phase leak fix) and apply the begin-level overrides (`value`,
`deferred_drop_expressions`) while explicitly **clearing** the fields the
begin level must own:

- `variable_name` unless (function-body begin && runtime tail) — the old
  carry's gate, now a clear;
- `runtime_arg_exprs_in_order` + `index_trait_ptr_type`/`index_method_type`/
  `index_method_value` for a comptime-folded tail (`!carry_runtime_args`).

This makes preservation the default and loss the explicit choice, which is
the direction TS's node-cloning achieves structurally. The four historical
carries reduce to two clear-gates; `is_index_trait_address_of`,
`deferred_dup_expressions`, and `is_primitive_match` are preserved by
construction, as are all previously-latent fields in the table above.

Validation: battery + corpus 155 + check ./std, fast language suite
(tests/ minus internal), stage-2/3 fixpoint.
