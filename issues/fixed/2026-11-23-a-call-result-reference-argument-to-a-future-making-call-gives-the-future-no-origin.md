# A call-result reference argument to a future-making call gives the future no origin

**Severity:** S1 — safe code passes `yo check` and reads freed memory: the future borrows an element of `xs`, `xs.clear()` runs before the await, and the awaited body reads the freed element.

Filed 2026-11-23 by the test 7 lane while respelling the audit corpus's drifted negatives
(`scripts/test7/respell-manifest.tsv`, plan `plans/handover/VBD_V0279_RETIREMENTS_AND_CLAIM.md` §3.6). Probe: `probes/calls/e04_async_ref_into_future.yo`
in `scripts/test7/audit-corpus.tar.gz`, respelled in `scripts/test7/respelled/`. Reproduced with a stage 1 of develop
`f06ff5889` (src and std unchanged through `b69bce2f5`).

## Reproducer

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
{ ArrayList } :: import("std/collections/array-list");
mkf :: (fn(r : &String, io : Io) -> Impl(Future(usize, Io)))(io.async({ r : &r.* }(io : Io) => r.clone().len()));
main :: (fn(io : Io) -> unit)({
  mut(xs) := ArrayList(String).new();
  xs.push(String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"));
  fut := mkf(xs.index(usize(0)), io);
  xs.clear();
  v := io.await(fut, io);
  println(`OUT: ${v.to_string()}`);
});
export(main);
```

```bash
yo check repro.yo --std-path ./std                    # rc 0: accepted
yo compile repro.yo --std-path ./std --optimize 1 --sanitize address --allocator system --cc clang -o t && ./t
# ERROR: AddressSanitizer: heap-use-after-free
```

The probe's own argument, `mkf(first(&xs), io)` with `first :: (fn(xs : &ArrayList(String)) -> &String)`, is
accepted and dirty the same way. A reference bound first is checked: `r := first(&xs); fut := mkf(r, io);` is
E0911 at `xs.clear()`, and `mkf(&s, io)` then `drop(s)` is E0911.

## Root cause

Not traced to a line. The future a call returns gets the origins of the call's reference arguments when the
argument is a place lend (`&s`) or a reference binding (`r`); an argument that is itself a call returning a
reference (`xs.index(0)`, `first(&xs)`) contributes no origin, so the future freezes nothing. This is the
future-result twin of audit cluster 1 ("an argument's value is not a loan", A1/A2).

## Fix

Give a call-result reference argument its own lend (the cluster 1 design: every origin-carrying argument value is a
hidden temporary for the call) when computing the result future's origin. Add the reproducer to
`tests/origins/unsound/`.

## Fixed

Fixed on `v0280/s1-test7b` (2026-11-23). The future a call returns gets its places from
`_future_call_lends_into` (`src/evaluator/calls/function.yo`), which maps each callee parameter the future's origin
names to the call's argument: a place lend (`&s`), a bound reference (`r`), or a by-value argument whose type
carries an origin. A computed reference (`xs.index(0)`, `first(&xs)`: a projection call's result, typed as its
pointee) matched none of them, so the future recorded no root and its binding froze nothing. A computed reference
argument (`is_computed_reference_operand`) now contributes `origin_of` of the argument, R-CALL over its own root
arguments, exactly as an origin-carrying by-value argument does. `fut := mkf(xs.index(0), io); xs.clear()` is
E0911 at `xs.clear()`, as the bound form `r := xs.index(0); fut := mkf(r, io)` already was.

The argument's origin can name a temporary (R-TEMP): `mkf(c.borrow_mut().get(), io)` reads through a temporary
guard whose `Drop` replaces the box the future points into when the statement ends. That variant was accepted and
ASan-dirty on develop too, and the first cut of this fix dropped the entry again: the future's roots are recorded
by root NAME (`FutureRoot`) and read back through the environment, where `#temporary` names no binding. A
`FutureRoot` (and the `_FutureLend` it is made from) now keeps the entry's text, and `_future_value_roots_into`
returns an R-TEMP / R-ARM root as the entry itself, so `fut := mkf(c.borrow_mut().get(), io)` is rejected as
`r := c.borrow_mut().get()` is, while `io.await(mkf(c.borrow_mut().get(), io), io)` — awaited in the statement that
made it — stays accepted.

G-B: `tests/origins/unsound/t7-future-call-result-ref-arg.yo` (the reproducer), `t7-future-call-result-ref-arg-free-fn.yo`
(the probe's `first(&xs)` form, e04), `t7-future-call-result-ref-arg-temp-guard.yo`, and the positive twins
`t7-future-call-result-ref-arg-pos.yo` (`xs` cleared after the awaits) and `t7-future-call-result-ref-arg-temp-guard-pos.yo`.
