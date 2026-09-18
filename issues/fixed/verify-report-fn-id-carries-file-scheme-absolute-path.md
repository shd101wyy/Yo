# `yo verify` reports demand-loaded functions as `fn@file:///<absolute path>/...`

**Status:** FIXED 2026-09-18 (`plans/SELF_VERIFICATION.md` M0).
**Found:** running `yo verify ./src --format json` for that plan's baseline.
**Severity:** report ids are machine-specific; goldens, ratchets and any
per-fn cache keyed on the id cannot be shared across checkouts.

## Symptom

In one run over `./src`, 48 of the 57 `ok` functions print as

```
fn@file:///Users/<user>/Workspace/Yo-wt/bend-lessons/src/types/utils.yo:65
```

while functions from the entry module print as `fn@src/target.yo:179`. Same
tree, same command, two spellings.

## Cause

`VerifyTask.fn_id` is built from the defining token's `module_path`
(`src/evaluator/calls/function_type.yo` ~L1286/L1425/L1605:
`` `fn@${tok.module_path}:${tok.row.to_string()}` ``). The entry module's
tokens carry the path as typed on the command line; a demand-loaded module's
tokens carry the `file://<abs>` cache key. This is the "two spellings of a
module path" pitfall (AGENTS.md, `issues/fixed/static-library-exports-no-symbols.md`)
surfacing in the verifier's report instead of codegen.

## Fix — LANDED

`display_module_path` (`src/utils.yo`, beside `canonical_module_path`): strip
`file://`, absolutize + normalize, then make relative to the working directory
when the module lives under it. Applied at all four `VerifyTask.fn_id`
construction sites — three in `src/evaluator/calls/function_type.yo` (including
the one that keys `record_verify_task_def_eval_failure`, which must agree with
the task's own id) and the impl-variance task in
`src/evaluator/builtins/contracts.yo`.

**The cache was affected too, which this issue originally missed.** `fn_id` is
passed as the VC walk's `fn_name` (`src/verifier/driver.yo`), which
`mangle_vc_name` turns into every `__yo_v<fn>_<name>` in the query text, which
`encode_content(q)` hashes into the verification cache key. An absolute path
there made every cached verdict machine- and checkout-specific, so the cache
could never hit across checkouts. The same fix closes it.

Verified: a full `yo verify ./src` sweep (3,673 functions) contains zero
`file://` and zero absolute paths. Tests:
`tests/internal/verifier.test.yo` — the two spellings of one module must render
identically, and a path outside the working directory keeps its canonical
spelling. `scripts/verify_sweep_report.py` normalizes defensively as well, so a
report produced by an older seed still scores against the same baseline keys.

## Original fix sketch

Canonicalize at the id construction sites with the rule codegen already uses
(`canonical_module_path`, re-exported as `_canonical_module_path` in
`src/codegen/functions/collection.yo`): strip `file://`, make relative to the
cwd, `normalize()`. Check whether the id or a derivative reaches
`encode_content(q)` (the verification cache key, `src/verifier/driver.yo`
`verify_cache_key`) through the `__yo_v<fn>_<name>` mangling; if it does, the
cache is machine-specific too and the same fix applies there.

## Test

A cli-case running `yo verify` over a two-file fixture (entry + imported
module) whose golden asserts both ids are relative; the
`tests/internal/verifier.test.yo` mangling-stability test gains a
demand-loaded case.
