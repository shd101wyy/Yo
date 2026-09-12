# A swallowed closure spec emits a wrong-typed return (MSVC error) in one batch composition

Status: OPEN (pre-existing on `origin/develop` @547d0c239; blocks `test
(windows-11-arm)` whenever the batch packs these files; found via #614's CI
on 2026-09-13).

## Reproducer (any host)

```bash
yo test ./tests/closure_param_forwarding.test.yo ./tests/collection_literals.test.yo ./tests/collections/array_list.test.yo --parallel 1
# then, on the kept batch C:
clang -fsyntax-only tests/.yo_selftest_batch_1_0.bin.c
```

`tests/.yo_selftest_batch_1_0.bin.c:4040` and `:4054`:

```
warning: incompatible pointer types returning '__yo_t_11901070468082033723 *'
from a function with result type '__yo_t_1115127894926806235 *'
```

The function is a closure specialization
(`…Fn_i32_____i32__id_2226_rtparam0_capture_…_cl0_closure_…`): it
constructs and returns a `__yo_new___yo_t_11901070468082033723` while its
signature says `__yo_t_1115127894926806235*`. The same batch also carries a
body that "failed to transpile — its definition-time evaluation failed and
was swallowed" (`yo_id_1473624…`, emitted as an `abort()` stub).

Linux/macos treat the mismatch as a warning and the tests pass (the abort
stub is never called); **MSVC (the windows-11-arm leg) escalates
`-Wincompatible-pointer-types` to an error**, failing the whole batch
compile — exit 1 with no test output.

## Verdict

- The emitted C is **byte-identical** between a `develop`-tip compiler and
  a compiler carrying #614 — the mismatch is not #614's; it is visible
  whenever the test runner packs these three files into one batch (the
  default fast-suite ordering puts them in batch 36).
- `YO_DEBUG_SWALLOW=1` shows only the usual prelude trial swallows
  (`checked_add`-family generics) — the def-time failure that hollowed the
  closure spec is swallowed in the ordinary trial channel, so nothing new
  surfaces in the log.

## Fix direction

Two layers, both real:

1. The closure spec's def-time evaluation failure should not be silently
   swallowed into an `abort()` stub when the spec is reachable from emitted
   code — or at least the stub's signature must match the spec's declared
   result type so hosts that promote the pointer mismatch to an error can
   compile it.
2. The specialization picked the wrong capture-struct era for the return
   (`closure.yo`'s resolution-aware `@res:` cap_key split): the returned
   type and the signature type come from the two different eras the key was
   meant to keep apart.
