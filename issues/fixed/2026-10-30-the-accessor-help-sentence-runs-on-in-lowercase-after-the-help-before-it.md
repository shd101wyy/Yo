# The accessor help sentence runs on in lowercase after the help before it

**Severity:** S3. A re-anchored E0901/E0910 at a copying accessor printed its decision-20 guidance as a lowercase run-on after the previous help sentence, with no closing period. The diagnostic was correct; its text read as a typo.

**Found:** 2026-10-30, while dropping V2c's std-generic-body exemption (`vbd/v2c-drop-std-exemption`): the exemption's removal makes this help the common E0901 at a handle element read through `ArrayList.get`/`HashMap.get`.

**Fixed:** `vbd/v2c-drop-std-exemption`.

## Symptom

`tests/cli-cases/check-accessor-copy-names-get-cloned/expected_stdout` (before the fix):

```text
help: `B` is move-only (`B` implements Drop): a value of it is moved, never copied. Lend it to a `&T` or `&mut T` parameter, move its whole owner, or share it through a reference type (`Rc`, `Arc`, a `ref(struct(...))`). read it in place with `raw(i)`, copy it with `raw.get_cloned(...)`, or write through it with `raw.with(i, ...)`
```

## Root cause

`_with_primary_help` (`src/error.yo`) appends a sentence to the primary diagnostic's existing help with a space. `_accessor_help_sentence` (`src/evaluator/calls/function.yo`) built that sentence starting with a lowercase verb and without a period, as if it continued the previous clause.

## Fix

`_accessor_help_sentence` capitalizes its first verb (`Read it in place …` or, without an `Index` impl, `Copy it with …`) and ends with a period. The test is the cli-case golden above, re-recorded: it fails before the fix and passes after.
