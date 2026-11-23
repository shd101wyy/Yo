# A binding pattern over a `&mut` match may overwrite the value its `Box` sub-pattern binding borrows

**Severity:** S1 — safe code passes `yo check` and reads freed memory: the arm writes the whole scrutinee through the `(w := …)` binding while a binding under a `Box` sub-pattern still points into the old payload.

Filed 2026-11-23 by the test 7 lane while respelling the audit corpus's drifted negatives
(`scripts/test7/respell-manifest.tsv`, plan `plans/handover/VBD_V0279_RETIREMENTS_AND_CLAIM.md` §3.6). Probe: `probes/patterns-flow/t06.yo`
in `scripts/test7/audit-corpus.tar.gz`, respelled in `scripts/test7/respelled/`. Reproduced with a stage 1 of develop
`f06ff5889` (src and std unchanged through `b69bce2f5`).

## Reproducer

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  mut(o) := Option(Box(String)).Some(Box.new(String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz")));
  match(
    &mut o,
    (w := .Some(Box(s))) => {
      w.* = .None;
      println(`OUT: ${s}`);
    },
    .None => ()
  );
});
export(main);
```

```bash
yo check repro.yo --std-path ./std                    # rc 0: accepted
yo compile repro.yo --std-path ./std --optimize 1 --sanitize address --allocator system --cc clang -o t && ./t
# ERROR: AddressSanitizer: heap-use-after-free
```

The same pattern without the `Box` step is rejected: `(w := .Some(P(a : pa, b : _)))` in a `&mut` match is E0901
("`(w := …)` binds `pa` inside it, and in a `mut` match both would be `mut` places over the same storage";
probes `patterns-flow/g06.yo`, `g07.yo`).

## Root cause

`.At` in the pattern-ownership walk (`src/evaluator/exprs/match.yo`, around line 897) rejects a sub-binding of a
`(name := …)` pattern in a `mut` match, except when the sub-binding sits below a cell:
`bad := cond((in_cell || _names_contain(&own.borrowed, sn.clone())) => false, own.is_mut => true, …)`. A `Box(s)`
sub-pattern puts `s` in `own.borrowed`, so the exemption fires, and nothing else relates the borrow `s` makes into
the `Box` payload to the write `w.* = …`, which drops that payload.

## Fix

Fix the rule or wall the position: in a `mut` match, a `(name := …)` binding next to any sub-binding (a borrow below
a cell included) is the E0901 overlap, or the write through `name` is an access against the sub-binding's loan.
Then add the reproducer to `tests/origins/unsound/`.
