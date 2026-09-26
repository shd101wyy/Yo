# A capture struct changes `type_key` when a captured closure parameter is re-resolved

**Found:** 2026-09-26, on develop run 36206559953 and PRs #932 to #934: the Linux TSan job's
`tests/thread.test.yo` failed with `spawns=0`. The corpus script's new log tail (#933) showed why:

```
yo: error: internal compiler error: Capture type not found for closure
yo: error: test: tests/thread.test.yo — 0 of 19 tests in this batch ran: the batch failed to compile
```

**Status:** FIXED 2026-09-26. **Class:** codegen ICE on valid code; a regression from #930.

## Repro

The failure depends on the batch file's name. The same batch source compiled as
`tests/.yo_selftest_batch_1_0.yo` passed, and as `tests/.yo_selftest_batch_9_0.yo` or `…_10_0.yo`
failed. With the tree at 31dfb415d, 9 of 20 names failed. Develop before #930 (4d810ae37) and the
v0.2.43 seed compiled every name. The name moves the content-addressed capture-struct ids, and
with them the order in which codegen registers and looks up types.

The failing type, named by the ICE after this fix's diagnostic change, was the capture struct of
the spawn closure in `_spawn_zst_relay`. That closure is inside a generic function and captures
its `cb : Impl(Fn(io : Io) -> T)` parameter and a `Channel(T)`. The test file calls the function
at `T = unit` and at `T = i32`.

## Cause

#930 made `type_key` key a resolved closure identity (an `Impl` wrapper SomeT) by its resolution,
the closure's capture struct, wherever it appears. A capture struct is keyed structurally, by its
id and each field's key, so a field holding a captured closure's wrapper was keyed through the
wrapper's resolution cell.

For a closure inside a generic function, that wrapper is the function's parameter SomeT: one
def-era lineage whose cell every call site rewrites. The capture struct built in the generic
body is shared by every specialization. Codegen registered it under the key computed while one
call's closure was in the cell, and looked it up while another call's closure was there. The
two keys differed, and the lookup failed. Before #930 the field keyed by the SomeT's id, which
never changes.

## Fix

`src/types/type_key.yo`: a closure capture struct (`capture_…`) keys a SomeT field by the SomeT's
id, not through its cell. Everywhere else the closure-identity rule still applies: at the top
level, in type-argument slots (`ArrayList(typeof(k))`), and in payload and pointer positions.
The C type of such a field still lowers to the capture struct.

`src/codegen/exprs/closures.yo`: the ICE now names the closure and the missing type with its key.
That is how this one was found.

## Regression tests

- `tests/internal/type_key.test.yo`: "a capture struct's key survives a rewrite of its captured
  closure's cell". It failed before the fix.
- `tests/thread.test.yo` under the TSan corpus, and a sweep of 20 batch names over its batch
  source: 0 fail, against 9 before.
