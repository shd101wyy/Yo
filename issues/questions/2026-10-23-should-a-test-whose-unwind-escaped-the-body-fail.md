# Should a test whose unwind escaped its body fail?

**Kind:** design question — an open decision, not a defect.

**Status:** open. Filed 2026-10-23 while fixing
`issues/fixed/2026-10-23-an-unwind-through-a-method-call-is-not-caught-by-the-frame-that-installed-the-handler.md`.

## The question

A real program's `main` aborts when `__yo_effect_escaped` is still set on
exit (`unhandled effect unwind escaped to top level`). The test-batch
`main` does not: `src/codegen/functions/generation.yo` (the `belt_block`
of `test_batch_main`) clears the flag, so a test body may deliberately let
an unwind escape as "abort this test with no outer handler".

The cost: a body that a MISCOMPILED unwind cuts short returns early and
reports PASSED, without running its remaining asserts. The method-call
unwind bug above is exactly that class:

- A naive regression test, an assert after `Q.make(k, raise)` in the test
  body, passed on the buggy compiler. Its regression test in
  `tests/algebraic_effects.test.yo` needs a detour: an installer that
  returns `f() + 100` catches a leaked escape itself, so the result
  differs.
- Existing asserts such as `tests/error.test.yo`'s "post-install code must
  run" are vacuous against this class of bug: when the escape leaks, the
  assert never executes and the test still passes.

Should a test whose body exits with the flag still set be marked FAILED?

## Options

1. **Keep clearing (status quo).** Deliberate escapes stay legal; every
   unwind regression test needs the installer detour to be meaningful.
2. **Fail the test when the flag is set at the batch boundary.** The
   runner reports `unwind escaped the test body` as a failure. Tests that
   escape on purpose would wrap the body in an installing frame, or opt
   in.
3. **Fail by default, with an opt-in** (e.g. a test option or a pragma)
   for the few tests that mean to escape.

## Recommendation

Option 3. An escaped unwind in a test body is almost always a bug in the
compiler or in the test, and a silent PASS is the worst outcome a test
runner can give. First count the tests that rely on a deliberate escape:
if there are none, option 2 is enough.
