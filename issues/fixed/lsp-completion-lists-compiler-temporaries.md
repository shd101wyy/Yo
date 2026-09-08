# Identifier completion lists the evaluator's `_<path>_temp_N` temporaries — over a thousand of them, named after the machine's path

**Status:** FIXED 2026-09-08. Found 2026-09-08 when the `lsp-analysis-resilience`
cli-case golden (recorded on macOS) failed on the Linux gate: the completion
frame differed only in 1,036 labels `__private_tmp_temp_39` vs
`__home_runner_temp_39`. **Severity:** wrong-value on the user surface (an
empty-prefix completion — Ctrl+Space after `:= ` — is dominated by internal
names) and a host-dependent golden.

## Root cause

Identifier completion (`src/lsp/completion.yo`) appends every binding of the
deepest visible env frame that the hidden-name rule does not reject. The rule
knew `___…`, `__yo_…` and single-underscore names, but not the evaluator's
discarded-binding temporaries: `generate_new_temp_variable_name`
(`src/utils.yo`) mints `_<first 12 bytes of the module path, sanitized>_temp_<n>`
— for a document under `/private/tmp/…` that is `__private_tmp_temp_39`. Those
bindings live in the function-body frame the evaluator filled in, so once
completion could see that frame (the previous case exposed it only through a
prefix that filtered them out), the temporaries poured through. Their spelling
embeds the analysed file's path, which is why the same request answers
differently per machine.

## Fix

`src/utils.yo` gains `is_any_temp_variable_name`, the exact inverse of the
generator's grammar — `_`, up to twelve sanitized path bytes (`[A-Za-z0-9_]`),
`_temp_`, digits — defined beside `generate_temp_variable_name_prefix` so the
two cannot drift. The env-binding pass of identifier completion rejects every
name it accepts. (Checking `is_temp_variable_name` against the binding's
module path is not enough: prelude temporaries were minted against the plain
std path while their tokens carry the `file://` spelling, so the derived
prefixes disagree and two of them still leaked.) A user identifier shaped like
`__ab_temp_3` is hidden from completion too; single-underscore names already
were.

## Verification

`tests/cli-cases/lsp-analysis-resilience`'s completion frame (an empty prefix
inside `main`) no longer contains any `_temp_` label, and its golden is
identical on macOS and the Linux gate.
