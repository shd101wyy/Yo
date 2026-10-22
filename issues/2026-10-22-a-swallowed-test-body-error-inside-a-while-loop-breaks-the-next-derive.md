# A swallowed test-body error inside a `while` loop breaks the next `derive`

**Severity:** S3 — a misleading diagnostic on a file that is already
invalid. `yo check` (without `--test-bodies`) swallows a test body's
trial-evaluation error, as designed. When the error is raised inside a
`while` loop, though, the loop context is not unwound. The next top-level
`derive` then fails with a bogus "Cannot initialize a variable that is
defined outside the while loop" at an `auto-generated://` location, which
names neither the test nor the real error. (Filed as S2; lowered to S3 by the
probe's review, 2026-10-23: the file has a real error either way, and
`--test-bodies` or `yo test` reports it.)

**Status:** open. **Found:** 2026-10-22 by the V2b B8 flip probe
(`plans/handover/VBD_B8_PROBE_CENSUS_2026-10-22.md`). Under the flip,
`tests/collections/array_list_convenience.test.yo` and
`tests/string/string.test.yo` fail `yo check` this way: a `list.push(...)`
inside a `while` on an unmarked `list := ArrayList(i32).new()` becomes E0917,
and `derive(_SortRec, Copy, Clone)` further down the file reports the bogus
error. The v0.2.68 seed and develop `e30c0d8ed` behave the same with
develop's std, so the flip is not required.

## Reproducer

`issues/repros/2026-10-22-a-swallowed-test-body-error-inside-a-while-loop-breaks-the-next-derive.test.yo`:

```yo
{ assert } :: import("std/assert");
C :: struct(n : i32);
impl(
  C,
  bump : (fn(self : &mut Self) -> unit)({
    self.n = (self.n + i32(1));
  })
);
test("a write to a non-mut local inside a while loop", {
  c := C(n : i32(0));
  (mut(i) : i32) = i32(0);
  while(i < i32(3), i = (i + i32(1)), {
    c.bump();
  });
  assert(c.n == i32(3), "bumped");
});
R :: struct(key : i32);
derive(R, Copy, Clone);
```

| Command | Result |
| --- | --- |
| `yo check <file>` | `error: Cannot initialize a variable that is defined outside the while loop.` at `((__derive_optT_… : Option(Expr)) = .None)` |
| the same file without the last two lines | `evaluator OK` (the body's E0917 is swallowed) |
| `yo check <file> --test-bodies` | `error[E0917]: Cannot lend \`&mut\` … \`c\`` (the real error) |

## Root cause (hypothesis)

`_trial_eval_test_body` (`src/evaluator/exprs/test.yo`) evaluates the body
with `evaluate_expression_guarded` and drops the error. The `while`
evaluation's loop-scope state (the record behind "defined outside the while
loop", which `_derive_bind_opt`'s generated `((tmp : Option(Expr)) = …)`
binding consults) is pushed on entry and popped on normal exit only. An
exception thrown out of the body skips the pop, so the next statement in the
module still evaluates "inside" the dead loop.

## Fix direction

Restore the loop-scope state on the exceptional path, either where `while` is
evaluated or in the guarded evaluator's catch. The regression test is the
repro above, which should report `evaluator OK` without `--test-bodies`.
