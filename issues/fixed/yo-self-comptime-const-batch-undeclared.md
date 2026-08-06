# yo-self: `NAME :: <ctfe call>` inside a test-batch arm emits an undeclared C identifier

**Status:** OPEN. Surfaced 2026-07-29 while adding the unary-neg regression
test; dodged in that test by inlining the call into `comptime_assert`.

## Repro shape

Inside a `test("...", { ... })` block (i.e. a batch-arm context):

```rust
abs :: (fn(comptime(x) : i32) -> comptime(i32))(cond((x >= i32(0)) => x, true => -(x)));
G :: abs(i32(-(50)));
assert(G == i32(50), "...");
```

s1 emits `use of undeclared identifier 'G'` at the assert — the comptime
const folds nowhere and the reference survives as a bare C identifier.
STANDALONE (a plain `main`), the same three lines compile and run clean —
batch-arm context only.

TS compiles the batch fine (tests/operator_grouping.test.yo passed 4/4 under
TS with the `G ::` form).

## Why it matters

`::`-bound CTFE results inside test blocks are common in the corpus
(`tests/spec/contracts_phase0.test.yo` arms 21/25/26 use `GOOD ::`/`R ::`,
`tests/comptime.test.yo` likely too) — this may be (part of) the REMAINING
hollow root in those files after `0226c4865`. Verify by running the per-arm
sweep (recipe: extract arms with the paren-matching splitter, see
/tmp/cp0_arms pattern) against the arms that use `NAME ::` bindings.
