# Origins are lost through an inline temporary receiver chain, so a copied zip item escapes into an outer holder

**Severity:** S1 (a safe program the checker accepts whose stored borrow outlives its lists — a would-be
use-after-free through `o`; blocks claim (S), which v0.2.79 lists as pending and v0.2.80 asserts)

Filed 2026-11-18 by the redfix audit lane (probe `s1`), against develop `581bf17d9` (present before and
after #1993 — a pre-existing hole with a different mechanism than the copy-row note that PR added).

## Status (2026-11-18, the cluster lane)

**FIXED in v0.2.80 (this branch).** Verified on the rebased tree: the row's G-B program
(`tests/origins/unsound/row9-zip-chain-inline-receiver.yo`) rejects with E0911 at the store. Three changes
close it: (1) `_origin_carrying_roots_shallow`'s mode-2 receiver branch contributes `origin_of(receiver)`
for a non-atom receiver — the whole temporary-receiver side (audit A14's fix); (2) R-NONE in
`_origin_of_into` continues for a call whose callee's declared result is a reference, carries an origin, or
holds binders (audit A5's pointee-typing fix) — the generic `IterZip(Self, J)` receiver walk; (3)
`generic_result_binder_modes` gained a declared-type fallback for method calls (the definition's own
function value, binders intact), so the `sink(other) : J` parameter the result holds is mode 1 and the
`ys` argument's cursor contributes its roots. (An earlier build measured `arg1 named=false` before (3);
with (3) on the rebased tree the chain roots both lists.)

Original diagnosis, kept for the record: Two changes landed in `src/evaluator/utils.yo`:

1. `_origin_carrying_roots_shallow`'s mode-2 receiver branch (a pointee-carrying receiver that is no
   atom — a temporary cursor) now contributes `origin_of(receiver)` instead of nothing. With this,
   `bind n` for `n := (&xs).into_iter().zip(...).next()` registers `xs` (measured: `roots=[xs(imm)]`):
   the whole RECEIVER side of the chain is closed (this is audit A14's fix).
2. R-NONE in `_origin_of_into` continues past the empty-set return for a call whose callee's declared
   result is a reference, carries an origin, or holds binders (audit A5's pointee-typing fix), and
   `generic_result_binder_modes` gained a declared-type fallback for method calls (the definition's own
   function value, binders intact), so a generic method's by-value parameter the result holds
   (`IterZip(Self, J)`'s `other : J`) is no longer read as mode 0 by construction.

The earlier measurement (`arg1 named=false`, the binder-mode OR-branch not firing) was taken before
(3) landed; the G-B row now rejects, so none of that work remains.

## Repro

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
{ ArrayList } :: import("std/collections/array_list");
main :: (fn() -> unit)({
  mut(o) := Option(IterPair(&String, &String)).None;
  {
    mut(xs) := ArrayList(String).new();
    xs.push(String.from("alpha"));
    mut(ys) := ArrayList(String).new();
    ys.push(String.from("bb"));
    n := (&xs).into_iter().zip((&ys).into_iter()).next();
    match(
      n,
      .Some(item) => {
        o = .Some(item);
      },
      .None => ()
    );
  };
  match(&o, .Some(p) => println(`OUT: ${(p.*._0).*}`), .None => println("none"));
});
export(main);
```

`o` outlives the block; `item`'s `IterPair(&String, &String)` borrows `xs`/`ys`, and the final read goes
through `o` after both lists dropped. `yo check` ACCEPTS it (and the run reads freed memory).

## Where to look

The origins are lost through the INLINE temporary receiver chain `(&xs).into_iter().zip(...).next()`: each
stage's result is a temporary of its statement, so the chain's lends never root `xs`/`ys` in the
assignment's held set, and the copy row's `origin_held_by(scrutinee_expr)` returns the empty set. The
non-inline spelling (an iterator bound to a local first) is rejected correctly. The audit lane's table:
s0 (direct parameter store) E0923 unchanged, s2/s3 (match-routed parameters) rejected via call-site
E0911 — only the inline-temporary chain escapes.

## Disposition

The cluster lanes' v0.2.80 work owns the fix (this is one of the audit-family accepted-and-unsafe rows
the v0.2.80 soundness pass must close); the probe lives in the audit lane's battery
(`s1_escape_outer_holder.yo`). A strictness gap in the same area (a PARAMETER scrutinee contributes an
empty held set by design, bypassing the O2/A29 subset discipline through a match) is filed separately in
`issues/questions/` by the audit lane.
