# yo-self: value-generic stamped returns (`-> _ArrayIter(T, N)`) — three-layer fix chain

**Status: FIXED (2026-07-29)**

## Symptom

`for(arr, closure)` over a plain `Array(i32, N)` FTT'd under s1 (TS green):
the batch main of `tests/array.test.yo` was hollow, killer message

```
Cannot unify incompatible types: "usize" and "Type"
```

surfaced by the diagnostic-s1 `__DBGB` probe (function_type.yo def-time trial
swallow), with site enrichment showing `param=rhs expected=usize given=Type
arg=N` — the `self._index >= N` compare inside `_ArrayIter.next`'s body with
the impl's value-generic `N` bound to a TYPE.

## Minimal repro (1-minute cycle)

```rust
// one file, BOTH lengths — the second exposes the C-identity collision
arr0 := Array(i32, 0)();
for(arr0, (x) => { consume(x); });
arr := array(i32(10), i32(20), i32(30));
for(arr, (x) => { consume(x); });
```

## Root chain (three independent layers)

1. **Mint rte gate blind to struct-wrapped length vars.** The
   `create_specialized` return-re-eval gate (helper.yo) fired on
   `get_all_some_types(ret) > 0 || _type_has_array_len_var(ret)`, but the
   walker only traversed Array/Pointer/IsoT. A stamped return like
   `_ArrayIter(T, N)` is a Struct whose `_arr : Array(T, N)` field carries the
   len var — invisible, so the def-era stamp (fields unresolved, its
   `type_arguments` value slot degenerate) was kept, and the `next` dispatch
   on that receiver bound `N := Type` via the type_args fallback (value
   side-channel pushes UnitVal there).
   **Fix:** `_type_has_array_len_var_d` — depth-bounded (≤6) walker that also
   descends Struct field types and EnumT variant fields.

2. **Dot-route call site never re-evaluated the return expr.** helper.yo
   `try_to_call` Step 9 used `evaluate_function_return_type_again` (type-level
   SomeT resolution) — it cannot RE-STAMP a comptime-fn nominal. TS's
   `evaluateFunctionReturnTypeAgain` IS an expr re-eval (helper.ts:1282).
   **Fix:** Step 9b — when the Step-9 result still carries SomeTs or a length
   var, re-evaluate the declared return-type EXPRESSION (rte side-table,
   `_trial_eval_ret_type_expr`) in the bound callee env (N is IntLit-bound
   there by arg synthesis); adopt only concrete results. Mirrored on
   function.yo's FuncVal arm: adopt the mint's registered return when this
   arm's substitution-based return carries a len var, and treat a
   len-var-bearing candidate as a registration regression (never clobber the
   mint's registered type with it).

3. **C type_key collision for value-erased argument slots.** Stamp identity
   keyed by `(constructor_func_id, type_arguments)` — but a comptime VALUE
   argument (`N : usize`) has no TypeValue representation: fresh re-stamps
   record `unit` in the slot, def-era binders record `Type`. So
   `_ArrayIter(i32, 0)` and `_ArrayIter(i32, 3)` both keyed
   `gs_<cfid>_i32_unit` and collapsed onto ONE C struct
   (`._arr = self` with a 3-element self against a 0-element member —
   "initializer for aggregate with no elements requires explicit braces").
   **Fix (types/type_key.yo):** when any type_argument slot is `Type` or
   `unit` (value-erased), append the per-field type keys — the fields carry
   the distinguishing concrete `Array(i32, N)` length.

## Debugging recipe used

- diag-s1 with per-site tags (`__DBGB` trial swallow, synth-site tag global in
  synthesizer, per-caller try_match tags) — see
  plans/archive/YO_SELF_STAGE2_HANDOFF.md "diagnostic-s1".
- Probe hygiene relearned: no nested backticks/`match` inside template
  interpolations in probes (miscompiles the probe build) — compute locals
  first; `open(import("std/fmt"))` collides in impl.yo — use
  `{ eprintln } :: import("std/fmt")`.

## Validation

- Standalone repro: s1 rc=0, runs, FTT=0 (was rc=1 C error).
- `tests/array.test.yo`: rc=0, 12 passed, batch `__yo_user_main` FTT=0
  (GENUINE — was hollow with the entire dispatch as one FTT comment).
