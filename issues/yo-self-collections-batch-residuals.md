# yo-self: collections batch residuals after the 2026-07-18 fixes (round-7)

Carriers of the two remaining array_list-batch signatures — see the tail of
issues/fixed/yo-self-void-param-logicalnot-spec.md for the full analysis:

1. `call to undeclared function 'yo_id_XXXX'` (skip-vs-callsite mismatch)
2. `called object type 'int32_t *' is not a function` (Index-trait call
   lowering under the batch shape)

Round-7 logs: /tmp/s2*sweep_r7/tests_collections*\*.done. Both are
pre-existing (masked until now by the void-param + multibyte batch
breakers).
