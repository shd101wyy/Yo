# A function that forwards another call's borrowing future gives its result no origin

**Severity:** S1 — use-after-free in safe code: `f := fwd(&w, io)` where `fwd :: (fn(w : &W, io : Io) -> Impl(Future(unit, Io)))(w.show(io))` returns `w.show(io)`, a future that captures `&w.*`, is accepted, but `f` freezes nothing. Moving `w` while `f` is live then frees the `String` the resumed future prints (ASan heap-use-after-free).

- Filed: 2026-11-19 by the test 7 lane, from the rehearsal of test 7 leg (b) (`scripts/test7.sh`; `plans/handover/VBD_V0279_RETIREMENTS_AND_CLAIM.md` §3.6). The program is from the 2026-11-11 audit's frozen probe corpus (`scripts/test7/audit-corpus.tar.gz`, `probes/async-effects/n02m.yo, a generic `fwd(generic(T), t : &T, where(T <: Show))`; the reproducer is its non-generic reduction`).
- Reproduces on develop `939fe7160` (a stage 1 of `d8f0d89fa`) and on the pending cluster branch `v0279/clusters` `76f6aaf03` (a stage 1 built from it). The cluster branch's fixes do not close it.
- **Status: OPEN.** It blocks claim (S) in v0.2.80 (VERDICTS-58 decision 7(b)) until it is fixed or walled. It does not gate the v0.2.79 cut.

## Reproducer

`issues/repros/2026-11-19-a-function-forwarding-another-calls-borrowing-future-gives-its-result-no-origin.yo`:

```yo ignore
// expect: E0911 (`f` borrows `w` through `fwd`, so moving `w` while `f` is live is rejected)
{ String } :: import("std/string");
{ println } :: import("std/fmt");
{ yield } :: import("std/async");
W :: struct(s : String);
impl(W, show : (fn(self : &Self, io : Io) -> Impl(Future(unit, Io)))(
  io.async({ self : &self.* }(io : Io) => {
    io.await(yield(io), io);
    println(`OUT: ${self.*.s}`);
  })
));
fwd :: (fn(w : &W, io : Io) -> Impl(Future(unit, Io)))(w.show(io));
eat :: (fn(w : W) -> unit)(());
main :: (fn(io : Io) -> unit)({
  w := W(s : String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"));
  f := fwd(&w, io);
  eat(w);
  io.await(f, io);
});
export(main);
```

```bash
yo check issues/repros/2026-11-19-a-function-forwarding-another-calls-borrowing-future-gives-its-result-no-origin.yo --std-path ./std                       # rc 0: accepted
yo compile issues/repros/2026-11-19-a-function-forwarding-another-calls-borrowing-future-gives-its-result-no-origin.yo --std-path ./std --optimize 1 --sanitize address --allocator system --cc clang -o t
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

`w.show(io)` called directly, then `eat(w)` while the future is live, is E0911: the callee lend (#1602) re-roots the
future's borrow at the argument place `w`. Wrap the same call in a one-line function and the borrow is lost:

- `fwd`'s body is accepted, since returning a borrowing future rooted at the function's own `&` parameter is allowed (`plans/VALUES_BY_DEFAULT.md` §3.13 A2).
- At the caller, `fwd(&w, io)`'s result carries no origin of `w`. The rule's second half says "at the call site the result then borrows the argument places lent to those parameters", and that half is missing.
- The program also reproduces with `fwd` generic over `T : Show` (the probe), so the hole is not the generic by-value case of A52.

## Neighbours

- **Rejected, E0911:** `f := w.show(io); eat(w)`, which is the direct call.
- **Accepted, ASan heap-use-after-free:** a generic `fwd(generic(T : Type), t : &T, where(T <: Show))` calling a trait method `t.show(io)`. That is the corpus probe `n02m`.
- **Accepted, ASan heap-use-after-free:** a non-generic `fwd(t : &W, io)` calling the trait method.

## Audit row and cluster

This neighbours A52 and A51 (cluster 7, captures and futures): `issues/fixed/2026-11-11-a-borrow-of-a-by-value-parameter-of-a-generic-body-freezes-nothing.md` and `issues/fixed/2026-11-11-a-future-made-over-a-by-value-origin-carrying-parameter-does-not-freeze-the-callers-argument.md`. The audit ledger filed this probe under A52. Its mechanism is the result origin of a call whose callee returns a borrowing future through another call, so it is also a cluster 5 shape ("a signature is trusted without its check": R-CALL is not applied to an `Impl(Future)` result). Related open S2: `issues/2026-10-25-a-borrowing-future-returned-through-a-delegating-call-is-rejected.md`. Its reproducer no longer reaches its shape (`self.m(io)` is E0926 now, spelled `self.*`), but this document's `fwd` body, a delegating return of a borrowing future, is accepted on develop, so that S2's definition half is closed and the caller half is the hole recorded here.

## Closing it

Fix the rule or wall the position (a rejection with an error code at exactly these positions). Then move the reproducers into `tests/origins/unsound/` so G-B pins the result, and add their attribution rows to `scripts/test7/attribution.tsv` as rejected.
