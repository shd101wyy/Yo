# Should trap-freedom be a default verifier obligation? The model wraps where safe code aborts

**Kind:** design question — an open decision, not a defect. Filed 2026-10-14
from the F\* audit's assessment of the verifier
(`plans/backlog/FSTAR_ADOPTION_CANDIDATES.md`; the gap itself is recorded
in `plans/backlog/SAFE_MODE_5B_VERIFIED_GUARD_ELISION.md` §2.1 and §5.2 and
in `plans/SAFE_MODE.md` §14 R4).

## The question

Two documented facts disagree about what a proof means:

- **Safe code traps.** `+`, `-`, `*`, unary negation, `MIN / -1` and
  out-of-width shifts abort with a diagnostic, never wrap
  (`docs/en-US/MEMORY_SAFETY.md` §Integer Overflow).
- **The verifier wraps.** Integers are exact-width bitvectors; `+ - *`
  map to `bvadd bvsub bvmul` and `/` to `bvsdiv`, so the model continues
  past an overflow with the wrapped value. The overflow obligations
  (`no-overflow`, `div-no-overflow`, `neg-no-overflow`) exist but are
  **elision-only**: a plain `yo verify` never asks them
  (`docs/en-US/FORMAL_VERIFICATION.md` §The verifiable subset: "Proving
  that the overflow trap is *never taken* is not an obligation yet").

The 5b plan proves this is sound (the modeled states are a superset of the
reachable ones, §5.2) and measures the cost in completeness: `add_near_max`
with `requires(a > 2147483000)` and body `a + 1000` verifies `ok` with zero
obligations although every call traps (§2.1). So today a verified function
is verified *modulo traps*: "a proven `ensures` holds whenever the function
returns". That undercuts two stated principles at once — D8, "absence of
runtime errors on unannotated code", since an integer trap is a runtime
error the verifier does not report; and D6, "proofs are about the program
that runs", since the program that runs aborts where the model wraps.

A second, dependent question: with trap-freedom proved, is the bitvector
theory still the right encoding for `+ - * < <=`? Dafny, SPARK and Verus
model arithmetic as unbounded integers with range side conditions and keep
bitvectors for bitwise and explicitly wrapping operations; linear integer
arithmetic is decidable and far cheaper than bit-blasting a 64-bit
multiply. D6 chose bitvectors to match `-fwrapv` C, which is the semantics
of `wrapping_*` and of unsafe code, not of safe arithmetic.

## Recommendation

1. **Make the three overflow obligations default in every verify mode**,
   not `--elision`-only. They exist, they have fixtures, and the report
   already prints them under `--elision`. The cost is honesty: fixtures and
   std contracts that lean on silent wrapping will refute and need the
   range `requires` their arithmetic needs (the docs' own troubleshooting
   advice for an extreme-value counter-example). Under `VerifyOrAssert` an
   overflow obligation that is merely `unproven` keeps its runtime trap;
   one that is `refuted` fails the build as any refutation does, so the
   switch needs the fixture and std sweep first.
2. Keep `wrapping_*` / `saturating_*` / `checked_*` and bitwise operators
   on the bitvector model with no obligation; they are the operations whose
   meaning *is* the wrap.
3. **Measure the integer theory before deciding it.** Re-encode `+ - *`
   and comparisons over the fixtures as unbounded integers with
   `no-overflow` as a range side condition (the obligation is then the
   range check itself), and compare query time, rlimit escalations and
   verdicts against the bitvector encoding on `tests/spec/fixtures/` and
   the SELF_VERIFICATION M1 arithmetic laws. Adopt the hybrid only if the
   measurement shows the gain; D6's principle (the model matches the
   program that runs) is kept either way, because with traps as
   obligations the integer model *is* the safe-code semantics.
4. The same obligations feed CP2f (`plans/CODEGEN_PERFORMANCE.md`): every
   `no-overflow` the verifier proves by default is a trap codegen may
   elide, which is the 5b plan's point.
