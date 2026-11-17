# Origins are lost through an inline temporary receiver chain, so a copied zip item escapes into an outer holder

**Severity:** S1 (a safe program the checker accepts whose stored borrow outlives its lists — a would-be
use-after-free through `o`; blocks claim (S), which v0.2.79 lists as pending and v0.2.80 asserts)

Filed 2026-11-18 by the redfix audit lane (probe `s1`), against develop `581bf17d9` (present before and
after #1993 — a pre-existing hole with a different mechanism than the copy-row note that PR added).

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
    match(n, .Some(item) => {
      o = .Some(item);
    }, .None => ());
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
