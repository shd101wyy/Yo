# A swallowed test-body error hides the next `comptime_expect_error`'s `Rc` payload write

**Severity:** S3. The file already has a real error, and `--test-bodies` or
`yo test` reports it. The diagnostic `check` prints instead names a later,
correct `comptime_expect_error` ("the expression was evaluated
successfully"), and never mentions the test body.

**Status:** open. **Found:** 2026-11-02 while migrating
`tests/borrow_spelling.test.yo` for decision 43 step 2 N1e-1. An
intermediate compiler left a test body failing, and the N1d case
`bs_handle_mut_borrow` (`&mut h.*.x` through an `Rc`, E0919) further down
then failed as "raised no error". The N1d binary (`3c7751362`) behaves the
same, so N1e-1 is not required. This is the same family as
`issues/2026-10-22-a-swallowed-test-body-error-inside-a-while-loop-breaks-the-next-derive.md`.

## Reproducer

`issues/repros/2026-11-02-a-swallowed-test-body-error-hides-the-next-comptime-expect-errors-rc-payload-write.test.yo`. `yo check` on it fails with
`error: "read-only through the handle"` at the `comptime_expect_error`.
Delete the `test(...)` block, or fix its call, and the case passes.

## Root cause (not yet confirmed)

`reject_write_through_rc` (`src/evaluator/utils.yo`) returns early when
`ctx.is_in_function_call_checking_phase || ctx.is_ghost_context`. The
swallowed error is raised while the undefined call is checked. The suspicion
is that the swallowing path does not restore one of those two flags, so the
next `&mut` borrow is judged as if it were inside an overload trial. Before
fixing, confirm which flag is stale.

## Fix direction

Restore the evaluation mode the swallowed trial left behind, at the place
that swallows a test body's error, as `comptime_expect_error` does for its
own argument. A test then runs the reproducer under `yo check`, expecting
rc=0 once the test body's call is corrected, and rc≠0 naming the test body
while it is not.
