# `_ := f(&mut c, io)` on a borrowing future names an internal temporary, after E0617 recommended it

**Severity:** S3 — contradictory diagnostics with a leaked compiler-internal
name.

Found by the adversarial review of the §3.13 A2 change, 2026-10-12.

## Symptom

The bare statement `bump(&mut s, io);` gives E0617, whose help says to
"discard it on purpose with `_ := ...;`". Doing so gives:

```text
error[E0909]: `_file____User_temp_181374954332970096100` would hold a borrowing future: it borrows `s` ... and cannot be bound to a local.
```

## Root cause

`note_second_class_binding` (`src/evaluator/utils.yo`) runs for every
binding, the hidden temporary `_ :=` binds included, and named it. E0617's
help did not know a borrowing future cannot be bound.

## Fix

Rejecting the discard stays: a borrowing future is awaited where it is made
(§3.13 A2), and a discarded future never runs. `note_second_class_binding`
recognizes the hidden temporary and says "A borrowing future cannot be
discarded with `_ := ...`" with the fix (await it). E0617 drops the `_ :=`
suggestion when the dropped value is a borrowing future
(`src/evaluator/exprs/begin.yo`), and its registry text says so in both
languages.

Regression test: `tests/async_await.test.yo`, "a match arm cannot bind a
borrowing future, and _ := cannot discard one".
