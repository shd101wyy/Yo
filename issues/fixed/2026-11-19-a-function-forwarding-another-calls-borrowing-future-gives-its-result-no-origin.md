# A function that forwards another call's borrowing future gives its result no origin

**Severity:** S1 — use-after-free in safe code: `f := fwd(&w, io)` where `fwd :: (fn(w : &W, io : Io) -> Impl(Future(unit, Io)))(w.show(io))` returns `w.show(io)`, a future that captures `&w.*`, is accepted, but `f` freezes nothing. Moving `w` while `f` is live then frees the `String` the resumed future prints (ASan heap-use-after-free).

- Filed: 2026-11-19 by the test 7 lane, from the rehearsal of test 7 leg (b) (`scripts/test7.sh`; `plans/handover/VBD_V0279_RETIREMENTS_AND_CLAIM.md` §3.6). The program is from the 2026-11-11 audit's frozen probe corpus (`scripts/test7/audit-corpus.tar.gz`, `probes/async-effects/n02m.yo, a generic `fwd(generic(T), t : &T, where(T <: Show))`; the reproducer is its non-generic reduction`).
- Reproduces on develop `939fe7160` (a stage 1 of `d8f0d89fa`) and on the pending cluster branch `v0279/clusters` `76f6aaf03` (a stage 1 built from it). The cluster branch's fixes do not close it.
- **Status: FIXED** on `v0280/s1-origins` (the v0.2.80 s1-origins lane). The reproducer is the G-B row `tests/origins/unsound/t7-forwarded-future-move.yo`.

## Reproducer

`tests/origins/unsound/t7-forwarded-future-move.yo` (the reproducer as filed, with its header comment):

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
yo check tests/origins/unsound/t7-forwarded-future-move.yo --std-path ./std                       # rc 0: accepted
yo compile tests/origins/unsound/t7-forwarded-future-move.yo --std-path ./std --optimize 1 --sanitize address --allocator system --cc clang -o t
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

## Root cause

A call's result type reads the callee BODY's type (`_evaluate_funcval_runtime_call`, `src/evaluator/calls/function.yo`:
"stamp the call result's resolved-concrete from the callee BODY's def-time-evaluated type"), and a borrowing future's
type names the places it holds by the parameters of whatever MADE it (decision 43 step 4: `Future(T, E, p)` over the
maker's parameters, mapped to the call's arguments by `_future_call_lends_into`). For `show` the maker is its own
`io.async`, so the call `w.show(io)` reads `self` and maps it to the receiver. For `fwd` the body's future is
`show`'s: its origin names `self`, which is no parameter of `fwd`, so `fwd(&w, io)` mapped nothing and the binding
`f` froze nothing. `fwd`'s return rule did judge the future correctly inside the body (`return_check` found the root
`w`, a parameter, and accepted the return): the definition knew the result was rooted at `w`, and nothing carried that
to the call sites.

## Fix

`return_check` (`src/evaluator/utils.yo`) records, for a returned borrowing future, the parameters among its roots
(`_note_fn_future_result_roots`). The record is keyed by the identity of the function's declared `Impl(Future(...))`
result, which the definition, its definition-time trial (evaluated under a function value minted for the trial) and
every call's result type share. A specialization of a generic function re-evaluates its result type, so its record is
also kept under the specialization's function id, which is what its call sites reach. `_note_future_producing_call`
(`src/evaluator/calls/function.yo`) restamps a call's future origin with the callee's recorded parameters
(`_callee_future_result_origins`) before it collects the future's borrows. The existing mapping
(`_future_call_lends_into`) then lends the caller's argument places: `f := fwd(&w, io)` freezes `w` and `eat(w)` is
E0911. This is R-CALL applied to an `Impl(Future)` result: the result's origin is the callee's own parameters,
substituted by the arguments at the call. For the two-hop form (`fwd2(w : &W, io)` returning `fwd(w, io)`), a
reference binding passed bare to such a parameter now lends its own place, so `fwd2`'s return rule finds the root `w`
too.

Rows (`tests/origins/unsound/`, every negative accepted before the fix): `t7-forwarded-future-move` (the reproducer),
`t7-forwarded-future-generic` (the audit probe `n02m`, a generic `fwd` over a trait method), `t7-forwarded-future-trait`
(a non-generic `fwd` over a trait method), `t7-forwarded-future-two-hop` (`fwd2` returns `fwd(w, io)`) and
`t7-forwarded-future-write` (a write to `w` while the future is live), all E0911; positive twins
`t7-forwarded-future-move-pos` (awaited before the move), `t7-forwarded-future-generic-pos` (the generic `fwd`'s future
awaited before the move) and `t7-forwarded-future-write-pos` (a shared read while the `&` future is live), all clean
under ASan.
