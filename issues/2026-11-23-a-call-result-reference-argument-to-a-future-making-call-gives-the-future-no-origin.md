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
