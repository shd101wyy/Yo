# An accessor copy's E0901 subject spells std's internal place

**Severity:** S3. An E0901 that a std reader raised (`get`, `first`, `last`, … copying a move-only or counted-handle element) was re-anchored at the user's call, but its message still named the place inside std that copied: `` cannot copy `(_ptr.add)(index).*` ``. The verdict was right and the help named the right fix; only the subject was std's private spelling, which the user never wrote and cannot find.

**Found:** 2026-10-31, Fable consultation VERDICTS-8 Q1 condition (3), while dropping V2c's std-generic-body exemption. Without the exemption, this E0901 is the common error at a handle element read through `ArrayList.get`/`HashMap.get`.

**Fixed:** `vbd/v2c-exemption-drop-r2`.

## Symptom

`tests/cli-cases/check-accessor-copy-names-get-cloned/expected_stdout` (before the fix):

```text
error[E0901]: use of moved value: cannot copy `(_ptr.add)(index).*`, whose type `B` is move-only, and it cannot be moved either: ...
--> main.yo:14:11
```

## Root cause

`_reported_at_user_call` (`src/evaluator/calls/function.yo`) moves a std-raised primary diagnostic to the user's call and adds the accessor help, but it kept the primary's message byte for byte. The message is built where std's body copies, so its subject is the copied expression in std's source.

## Fix

When the re-anchored primary is E0901 at a copying accessor (`_copying_accessor_info`), `_with_primary_subject` (`src/error.yo`) rewrites the primary's subject through `_replace_cannot_copy_subject` to name the reader: `` cannot copy what `ArrayList(B).get` copies (its element) ``. Later diagnostics (the std-location note) keep their text. The flagged flow-violation copy gets the same rewrite, because the enclosing trial re-raises that copy.

The tests are the cli-case goldens `check-accessor-copy-names-get-cloned` (re-recorded: its subject line fails before the fix) and `check-accessor-copy-two-std-frames` (new: `xs.first()` reaches the copy through `get`, two std frames deep, and the error is anchored at the user's `first()` call with the reader as its subject).
