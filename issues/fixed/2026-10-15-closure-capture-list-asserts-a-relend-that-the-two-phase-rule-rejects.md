# closure_capture_list asserts a relend that the two-phase rule rejects

**Severity:** S3 — `tests/closure_capture_list.test.yo` fails to compile on develop at 4c3391592, because two PRs that merged the same day disagree.

**Status:** fixed 2026-10-15.

## What happened

#1382 (E0910's order-independent argument overlap) added a test asserting that `_cl_peek_bump(&h, &mut h.state)` is accepted. Its comment said decision 28's value-root rule was still to come. A few hours later #1387 (E0910 holes) landed Rust's two-phase borrow rule: a later argument may not move, overwrite, or `&mut`-relend a place an earlier argument lends. That rejects the call:

```text
error[E0910]: … the borrow starts when that argument is evaluated …
```

Each PR passed its own Tier 1 against the base it was built on. Neither gate ran the other's change.

## Fix

The assertion is now `comptime_expect_error(_cl_peek_bump(&h, &mut h.state), "the borrow starts when that argument is evaluated")`, and the following state check expects the unchanged value. Rust gives the same verdict, and the rule is #1387's.
