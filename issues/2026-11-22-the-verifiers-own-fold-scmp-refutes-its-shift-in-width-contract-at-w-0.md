# The verifier's own `_fold_scmp` refutes its shift-in-width contract at `w = 0`

**Severity:** S3 — a refuted contract in the compiler's own source, found by the local
self-verification ratchet (`scripts/verify-src-sweep.sh`); no user code is miscompiled and no
user-facing `yo verify` verdict is wrong today (the function is inside the verifier's own
constant folder, whose callers pass `w ∈ {8, 16, 32, 64}`).

- Filed: 2026-11-22 by the evalwork-memo lane, while gating
  `fix/evalwork-invariant-memo` (the verify-known leg of the borrow-checker Tier 1).
- Reproduces on the develop tip `2918c0c67` with a binary built from it, and identically on
  the lane branch (the refuted obligations, goals and model are byte-identical): the lane's
  change does not affect it.
- Not fixed in that PR (outside its lane).

## Reproducer

```bash
yo verify ./src/verifier/vc.yo --format json --std-path ./std
# summary: {"total":193,"ok":1,...,"unproven":0,"refuted":1,...}
```

`scripts/verify-src-sweep.sh` then fails its "a refutation is a bug" leg (and reports
`src/verifier/vc.yo: 0 -> 1` as a GAIN — the module began discharging obligations, which is
what exposed the refutation).

## What happens

`_fold_scmp` (`src/verifier/vc.yo:956`, V6 task 3) reads its sign bits as
`(a >> u64(w - usize(1))) & u64(1)`. The verifier's `shift-in-width` obligation for that
shift is `w - 1 < 64`, which Z3 refutes with `w = 0` (`w - 1` wraps). The callers gate the
width (`_fold_icmp` folds only the fixed widths), but the function's own signature carries
no `requires(w > 0)`, so verify-mode discharges the obligation from the signature alone and
finds the underflow.

## Fix direction

Spell the precondition at the function (`requires(w >= usize(1))` — or `w ∈ {8, 16, 32, 64}`
if that is the real contract), so the shift obligations discharge from the callers' widths;
re-run `scripts/verify-src-sweep.sh` (expect: no refuted function, the vc.yo gain locked in
with `--record`).
