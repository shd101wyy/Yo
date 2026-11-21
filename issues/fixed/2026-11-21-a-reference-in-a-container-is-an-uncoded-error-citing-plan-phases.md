# A reference in a container or a cell is an uncoded error whose text cites plan phases

**Severity:** S3 — a deliberate rejection had no error code and told the user about internal plan phases (N2b, N2c, N2d) instead of what to write.

## Symptom

```yo ignore
{ ArrayList } :: import("std/collections/array-list");
main :: (fn() -> unit)({
  x := i32(1);
  mut(r) := ArrayList(&i32).new();
  r.push(&x);
});
export(main);
```

```text
error: A value of `ArrayList(&i32)` carries an origin inside a container or a cell, which the remaining pieces of first-class storage open (decision 43 step 3): containers over reference-holding elements arrive with N2c (their std generic bodies and their flow-set growth), cell payloads with N2d (and N1d's `Escapable`). An inline composite — a value struct or enum, a tuple, an array — holds references from N2b on.
  --> r1.yo:4:29
```

`RefCell(&i32).new(&x)`, `Box(&i32)` and `HashMap(i32, &i32)` reported the same text.

## Verdict: rejected by design

`plans/backlog/REFERENCES_AND_ORIGINS.md` (status header, re-placed 2026-11-13 by VERDICTS-58 decision
9): N2c–N2f are post-VBD, "the container/cell wall, E0909, stands". `plans/handover/D43_STEP3_N2_DESIGN.md`
T7: E0909 keeps its number for the no-origin positions, its text restated. So the rejection is right and
its code is E0909, the code the same wall already carries at a module-level binding, an `extern`
signature and an `Rc`/`Arc` payload (`no_origin_position_error`). The guide
(`docs/en-US/OWNERSHIP_AND_BORROWING.md`, "Where a reference may not go") listed the positions together.

## Root cause

`origin_beyond_n2b_message` (`src/types/utils.yo`) returned a bare message, and its five throw sites
(the member access `ArrayList(&i32).new`, a struct constructor's field, a call result, a fieldless
variant, a run-time signature) wrapped it with `format_error_message`, which carries no code. The text
was written for the implementers of the next phase.

## Fix

`origin_beyond_n2b_error(ty, tok)` builds the error with E0909 and a help line; every site throws it.
The message names the positions (an element of a collection, the payload of a cell or a counted handle)
and the help names the remedy (owned values, an index or key, or an inline composite, which may hold a
reference). `yo explain E0909` lists the positions. Phase names are gone from the user text.

## Tests

- `tests/cli-cases/a-reference-in-a-container-is-e0909` and
  `tests/cli-cases/a-reference-in-a-cell-is-e0909`: `error[E0909]` with the new text. Before the fix the
  golden's first line was the uncoded message above.
- `tests/borrow-spelling.test.yo`'s two `comptime_expect_error` rows follow the new text.
- `tests/origins/corpus.tsv`: the rows whose first error is this wall record `E0909` in their
  `today` column (previously `-`).
