# A match guard may write the scrutinee while the arm's pattern bindings borrow it

**Severity:** S1 — use-after-free in safe code: `match(&mut o, (.Some(Box(s)) && { o = .None; true }) => println(s), _ => ())` is accepted. The guard frees the box that `s` borrows, and the arm then reads it (ASan heap-use-after-free). The same holds when the guard calls `kill(&mut o)`.

- Filed: 2026-11-19 by the test 7 lane, from the rehearsal of test 7 leg (b) (`scripts/test7.sh`; `plans/handover/VBD_V0279_RETIREMENTS_AND_CLAIM.md` §3.6). The program is from the 2026-11-11 audit's frozen probe corpus (`scripts/test7/audit-corpus.tar.gz`, `probes/patterns-flow/g02d.yo and g02b.yo`).
- Reproduces on develop `939fe7160` (a stage 1 of `d8f0d89fa`) and on the pending cluster branch `v0279/clusters` `76f6aaf03` (a stage 1 built from it). The cluster branch's fixes do not close it.
- **Status: OPEN.** It blocks claim (S) in v0.2.80 (VERDICTS-58 decision 7(b)) until it is fixed or walled. It does not gate the v0.2.79 cut.

## Reproducer

`issues/repros/2026-11-19-a-match-guard-may-write-the-scrutinee-while-the-arms-pattern-bindings-borrow-it.yo`:

```yo ignore
// expect: E0911
{ String } :: import("std/string");
{ println } :: import("std/fmt");
L :: (fn() -> String)(String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"));
main :: (fn() -> unit)({
  mut(o) := Option(Box(String)).Some(Box.new(L()));
  match(&mut o, (.Some(Box(s)) && { o = .None; true }) => println(`OUT: ${s}`), _ => ());
  ()
});
export(main);
```

Also `issues/repros/2026-11-19-a-match-guard-may-write-the-scrutinee-while-the-arms-pattern-bindings-borrow-it-callee.yo`: the guard writes through a call, `kill(&mut o)` (probe g02b).

```bash
yo check issues/repros/2026-11-19-a-match-guard-may-write-the-scrutinee-while-the-arms-pattern-bindings-borrow-it.yo --std-path ./std                       # rc 0: accepted
yo compile issues/repros/2026-11-19-a-match-guard-may-write-the-scrutinee-while-the-arms-pattern-bindings-borrow-it.yo --std-path ./std --optimize 1 --sanitize address --allocator system --cc clang -o t
ASAN_OPTIONS=detect_stack_use_after_return=1 ./t
```

ASan, on the cluster-branch binary (develop gives the same report):

```text
ERROR: AddressSanitizer: heap-use-after-free on address … thread T1
READ of size 72 at … thread T1
… is located 0 bytes inside of 72-byte region
SUMMARY: AddressSanitizer: heap-use-after-free
```

## What happens

A guard runs after the pattern has bound its variables, so the arm's bindings are live loans of the scrutinee's place while the guard runs. The write `o = .None` in the ARM body is E0911 ("`s` borrows `o` with `&mut` and is still live"), which is A15's fix. The same write in the GUARD is not checked against those bindings.

## Neighbours

- **Rejected, E0911:** the write in the arm body (`.Some(Box(s)) => { o = .None; … }`).
- **Rejected on `v0279/clusters`, E0910:** `p07` (a `Box` sub-pattern with the write in the arm), by the A3 wall.
- **Accepted, ASan heap-use-after-free:** both reproducers, on develop and on `v0279/clusters`.
- **Accepted without an ASan report:** the plain form `match(&mut o, (.Some(s) && { o = .None; true }) => println(s), _ => ())`, without the `Box`. The arm reads a dropped `String` in place and prints an empty string, which still violates the model.

## Audit row and cluster

A15 (`issues/fixed/2026-11-11-a-box-sub-pattern-of-a-mut-match-records-no-loan-so-the-arm-can-replace-the-box-under-its-binding.md`), cluster 3 ("a value position computes no origin": sub-patterns). The guard is a control position, so the shape also sits beside A36 (cluster 8, a move inside a guard). The audit ledger lists g02b/g02d under F2 (A15). This is a residual of a fixed row.

## Closing it

Fix the rule or wall the position (a rejection with an error code at exactly these positions). Then move the reproducers into `tests/origins/unsound/` so G-B pins the result, and add their attribution rows to `scripts/test7/attribution.tsv` as rejected.
