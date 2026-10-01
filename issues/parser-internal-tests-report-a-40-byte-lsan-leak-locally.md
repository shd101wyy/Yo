# Five parser internal tests fail under local LeakSanitizer with a 40-byte leak CI never sees

**Severity:** S3 — a local-only LSan signal on `tests/internal/parser.test.yo` makes the whole suite red on this box and can mask a REAL new leak; CI stays green, so nothing tracks it.

**Status: OPEN (environment-scoped).** Found 2026-10-01 while gating the
same-operator-chain parser fix
(`issues/fixed/same-operator-chain-of-four-or-more-is-not-left-associative.md`).
**Measured on:** this WSL2 box (nix clang 21.1.7, LSan via `--sanitize address`),
`--std-path ./std`.

## The failure matrix

`yo test tests/internal/parser.test.yo --parallel 1` fails the same 5 tests
for every combination measured:

| parser source | binary | result |
| --- | --- | --- |
| develop's `src/parser.yo` (swapped in clean) | tree-built, the chain fix | 2/2 matched tests fail ("Parse ?= with multi-line parenthesized -> RHS", "Parse colon : with multi-line parenthesized -> RHS in struct field") |
| the chain fix (either implementation) | tree-built | all 5 fail (the two above plus "Reject whitespace-separated call f a, b", "Reject removed slice type [T]", "Reject removed slice type [T;]") |
| the chain fix | installed v0.2.48 | same 5 fail |

Each failure is the runner's `Memory leak detected` verdict, not an
assertion: the child reports `Direct leak of 40 byte(s) in 1 object(s)`
with the allocation attributed (after inlining) to the parser's top-level
statement loop. CI's `tests/internal` job is green on develop, so CI's
LeakSanitizer does not reproduce it.

## What this is NOT

- Not caused by the chain fix: develop's parser source fails identically on
  this box.
- Not the `HashMap` the fix's first implementation carried: the leak
  persists after that implementation was replaced by a zero-new-state
  token-scan.
- Not a functional break: with `YO_TEST_LEAK_VERDICT=0` the suite's
  assertions pass.

## Root cause (unresolved)

Either (a) a genuine 40-byte leak in the parser/evaluator path those five
tests exercise that CI's ASan build cannot see (different interceptor
coverage, allocation folding), or (b) an LSan artifact of this box's nix
clang runtime. Distinguishing needs the LSan stack symbolized on both
platforms (`-g` on the emitted C, or a CI job with `ASAN_OPTIONS=...
symbolize=1` dumping the same child).

## Fix direction

Symbolize the 40-byte allocation in a CI-visible configuration; if real,
fix the missing drop; if an artifact, pin the runner's local LSan verdict
off for these tests (as `YO_TEST_LEAK_VERDICT=0` does) with a comment
pointing here so a real leak does not hide behind it.
