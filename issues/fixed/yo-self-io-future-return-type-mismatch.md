# yo-self emits `__yo_io_future_t*` returns from functions declared with typed future structs — incompatible-pointer class (fs/sys/gc files)

**Status: FIXED 2026-08-16.** Found by a native diagnostic sweep (every
language test file through the self-hosted binary, counting
`-Wincompatible-pointer-types` in the batch compile — `yo test` surfaces
them; `yo compile` hides them behind `-w`). Then PROMOTED to a PR #127
blocker: `tests/sys/copy.test.yo` runs on the emcc leg, where emcc 6 makes
these errors.

## Root cause and fix (measured)

`IoFuture :: Impl(Concrete(__yo_io_future_t), Future(i32))`
(std/sys/future.yo). Two halves, both yo-self-only:

1. **`Impl()` ignored `Concrete(T)`** — `evaluate_impl_constraint`
   (evaluator/builtins/impl_constraint.yo) carried a stale "support is
   deferred" note from when `is_concrete_trait_type` was a stub, and pushed
   the marker into `required_trait_types` with an EMPTY resolved-concrete
   cell. TS extracts the marker and sets `resolvedConcreteType`
   (impl-constraint.ts:104-114, 131-133). Every `IoFuture`-typed wrapper's
   declared C return therefore lowered through the Future TRAIT-OBJECT
   fallback (`__yo_t31*` etc.) while the extern body returns
   `__yo_io_future_t*`. Fixed: the marker now seeds the SomeT's
   resolved-concrete cell (`t_resolved_cell`) and stays out of the required
   traits.
2. **The extern-future pointer rule was unported** — with the cell stamped,
   `get_type_string`'s SomeT arm recursed into the bare extern SomeT and
   returned the UNSTARRED typedef (`__yo_io_future_t` by value). TS's rule:
   an extern-resolved Future is heap-backed → extern C name + `*`
   (utils/index.ts:660-668). Ported into the `.Some(rct)` resolution branch
   of codegen/utils/index.yo.

## Symptom

```
warning: incompatible pointer types returning '__yo_io_future_t *'
         from a function with result type '__yo_t67 *'
```

Counts measured with the 2026-08-16 stage-1 (all three wasm-leg fixes in):

| file                            | diagnostics |
| ------------------------------- | ----------- |
| tests/fs/dir.test.yo            | 11          |
| tests/fs/metadata.test.yo       | 7           |
| tests/fs/file.test.yo           | 6           |
| tests/fs/fs_convenience.test.yo | 6           |
| tests/fs/temp.test.yo           | 6           |
| tests/fs/walker.test.yo         | 6           |
| tests/gc_cleanup_exit.test.yo   | 4           |

(The sweep was interrupted at ~'g'; expect more async-I/O-heavy files. Re-run:
`BIN=<stage1> OUT=/tmp/diagsweep bash <scratchpad>/diag_sweep.sh`, then
`grep "incompat=[1-9]" $OUT/results.txt`.)

## Why it is not a PR #127 blocker

These files are pragma-skipped or io-runtime-absent on wasm targets — the
converted wasm legs compiled past them (the wasi leg died later, at
imm_map). The class is a NATIVE landmine: warnings under clang 15/21,
hard errors under clang 16+ defaults and GCC 14+ — same family as the GCC
blocker fixed in #130 and the Box(V) era split.

## Class shape (not yet root-caused)

Async I/O functions (`read_dir`, `read_file`, metadata, GC-exit paths whose
sync-main wrapper awaits) return the RUNTIME's untyped `__yo_io_future_t*`
while the function's declared C result is the TYPED per-instantiation future
struct (`__yo_t67*` etc.). The two are layout-compatible in practice (the
typed struct embeds/aliases the runtime future) — which is why nothing
crashes today — but the emitted C is type-incorrect. TS presumably casts at
the return site or declares the runtime type; diff the TS emission of
`tests/fs/file.test.yo` as the first step.
