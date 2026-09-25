# A swallowed error that is re-raised from its text loses its code

**Found:** 2026-09-26, reviewing the CLI goldens of `plans/TYPE_SYSTEM_SOUNDNESS.md` Phase 4.4b.
**Severity:** LOW (the error is still reported, without its code).
**Status:** FIXED on `tss/field-write`.

## Reproducer

An unknown name inside an `io.async` body (`tests/cli-cases/check-async-body-unknown-identifier`)
reported

```
error: Variable "totally_unknown_fn" not found.
```

where develop reports `error[E0401]: …`. A `derive` whose generated body calls a missing method
(`tests/cli-cases/check-derive-clone-non-clone-field`) lost E0610 the same way.

## Root cause

Three channels swallow an error during a trial and re-raise it later from its RENDERED TEXT
(`format_error_message(tok, text)`):
- the async-closure trial (`src/evaluator/values/anonymous_function.yo`);
- the definition-time trial (`src/evaluator/calls/function_type.yo`);
- `derive`'s generated impl (`src/evaluator/builtins/derive.yo`).

The rebuilt error got its code only from the message classifier. Phase 4.4b removed the
classifier's loose "not found" rule and reworded the E0610 message, because raise sites now
name their codes (`with_code`). These three re-raises were not raise sites that named one.

## Fix

Each channel records the swallowed error's primary code (`primary_diagnostic_code`) next to its
text, and the re-raise carries it over (`with_code_carried`, `src/error.yo`).

Found in the same review: destructuring a name a module does not export
(`{ Arr } :: import("std/collections/array_list")`) printed the module's whole struct type as
the receiver, `No field "Arr" on module (ArrayList : fn(T : Type) -> Type, …)`, under E0406.
It is `No member "Arr" in the module. Its members: ArrayList.` under E0403, the
module-member code (`unknown_field_code`, `src/types/utils.yo`).

## Tests

`tests/cli-cases/check-async-body-unknown-identifier` and
`tests/cli-cases/check-derive-clone-non-clone-field` (both pin the code).
`tests/cli-cases/destructuring-a-missing-module-member-is-e0403` and `lsp-import-members`.
