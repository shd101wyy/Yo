# `yo doc` on this tree's `std/` without `--std-path` silently drops every member doc and still reports success

**Severity:** S3 — `yo doc` without `--std-path` silently degrades ~90 modules to token-only output, exits 0, and reports a misleadingly higher item count

**Status:** fixed 2026-10-03, branch `s3/batch-2-fixes`. Found while measuring
`///` coverage for the std doc sweep (2026-09-11).

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
   — **Fixed one day after filing, in #591** (`b85cef497`, root cause 3 of
   `issues/fixed/yo-doc-renders-the-prelude-empty.md`): the token-only builder
   now passes `assoc.comment.content` into every literal it emits.
2. **`Warning:` on stdout plus exit 0 is not enough.** 90 modules silently
   losing their documentation is a failed run. It should exit non-zero, or at
   minimum need an explicit `--allow-token-only`.
3. **The item count goes UP when the docs are lost** (2776 vs 1822, 3744 vs
   2084 re-measured 2026-10-03 on `develop`), because flattening methods into
   "(unknown)" constants counts them separately from their types. So the one
   number a caller would sanity-check moves the wrong way, and "2776 items
   documented" reads as a better run than the good one.

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

## Fixed

Problems 2 and 3 fixed 2026-10-03 on branch `s3/batch-2-fixes` (problem 1 had
landed in #591 the day after filing). Root cause: `run_doc` collected
`DocumentedFile.degraded` from `document_one_file` and threw it away — the
loop kept only `df.doc_module` (`src/doc_command.yo`) — and the token-only
builder emitted every doc-commented member as a standalone `(unknown)`
constant, so a degraded run counted members the evaluated run counts inside
their types.

The fix, in two parts. (1) `run_doc` now records the degraded module names
and, unless `--allow-token-only` is passed, throws BEFORE rendering
(`doc: N of M module(s) failed to evaluate ... Pass --allow-token-only ...,
or evaluate against the std tree these sources belong to (--std-path <dir>)`)
— no output written, non-zero exit; with the flag the run proceeds with a
stderr summary. A `build.doc()` step fails the same way (there is deliberately
no build-step opt-in this generation: `__yo_build_doc`'s ten-argument builtin
signature is seed-frozen). (2) `build_doc_module_from_tokens`
(`src/doc/builder.yo`) now emits the items the evaluated path counts —
exported TOP-LEVEL declarations (a module with no `export(...)` statement
exports nothing, matching `std/math.yo`'s zero-item evaluated page; measured
with `yo doc` on a no-export fixture: 0 items) — with members attached to
their owners: impl methods (docs included) on the receiver type via
`extract_impl_info_from_tokens`, struct/union fields and enum variants on
their declaration, trait methods on the trait (body extracted with
`_extract_trait_body_members`). A new one-pass token classifier
(`_classify_token_declarations`) supplies the top-level positions (paren
depth 0, binding operator), the member→owner map (group-head walk:
`struct`/`enum`/`union`/`trait` groups own their identifiers; `fn`/`impl` and
ordinary call heads are opaque; anonymous/`ref`/`atomic` groups transparent),
and the module's `export(...)` names. An undocumented exported type with
documented members gets a synthesized type entry, so no doc comment that
lands on an emitted item is lost.

Measured after the fix (Windows, this tree, `YO_STD` pinned to the installed
v0.2.49 std to force degradation): the degraded run now exits non-zero with
the new error naming the modules, and `--allow-token-only` renders with the
item count no longer inflated past the evaluated run's (was 3744 vs 2084;
`std/time/instant` went from 25 token-only items — 3 types with zero methods
plus 22 constants including struct fields and enum variants — to 4, equal to
the evaluated run's 3 types + 1 constant).

Tests: `tests/internal/doc_builder.test.yo` (token-only shape: item count =
exported top-level declarations; methods/fields/variants/trait methods attach
with docs; no-export module documents nothing; undocumented type keeps its
method docs) and `tests/internal/doc_command.test.yo` (degraded run fails
with `--allow-token-only` in the message and writes nothing; the flag renders
with members on their types and no unexported items; a clean tree needs no
flag). `tests/cli-cases/help-doc` re-recorded for the new help line.
