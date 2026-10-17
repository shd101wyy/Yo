# A dereference of a borrow parameter in a closure reports an internal error

**Severity:** S3 — misleading diagnostic: `v.*` on a closure's `v : &i32` parameter fails with the evaluator's internal message `check_if_function_parameter_matches_argument: arg has no ExprInfo` instead of a diagnostic that says a borrow is read without `.*`.

**Status:** open. Found 2026-10-17 while landing #1420: a
`tests/move_only_collections.test.yo` draft wrote
`m.retain(&((k : &_McKd, v : &i32) => (v.* < i32(20))))`. A `yo check` of
that test file passed, and the test batch then failed to compile with the
message above. It reproduces with the develop-built `yo-dev-5425cd7bf`.

## Symptom

```text
error: check_if_function_parameter_matches_argument: arg has no ExprInfo
  --> tmp/vd.yo:7:34
  |
7 |   assert(apply(&((v : &i32) => (v.* < i32(20)))), "below");
  |                                  ^
```

## Reproducer

```yo
{ assert } :: import("std/assert");
apply :: (fn(f : &Impl(Fn(v : &i32) -> bool)) -> bool)({
  x := i32(5);
  f(&x)
});
main :: (fn() -> unit)({
  assert(apply(&((v : &i32) => (v.* < i32(20)))), "below");
});
export(main);
```

`v < i32(20)` compiles and runs. A borrow reads as its value, and
`.*` on a borrow arrives only with decision 43
(`.github/instructions/yo-syntax.instructions.md`), so the program is
invalid. The defect is the message: it names an evaluator function and says
nothing about `.*`. Inside a `test(...)` body, `yo check` of the file did not
report it at all.

## Expected

A coded diagnostic at `v.*` that says `v` is a borrow, read as its value,
and that `.*` does not apply to a borrow until decision 43.
