# yo-self: collections batch residuals after the 2026-07-18 fixes (round-7)

Carriers of the two remaining array_list-batch signatures — see the tail of
issues/fixed/yo-self-void-param-logicalnot-spec.md for the full analysis:

1. `call to undeclared function 'yo_id_XXXX'` (skip-vs-callsite mismatch)
2. `called object type 'int32_t *' is not a function` (Index-trait call
   lowering under the batch shape)

Round-7 logs: /tmp/s2*sweep_r7/tests_collections*\*.done. Both are
pre-existing (masked until now by the void-param + multibyte batch
breakers).

## Signature 3 (round-7 imm_set/imm_map): spec minted with UNRESOLVED SomeTs → skipped but consumed

```
call to undeclared function 'yo_id_5777_rtparam0_gs_yo_id_5128_i32_bool_rtparam1_i32_rtparam2_bool_ret_gs_yo_id_5128_2243_2244'
```

The call-site specialization minted a spec whose registered RETURN type
still contains SomeTs (`2243`/`2244` in the gs\_-render — likely
SortedMap.insert's K/V at some nesting level). should_skip_function_codegen
correctly drops it (has_generic_return), but the CALL SITE was already
stamped with the spec fid → "call to undeclared function".

Fix direction: at the call-site swap (calls/function.yo, after
`spec_ty_fixed`), verify the spec's registered type is CONCRETE before
stamping it onto the callee info (mirror TS hasUnresolvedTypeParams —
refuse the swap, fall back to the original dispatch, and let the
resolution improve). Or fix the binding gap so K/V resolve (the spec's
forall bindings came from a receiver whose type_arguments were shells /
SomeTs — same identity family as everything else).

Also seen: `call to undeclared function 'yo_id_5621'` (bare fid — the
original was skipped as hard-generic while a call site still references
it).
