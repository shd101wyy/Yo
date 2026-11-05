# E0901 says "use of moved value" on a copy that moved nothing

**Kind:** design question — an open decision, not a defect.

**Status:** OPEN. Filed 2026-11-06 with the rb5 wording PR, as VERDICTS-25 Q5 §3 directs: the
family head is the whole E0901 family's, so rb5 kept it and only rewrote the helps.

## What is inconsistent

E0901's title is "use of moved value", and its copy forms reuse that head as a prefix:

- `_throw_explicit_copy_violation` (`src/evaluator/utils.yo`): `` use of moved value: cannot copy `x`, whose type `T` is move-only, and it cannot be moved either: … ``
- `_throw_reference_deref_copy`: `` use of moved value: cannot copy `r.*`, whose type `String` is move-only: `r` is a reference, and the value it refers to stays with its owner. ``
- the two closure-capture forms: `` use of moved value: the closure captures `v`, … ``

In none of them was anything moved. The program copies a value it does not own, which the
compiler rejects before any move happens. A reader who sees "use of moved value" looks for an
earlier move, and there is none. Rust gives this class its own message, E0507 "cannot move out
of `*r` which is behind a shared reference", separate from E0382 "use of moved value".

Six CLI goldens pin the prefix (`check-handle-element-get-is-e0901`, the three
`check-accessor-copy-*` cases, `inout-interior-borrow-growth-panics`,
`inout-for-alias-push-panics`). No language test pins it: the tests pin the clause after it
("the value it refers to stays with its owner", "the closure captures `f`").

## Options

1. **Keep the prefix.** One family, one head; the registry entry already says "or a move-only
   value is copied". The cost is that the head misleads on every copy form.
2. **Drop the prefix on the copy forms; keep the code.** The head becomes the clause that is
   true: `` cannot copy `r.*`, whose type … ``. E0901 stays the code, and its registry summary
   already covers both cases. Four message sites and six goldens change.
3. **A new code for copies out of borrowed storage** (Rust's E0382/E0507 split). This is the most
   exact. But it renumbers a diagnostic that `yo explain`, `yo fix` and the migration notes cite,
   and `comptime_expect_error` callers that match on the code would have to choose a side.

## Recommendation

Option 2. The code already names both cases, so only the head is wrong, and removing four words
fixes it without a renumbering. Do it as one PR covering all four sites and re-recording the six
goldens, after the v0.2.76 migrations, so it does not collide with part B's golden churn.
