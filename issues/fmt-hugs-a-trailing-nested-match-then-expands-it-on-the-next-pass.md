# `yo fmt` hugs a trailing nested `match`, then expands it on the next pass

**Severity:** S3 — fmt cosmetics: `yo fmt` is not idempotent on this shape, so one `yo fmt` run leaves a file that `yo fmt --check` (GATE 6) rejects; a second run fixes it.

**Status: OPEN.** Found 2026-10-03 while formatting `tests/async/combinators.test.yo` for phase A1 of `plans/ASYNC_IO_API_AUDIT.md`. **Measured on:** the v0.2.49 seed and a tree build of develop `576be6e06`; both behave the same.

## Symptom

`issues/repros/fmt-hugs-a-trailing-nested-match-then-expands-it-on-the-next-pass.yo`, a one-line `match` whose LAST arm is another `match` too long for the line:

```rust
match(a, .Ok(_) => (), .Err(e) => match(e, .A => { score = (score + i32(10)); }, .B => ()));
```

Pass 1 keeps the outer call on one line and hugs the inner `match` as its last argument:

```rust
match(a, .Ok(_) => (), .Err(e) => match(
  e,
  .A => {
    score = (score + i32(10));
  },
  .B => ()
));
```

Pass 2 then expands the outer call one argument per line:

```rust
match(
  a,
  .Ok(_) => (),
  .Err(e) => match(
    e,
    ...
  )
);
```

`yo fmt --check` after pass 1 reports the file as needing formatting.

## Expected

One pass reaches the fixpoint: either form, but the same one both times.

## Cause (not yet traced)

The last-argument hug decision for the outer call appears to be made on the inner call's FLAT width, and the expansion decision on the next pass on the already-broken inner call's line count. The two passes disagree because the input differs.

## Fix direction

Make the hug test depend on the inner call's broken shape on both passes (or forbid hugging an arm whose body breaks). Regression test: a formatter test that formats the reproducer twice and asserts the passes are byte-identical.
