# A tuple literal may lend a place `&` after an earlier element lends it `&mut`

**Severity:** S1 — safe code passes `yo check` and reads freed memory: `(&mut x, &x)` holds a `&mut` and a `&` borrow of one place at once, and a write through the first frees what the second reads.

Filed 2026-11-23 by the test 7 lane while respelling the audit corpus's drifted negatives
(`scripts/test7/respell-manifest.tsv`, plan `plans/handover/VBD_V0279_RETIREMENTS_AND_CLAIM.md` §3.6). Probe: `probes/patterns-flow/t09.yo` and `t10.yo`
in `scripts/test7/audit-corpus.tar.gz`, respelled in `scripts/test7/respelled/`. Reproduced with a stage 1 of develop
`f06ff5889` (src and std unchanged through `b69bce2f5`).

## Reproducer

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  mut(x) := Box.new(String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"));
  t := (&mut x, &x);
  match(
    t,
    (a, b) => match(
      b,
      Box(s) => {
        a.* = Box.new(String.from("q"));
        println(`OUT: ${s.*}`);
      }
    )
  );
});
export(main);
```

```bash
yo check repro.yo --std-path ./std                    # rc 0: accepted
yo compile repro.yo --std-path ./std --optimize 1 --sanitize address --allocator system --cc clang -o t && ./t
# ERROR: AddressSanitizer: heap-use-after-free
```

The elements in the other order, `(&x, &mut x)`, are E0910 (probe `patterns-flow/t11.yo`), as are `(&mut x, &mut x)`
and `(&x, x)`.

## Root cause

`check_tuple_element_lends` (`src/evaluator/calls/function.yo`), the fix of
`issues/fixed/2026-11-11-a-tuple-literal-that-lends-a-place-and-moves-or-relends-it-gets-no-decision-28-overlap-check.md`,
looks at each element that lends a place and asks `_find_lent_place_access` whether a LATER element moves it,
overwrites it or lends it `&mut`. It never asks whether the earlier lend is itself `&mut`, so a later `&` lend of a
place an earlier element lends exclusively passes.

## Fix

When element `i` lends `&mut`, any later element touching the place (a `&` lend, a read) is the conflict. Add the
reproducer to `tests/origins/unsound/` (beside `a17-tuple-two-mut-lends-one-place.yo`).
