# A nullable-pointer `match` never releases its scrutinee

**Status: FIXED** (found and fixed 2026-09-26, by the holder census of
`plans/EVALUATOR_MEMORY_REDUCTION.md` Phase 3).

## Symptom

With `Option` of a reference handle lowered to the nullable pointer (Phase 3),
the stage-2 compiler kept about 1.26 M more objects alive than the base, all of
them unreached leak roots (`Variable`, `ExprInfo`, `PendingDef`, `Pattern`). Its
peak footprint on `check src/main.yo` was about 20 MB higher, even though every
rooted table had shrunk (`Token` 107 → 76 B, `ExprInfo` 214 → 153 B).

The rc-event log (`alloc_site_census_t.py --rc-events`, frames named through
`YO_DEBUG_FN_ORIGIN=1`) put the unmatched increment in `get_variables_from_env`.
Its source is
`match(frame.variables.get(pos), .Some(var) => { result.push(var); () }, .None => ())`,
nested in another match's arm. The emitted C tested and bound the `.get()`
result and never released it:

```c
__yo_t_…* tmp = __yo_fs_…(frame->variables, pos);   /* .get(): +1 */
if (tmp != NULL) {
  __yo_t_…* var = tmp;
  __yo_fs_…(result, var);                             /* push: +1 */
} else {
}
/* the tagged lowering released tmp here: switch (tmp.tag) { case SOME: __yo_decr_rc(...) } */
```

## Root cause

Every `match` lowering ends with `generate_deferred_drop_expressions(expr, …)`,
which releases the temps the evaluator attached to the match expression,
starting with its scrutinee temp. That includes `_gen_tagged_union_match`,
`generate_primitive_match_expression` and `_gen_general_match`.
`_gen_nullable_ptr_match` (`src/codegen/exprs/match.yo`) never made the call.
Raw-pointer payloads have nothing to release, so it was invisible until the
payload could be a reference handle. `_gen_simple_enum_match` skipped it too,
which is harmless today (a fieldless enum carries no RC), but it is the same
contract.

## Fix

Both lowerings end with `generate_deferred_drop_expressions`, like the others.
Emission stays idempotent through `emitted_deferred_drop_ids`.

## Test

`tests/match_catch_all.test.yo` "a match on an owned nullable-pointer Option
releases its scrutinee" nests the match the way `get_variables_from_env` does,
and counts `Dispose` calls after the list's block ends. It fails on the Phase 3
compiler without the fix (a top-level statement match does not reproduce it:
that temp is dropped by the block's scope end instead).
