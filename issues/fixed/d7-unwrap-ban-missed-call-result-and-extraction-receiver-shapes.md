# The D7 unwrap ban compiled `.unwrap()` on Option/Result in safe files

Found while diagnosing the full battery's CLI golden failures on develop: the
three `safe-mode-unwrap-*` cli-cases (Phase 0c, #831) scored NO-GOLDEN —
their fixture programs compiled CLEANLY with rc=0 instead of being rejected
with E0611. They had never run in any battery before: cli-cases are excluded
from the reduced battery a stacked PR runs, so #831's gate was merged without
its end-to-end tests ever executing.

## Verbatim behavior

    $ yo compile fixture/main.yo --skip-c-compiler -o prog
    $ echo $?
    0

where the fixture contains, in a safe file:

```rust
main :: (fn() -> unit)({
  r := make(true).unwrap();   // make : (fn(flag : bool) -> Option(i32))
});
```

Expected: `E0611 the optimistic panic vocabulary is banned in safe files`
with the "discards the failure case" detail. Observed: compiles cleanly.

## Root cause (probe-verified, YO_DEBUG_DISPATCH)

Three receiver shapes slipped every gate site:

1. **Fresh call results** (`make(true).unwrap()`): a method call's callee is
   resolved in `calls/function.yo`'s no-compile-time-value arm, so the
   property-access metadata gate in `exprs/property_access.yo` is never
   reached for it (the `[pa-c1]` probe never printed). The dispatch-time gate
   WAS reached — but read the receiver type off `method_ty`'s FIRST PARAMETER,
   which for the prelude's generic `unwrap` is the forall `T`; specialized
   against an unresolved receiver it reads `?(*(T))`, and
   `is_class1_panic_receiver_type` correctly rejects a type VARIABLE — so the
   ban never fired.
2. **Local variables** (`r2 := make(true); r2.unwrap()`): same dispatch path,
   same generic-param read.
3. **Extraction on a type value** (`f := Option(i32).unwrap;`): resolved by
   the "generic-impl fallback for non-struct TYPE receivers" in
   `exprs/property_access.yo` — Option/Result methods live in the generic-impl
   registry — which RETURNS after resolution, before the TypeVal+EnumT arm
   where the extraction gate sat.

The old gate was not regressed by a later PR; it never covered these shapes.
#831's own local verification exercised different receivers, and the battery
that runs the cli-cases (tier-1) first executed after the whole stack had
already merged.

## Fix

- The dispatch-time gate in `calls/function.yo` additionally consults the
  receiver EXPRESSION's own `ExprInfo.ty` — the concrete type the receiver's
  evaluation recorded (`out_rt.ty = resolved_ret`) — which is `Option(i32)`
  for a fresh call result, a variable holding one, and so on.
- The generic-impl fallback in `exprs/property_access.yo` carries the
  extraction ban itself: an atom property named `unwrap`/`expect`/`unwrap_err`
  on an Option/Result TypeVal throws E0611 before resolving.

All of `src/` stays buildable: files there either carry
`pragma(Pragma.AllowUnsafe)` (module_manager, manifest, build_runner, value,
main) or contain no banned calls (resolver, install_command — migrated in
#831). The exemption predicate is evaluated before every new check.

## Second hole, found on the fixed tree (wasm32_wasi leg): test batches

With the gates firing, `yo test` batches went red — `tests/cli/arg_parser.test.yo`
compiled as part of `tests/cli/.yo_selftest_batch_34_0.yo` and was rejected
with E0611. The runner concatenates `*.test.yo` files into a
`.yo_selftest_batch_<n>_<m>.yo` batch, which loses the `.test.yo` suffix the
exemption matches (files that declare `pragma(Pragma.AllowUnsafe)` themselves
kept working, because the pragma line rides into the batch as a non-test
statement). The batch artifact is now exempted by its distinctive
`.yo_selftest_batch_` name.

## Verification

With the fix, the three fixtures and both variable/constructor-receiver
variants reject with E0611 under the self-hosted binary. The gates'
`YO_DEBUG_DISPATCH` probes are temporary and come out with the fix.
