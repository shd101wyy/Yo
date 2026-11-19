# A `&mut` argument to a local closure is not checked against a reference argument of the same call

**Severity:** S1 — use-after-free in safe code: `e := first(&xs); v := c(&mut xs, e)` with `c` a local `Impl(Fn)` closure that clears `ys` and then reads `r` is accepted. The closure frees the element `e` points to, and the read is an ASan heap-use-after-free.

- Filed: 2026-11-19 by the test 7 lane, from the rehearsal of test 7 leg (b) (`scripts/test7.sh`; `plans/handover/VBD_V0279_RETIREMENTS_AND_CLAIM.md` §3.6). The program is from the 2026-11-11 audit's frozen probe corpus (`scripts/test7/audit-corpus.tar.gz`, `probes/calls/c19_closure_call.yo`).
- Reproduces on develop `939fe7160` (a stage 1 of `d8f0d89fa`) and on the pending cluster branch `v0279/clusters` `76f6aaf03` (a stage 1 built from it). The cluster branch's fixes do not close it.
- **Status: OPEN.** It blocks claim (S) in v0.2.80 (VERDICTS-58 decision 7(b)) until it is fixed or walled. It does not gate the v0.2.79 cut.

## Reproducer

`issues/repros/2026-11-19-a-mut-argument-to-a-local-closure-is-not-checked-against-a-reference-argument-of-the-same-call.yo`:

```yo ignore
// expect: E0911
{ String } :: import("std/string");
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
first :: (fn(xs : &ArrayList(String)) -> &String)(&xs(usize(0)));
long :: (fn() -> String)(String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"));
H :: (fn(comptime(p) : Origin) -> comptime(Type))(struct(r : &(String, p)));
main :: (fn() -> unit)({
  mut(xs) := ArrayList(String).new();
  xs.push(long());
  (c : Impl(Fn(ys : &mut ArrayList(String), r : &String) -> usize)) = ((ys : &mut ArrayList(String), r : &String) => { ys.clear(); r.clone().len() });
  e := first(&xs);
  v := c(&mut xs, e);
  println(`OUT: ${v.to_string()}`);
});
export(main);
```

```bash
yo check issues/repros/2026-11-19-a-mut-argument-to-a-local-closure-is-not-checked-against-a-reference-argument-of-the-same-call.yo --std-path ./std                       # rc 0: accepted
yo compile issues/repros/2026-11-19-a-mut-argument-to-a-local-closure-is-not-checked-against-a-reference-argument-of-the-same-call.yo --std-path ./std --optimize 1 --sanitize address --allocator system --cc clang -o t
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

The same call to a plain function, `plain(&mut xs, e)`, is E0911 ("`e` borrows `xs` with `&` and is still live"). The cluster lane's rule G (`v0279/clusters`, A6) makes every `&mut` argument a write at the call's activation, but only for the pending entries its recorders see. Both recorders run on `fn_param_mut_ref_flags` slots, and a call through a LOCAL closure value records none. So the `&mut xs` argument of `c(&mut xs, e)` never meets `e`'s loan.

This is the bodyless half that `tests/origins/gen-known.tsv` still lists as `args:named/*/closure/*` and `args:named/*/fnptr/*` (A6). That row cites `issues/2026-11-12-a-mut-argument-to-a-callee-that-neither-writes-nor-lends-it-is-a-read.md`, which `v0279/clusters` moves to `issues/fixed/` with the status "item 1 FIXED". The closure and function-pointer callees are not fixed. This document is the open record for them; the two gen-known rows should cite it once the cluster branch merges.

## Neighbours

- **Rejected, E0911:** the same call to a plain function.
- **Rejected:** `e := &xs(usize(0))`, by the element-lend wall ("A local borrow needs a place").
- **Accepted:** the probe itself, through a local closure.

## Audit row and cluster

A6's bodyless half (cluster 2: "an access reaches the loan table weaker than its mode"). It also falls in A1's family (cluster 1: "an argument's value is not a loan"), since `e` is a loan-carrying argument value beside `&mut xs`. The audit ledger filed this probe under K-F1, the A1/P9 family.

## Closing it

Fix the rule or wall the position (a rejection with an error code at exactly these positions). Then move the reproducers into `tests/origins/unsound/` so G-B pins the result, and add their attribution rows to `scripts/test7/attribution.tsv` as rejected.
