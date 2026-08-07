> **FIXED — verified 2026-08-06** (the status header below is stale): the reproducer is checked in as tests/codegen-bootstrap/constructor_result_drop.yo, in the DIFF-0 corpus.

# TS codegen: constructor_result_drop.yo crashes at -O0 (pre-existing, TS-side)

**Status: OPEN.** Pre-existing — reproduces identically under pre-port binaries
(verified with /tmp/s1fix11-era diff runs: `ts_rc=139 self_rc=0`). NOT caused by
the yo-self dup/drop optimizer port; the port actually resolved the OTHER
long-standing corpus DIFF (`ptr_deref_copy_rc_struct.yo` now PASSes, corpus
138→139 PASS).

## Symptom

`tests/codegen-bootstrap/constructor_result_drop.yo` compiled by the **TS**
compiler at **-O0** (the diff-test harness default, no `--release`) SIGSEGVs
deterministically:

```
EXC_BAD_ACCESS (address=0x38)
  fn_..._keep + 92            <- field read through a NULL/dangling ref
  fn_..._build_and_discard
  __yo_user_main
```

At `--release` (-O2) the same program runs rc=0 — the dead/dangling read is
presumably elided or register-cached. The self-hosted binary passes at BOTH
levels (rc=0), so the harness reports DIFF `ts_rc=139 self_rc=0`.

## Notes

- The test asserts exact `Gc.tracked_count()` values around ref-struct
  constructor temps — precisely the RC-drop-timing area, so the -O0 crash
  likely indicates a premature drop (UAF) in TS's constructor-temp handling
  that -O2 happens to mask. Needs its own TS-side arc: emit the -O0 C, find
  the read in `keep`, and trace which drop freed the Node early.
- Until fixed, `constructor_result_drop.yo` is the one expected DIFF in
  `scripts/diff-test.sh tests/codegen-bootstrap` (PASS 139 DIFF 1).
