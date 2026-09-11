# `yo doc` on this tree's `std/` without `--std-path` silently drops every member doc and still reports success

**Status:** open. Found while measuring `///` coverage for the std doc sweep
(2026-09-11). **Filed, not fixed** — the sweep it was found in is
documentation-only, and the fix is in `src/doc_command.yo` / `src/doc/builder.yo`.

## Symptom

```
$ cd /path/to/Yo && yo doc ./std --format json -o /tmp/d
  Warning: assert evaluation failed, using token-only docs
  Warning: async/channel evaluation failed, using token-only docs
  ... (90 such lines)
Documentation generated successfully!
  173 modules, 2776 items documented in 22.1s
$ echo $?
0
```

versus

```
$ yo doc ./std --format json -o /tmp/d2 --std-path ./std
Documentation generated successfully!
  173 modules, 1822 items documented in 15.8s
```

Measured on `develop` (7915c0f37), macOS, installed `yo` v0.2.29.

## What the degraded output looks like

For each of the 90 warned modules, every member is emitted as an entry in
`constants` with `"type": "(unknown)"` and **no `doc` field at all** — `///`
comments, `/** */` blocks and `//!` module docs on members alike — and the
module's `types` lose their `methods` and their own docs. `std/time/instant.yo`,
whose every method carries a doc comment, comes out as 18 doc-less "(unknown)"
constants. `std/fs/watch.yo` — the best-documented module in the tree — comes out
the same way.

The same file documents perfectly when it is the only argument
(`yo doc std/time/instant.yo`) or when its directory is
(`yo doc std/time`), because those runs happen to evaluate against a compatible
std. So the failure is not per-module and not reproducible from the module alone.

## Root cause

`yo doc` evaluates each module to get type information. Without `--std-path` it
evaluates against the **installed compiler's bundled `std`**, not the tree's, so
any module whose tree version does not evaluate against the bundled one fails,
and the builder falls back to "token-only docs" — the extractor's token pass with
no evaluator information joined onto it. That fallback drops the doc text it
already has in hand, which is the actual defect: token-only should still carry
the extracted comments.

## Three separate problems, in order of severity

1. **The fallback discards doc comments it already extracted.** The extractor
   parsed them; only the *type* information is missing. Token-only output should
   contain every `///`/`/** */`/`//!` body and simply lack signatures.
2. **`Warning:` on stdout plus exit 0 is not enough.** 90 modules silently
   losing their documentation is a failed run. It should exit non-zero, or at
   minimum need an explicit `--allow-token-only`.
3. **The item count goes UP when the docs are lost** (2776 vs 1822), because
   flattening methods into "(unknown)" constants counts them separately from
   their types. So the one number a caller would sanity-check moves the wrong
   way, and "2776 items documented" reads as a better run than the good one.

## Impact

Any coverage question answered from a `doc.json` produced without the flag is
wrong in both directions — this is how the sweep's first measurement concluded
that 2995 of 3212 std members were undocumented. Guidance to always pass
`--std-path ./std` is now in
`.github/instructions/documentation.instructions.md`, but a flag you must
remember in order to avoid silent data loss is a workaround, not a fix.

## Fix

Carry the extracted comments through the token-only path; make the fallback
loud (non-zero exit, or opt-in); and count items the same way in both paths.
Independently, `yo doc` could default `--std-path` to `./std` when invoked on a
path inside a tree that has one, the way `yo check`'s callers must remember to.
