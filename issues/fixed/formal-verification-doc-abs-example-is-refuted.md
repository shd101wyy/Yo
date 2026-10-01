# FORMAL_VERIFICATION.md's first contract example does not verify

**Severity:** S3 — the first example a reader copies from the verification guide is refuted by `yo verify`.

**Status: FIXED 2026-10-01** in the PR that filed this doc.

## Symptom

`docs/en-US/FORMAL_VERIFICATION.md` and `docs/zh-CN/FORMAL_VERIFICATION.md`
opened the Contracts section with

```rust
abs_i32 :: (fn(x : i32, ensures(r >= i32(0))) -> (r : i32))(
  if(x < i32(0), i32(0) - x, x)
);
```

and `yo verify` (0.2.47, Z3 5.1.0) refutes it:

```
  refuted  fn@fv_doc.yo:0 [verify]
    fn@fv_doc.yo:0/ensures#0: REFUTED  counter-example: x = #x80000000
```

## Cause

The verifier is right. At `x = i32(-2147483648)`, `i32(0) - x` has no
non-negative result, and the verifier models the emitted C exactly. The
example was missing the precondition that the spec test's own `abs_i32`
carries (`tests/spec/verify_straight_line.test.yo`:
`requires(x >= i32(-2147483647))`).

## Fix

Both language versions now carry the same `requires` as the spec test, plus
a short note explaining why it is needed and what `yo verify` reports
without it.

## Verification

The block in each language, extracted verbatim with `export(abs_i32, safe_div);`
appended:

```
before: verify: 1 ok, … 1 refuted …   (abs_i32 refuted, safe_div ok)
after:  verify: 2 ok, … 0 refuted …
```

```bash
awk 'NR>=20 && /^```rust$/ {f=1; next} f && /^```$/ {exit} f' docs/en-US/FORMAL_VERIFICATION.md > /tmp/fv.yo
echo 'export(abs_i32, safe_div);' >> /tmp/fv.yo
yo verify /tmp/fv.yo
```

No automated guard was added: Markdown code blocks are not checked by any
harness (`scripts/check-doc-blocks.py` reads `///` doc comments in `.yo`
files and checks parsing only), and `tests/cli-cases` run without a solver.
The contract itself is proved in CI by `abs_i32` in
`tests/spec/verify_straight_line.test.yo`, which the example now matches.
