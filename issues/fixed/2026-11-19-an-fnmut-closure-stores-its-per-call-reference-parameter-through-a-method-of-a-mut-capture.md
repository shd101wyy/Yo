# An `FnMut` closure stores its per-call reference parameter through a method of a `&mut` capture

**Severity:** S1 — use-after-free in safe code: a closure `{ s : &mut slot }(v : &Rc(X)) => { _old := s.replace(v); }` passed as `&mut Impl(FnMut(v : &Rc(X)) -> unit)` stores the per-call `v` into the caller's `slot`. `each` drops the `Rc` after the call, and reading `slot` afterwards is an ASan heap-use-after-free.

- Filed: 2026-11-19 by the test 7 lane, from the rehearsal of test 7 leg (b) (`scripts/test7.sh`; `plans/handover/VBD_V0279_RETIREMENTS_AND_CLAIM.md` §3.6). The program is from the 2026-11-11 audit's frozen probe corpus (`scripts/test7/audit-corpus.tar.gz`, `probes/closures/h16.yo`).
- Reproduces on develop `939fe7160` (a stage 1 of `d8f0d89fa`) and on the pending cluster branch `v0279/clusters` `76f6aaf03` (a stage 1 built from it). The cluster branch's fixes do not close it.
- **Status: OPEN.** It blocks claim (S) in v0.2.80 (VERDICTS-58 decision 7(b)) until it is fixed or walled. It does not gate the v0.2.79 cut.

## Reproducer

`issues/repros/2026-11-19-an-fnmut-closure-stores-its-per-call-reference-parameter-through-a-method-of-a-mut-capture.yo`:

```yo ignore
// expect: E0923
// H2 through Option.replace (prelude method) on the captured slot
{ String } :: import("std/string");
{ println } :: import("std/fmt");
X :: struct(s : String);
each :: (fn(f : &mut Impl(FnMut(v : &Rc(X)) -> unit)) -> unit)({
  k := Rc.new(X(s : String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz")));
  f(&k);
});
main :: (fn() -> unit)({
  mut(slot) := Option(&Rc(X)).None;
  each(&mut ({ s : &mut slot }(v : &Rc(X)) => {
    _old := s.replace(v);
  }));
  match(slot, .Some(r) => println(`OUT: ${r.*.*.s.len().to_string()}`), .None => println("none"));
});
export(main);
```

```bash
yo check issues/repros/2026-11-19-an-fnmut-closure-stores-its-per-call-reference-parameter-through-a-method-of-a-mut-capture.yo --std-path ./std                       # rc 0: accepted
yo compile issues/repros/2026-11-19-an-fnmut-closure-stores-its-per-call-reference-parameter-through-a-method-of-a-mut-capture.yo --std-path ./std --optimize 1 --sanitize address --allocator system --cc clang -o t
ASAN_OPTIONS=detect_stack_use_after_return=1 ./t
```

ASan, on the cluster-branch binary (develop gives the same report):

```text
ERROR: AddressSanitizer: heap-use-after-free on address … thread T1
READ of size 8 at … thread T1
… is located 16 bytes inside of 32-byte region
SUMMARY: AddressSanitizer: heap-use-after-free
```

## What happens

The direct store `s.* = .Some(v)` in the same closure is E0923 ("Cannot store a value holding `v` into `slot` through the capture `s : &mut slot`: `v`'s origin is this literal's per-call parameter"). That is A35/A50's fix. The same store spelled as a method call on the capture, `s.replace(v)` (`Option.replace(self : &mut Self, v : T)`), is accepted. The method's `lend_through` into its receiver is not run against the capture's outer place, so the per-call origin of `v` escapes into `slot`.

## Neighbours

- **Rejected, E0923:** the direct store `s.* = .Some(v)`.
- **Accepted, ASan heap-use-after-free:** `s.replace(v)` in the probe, on develop and on `v0279/clusters`.

## Audit row and cluster

This neighbours A35 (`issues/fixed/2026-11-11-an-fnmut-closures-by-value-state-can-store-a-per-call-reference-parameter-or-a-body-local.md`) and A50 (`issues/fixed/2026-11-11-a-body-may-store-a-reference-to-its-own-by-value-capture-through-a-mut-capture.md`), both cluster 7 (captures). The missing step is a method's `lend_through` into a capture (A4's mechanism, cluster 5), so the fix belongs where A4's method form was fixed.

## Closing it

Fix the rule or wall the position (a rejection with an error code at exactly these positions). Then move the reproducers into `tests/origins/unsound/` so G-B pins the result, and add their attribution rows to `scripts/test7/attribution.tsv` as rejected.
