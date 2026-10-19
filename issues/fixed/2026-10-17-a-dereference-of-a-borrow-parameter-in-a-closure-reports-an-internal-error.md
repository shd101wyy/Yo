# A dereference of a borrow parameter in a closure reports an internal error

**Severity:** S3 — misleading diagnostic: `v.*` on a closure's `v : &i32` parameter fails with the evaluator's internal message `check_if_function_parameter_matches_argument: arg has no ExprInfo` instead of a diagnostic that says a borrow is read without `.*`.

**Status:** FIXED 2026-10-18 (E0920, PR #1469; renumbered from a first draft's E0919 — decision 46's Rc-payload write, #1421, took that code first). Found 2026-10-17 while landing #1420: a
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

## Fix

Exactly that: new code **E0920** (`E_DEREF_OF_BORROW`,
`src/diagnostics.yo`), raised where the deref used to fall through — the
`.*` branch of the property-access evaluator
(`src/evaluator/exprs/property_access.yo`), after the raw-pointer/`Deref`
wrapper handling, when the object is an identifier bound as a borrow
(`v.is_ref || v.is_imm_borrow`, a `&T`/`&mut T` parameter or a local borrow).
The message names the borrow, its mode, that a borrow reads as its value and
that `.*` on a borrow arrives with decision 43; the help lists what `.*` IS
for (raw pointers, `Deref` wrappers, a type's own `*` field).

One exemption keeps std green: a type that DECLARES a field named `*` keeps
the field read — that is the atomic idiom
(`AtomicBool :: atomic(ref(struct((*) : atomic_bool)))`, read as `self.*` on
`self : &Self` throughout `std/sync/atomic.yo`), and without the exemption
every atomic load/store would newly be E0920. A struct pointee without a `*`
field trades its old E0406 "No field `*` on S" for the same, more accurate
E0920.

Registry entry en+zh-CN (`src/diagnostics_registry.yo`), so `yo explain
E0920` works offline; `tests/internal/diagnostics_registry_examples.test.yo`
verifies the entry's bad example fails with exactly E0920 and its good
example loads clean.

## Verification

- The reproducer now reports `error[E0920]: \`v\` is a \`&\` borrow: a borrow
  reads as its value, and \`.*\` does not apply to a borrow until decision 43`
  at the `v.*`, on a tree-built binary.
- `tests/local_borrows.test.yo`: two `comptime_expect_error` pins (a borrow
  parameter and a local borrow `y := &x`), each matching
  "does not apply to a borrow". Fails before the fix: under the seed the
  blocks raise the internal error ("raised an error, but not the expected
  one").
- `check ./std` green: the atomic `*`-field exemption holds (atomic.yo reads
  `self.*` on `&Self` receivers everywhere); `check ./src` green.
- `tests/cli-cases/explain-list` re-recorded (the registry's code set gained
  E0920); the whole cli-diff corpus re-scored clean.
