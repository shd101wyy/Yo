# A `&mut` argument to a local closure is not checked against a reference argument of the same call

**Severity:** S1 — use-after-free in safe code: `e := first(&xs); v := c(&mut xs, e)` with `c` a local `Impl(Fn)` closure that clears `ys` and then reads `r` is accepted. The closure frees the element `e` points to, and the read is an ASan heap-use-after-free.

- Filed: 2026-11-19 by the test 7 lane, from the rehearsal of test 7 leg (b) (`scripts/test7.sh`; `plans/handover/VBD_V0279_RETIREMENTS_AND_CLAIM.md` §3.6). The program is from the 2026-11-11 audit's frozen probe corpus (`scripts/test7/audit-corpus.tar.gz`, `probes/calls/c19_closure_call.yo`).
- Reproduces on develop `939fe7160` (a stage 1 of `d8f0d89fa`) and on the pending cluster branch `v0279/clusters` `76f6aaf03` (a stage 1 built from it). The cluster branch's fixes do not close it.
- **Status: FIXED** on `v0280/s1-calls` (2026-11-20). It blocked claim (S) in v0.2.80 (VERDICTS-58 decision 7(b)). See "Fix" below.

## Reproducer

`tests/origins/unsound/c2-local-closure-mut-arg-beside-ref-arg.yo`:

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
yo check tests/origins/unsound/c2-local-closure-mut-arg-beside-ref-arg.yo --std-path ./std                       # rc 0: accepted
yo compile tests/origins/unsound/c2-local-closure-mut-arg-beside-ref-arg.yo --std-path ./std --optimize 1 --sanitize address --allocator system --cc clang -o t
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

## Fix

`call_origin_operands` (`src/evaluator/utils.yo`) lists the operands whose value carries an origin into the callee:
an argument passed to a `&`/`&mut` slot, or one whose type hands an origin on. Two-phase activation keeps a `&` loan
live at a `&mut` argument while one of those operands mentions it. The slots came from `projection_call_callee_type`,
which answers a closure-typed callee only when its trait returns a reference (`Fn(...) -> &T`). For
`c : Impl(Fn(ys : &mut ArrayList(String), r : &String) -> usize)` it answered nothing, and `e` (read at its pointee
`String` there) passed for an operand that carries nothing. So the loan's last use was the argument itself, before
the activation, and the `&mut xs` write did not meet it.

The slots now come from `_call_binding_func_type`: a function-typed callee's own type (a named function, a function
pointer), a closure-typed callee's trait call type (`fn_trait_call_func_type`: `Impl(Fn)`, `Dyn(Fn)`, a type variable
bounded by `Fn`) whatever it returns, else the method dispatch's. `c(&mut xs, e)` is E0911, as `plain(&mut xs, e)` was.

The function-pointer callee (`(g : fn(...) -> unit) = f`) already read its slots through its function type and
reproduced on neither the cluster branch nor this one. Both `args:named/*/closure/*` and `args:named/*/fnptr/*` leave
`tests/origins/gen-known.tsv`.

G-D evidence: the generator signatures `args:named/mutlend/closure/first` and `args:named/mutlend/closure/second`
(`YO_GEN_SEED=168296 python3 -I scripts/origins-gen.py --sig <sig> --known /dev/null --no-rustc`) are
`r := &x; g(r, &mut x)` and `g(&mut x, r)`, where `g` is a local `Impl(Fn)` closure that does `o.push_str` and then
reads `v`. Both are accepted and an ASan heap-use-after-free on `v0280/clusters`. On this branch both are rejected,
and `--verify-known` over the two former rows reports `args:named/*/closure/*: FIXED (0/4 rustc-rejected programs
accepted, 0 under ASan UAF)` and the same for `args:named/*/fnptr/*`.

Tests (G-B, `tests/origins/unsound/`): `c2-local-closure-mut-arg-beside-ref-arg.yo` (the probe),
`-second.yo` (the loan as the first argument), and the positive twin `-pos.yo`.
