# `yo verify` reports demand-loaded functions as `fn@file:///<absolute path>/...`

**Status:** OPEN. **Found:** 2026-09-18, running `yo verify ./src --format json`
for `plans/SELF_VERIFICATION.md`'s baseline.
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

## Fix

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
