# A `&mut` argument to a local `Impl(Fn)` closure is never a write against a live loan

**Severity:** S1 — use-after-free in safe code: `g(r, &mut x)`, with `r := &x` live and `g` a local `Impl(Fn)` closure that writes its `&mut` parameter (`o.push_str(...)`), passes `yo check`. Under ASan, the closure's read of `v` after the push is a heap-use-after-free.

**Status:** open, and it predates rule G. This is the closure half of G-D's known pattern `args:named/*/closure/*`
(`tests/origins/gen-known.tsv`). That row used to cite
`issues/fixed/2026-11-12-a-mut-argument-to-a-callee-that-neither-writes-nor-lends-it-is-a-read.md`, and the
`v0280/clusters` branch closed that doc when rule G landed (audit A6). Rule G covers summarized callees, and #1932's
unresolved-callee path covers `Dyn(Fn)`, `Impl(Fn)` parameters, function pointers and `Dyn(Trait)` methods.
A call of a LOCAL closure value goes through neither path. Filed 2026-11-20 by the clusters rebase lane.

## Reproducer

`issues/repros/2026-11-20-a-mut-argument-to-a-local-impl-fn-closure-is-never-a-write-against-a-live-loan.yo` is the G-D finding, `YO_GEN_SEED=168296`. To replay it, run
`YO=<yo> python3 -I scripts/origins-gen.py --sig args:named/mutlend/closure/first --known /dev/null --no-rustc`
inside `nix develop`.

```yo ignore
r := &x;
(g : Impl(Fn(v : &String, o : &mut String) -> unit)) = ((v : &String, o : &mut String) => { o.push_str("zzz"); println(`OUT: ${v.*.slice_copy(usize(0) .. usize(5))}`); });
g(r, &mut x);
```

## Measured (2026-11-20)

- Tree binary of `v0280/clusters` (rebased onto `v0279/kebab-rename` `df9927b92`) and the older `kebab-dry` binary:
  `yo check` accepts both.
- `origins-gen.py --verify-known` on the same binary: `args:named/*/closure/*` is STILL-OPEN (2 of 4 rustc-rejected
  programs are accepted, and both are ASan UAFs). `args:named/*/fnptr/*` is FIXED, so that row is deleted in the same
  change.
- The other `args:named/*/closure/first` shapes (`mutother`, `moved`, `shared`) produce no finding.

## Expected

Rule G (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` P9, VERDICTS-57 §3.4) applies whatever the callee is: at the call's
activation, a `&mut` argument to a closure value is an exclusive access of its place. Here that is E0911 against
`r`'s loan of `x`.

## Root cause

Not yet root-caused. The likely site is the call path for a local closure value. Neither
`d3_check_pending`'s recorders, which run on `fn_param_mut_ref_flags` slots, nor
`d3_check_pending_unresolved_callee` (both in `src/evaluator/exprs/assignment.yo`) appear to see the `&mut` argument.
The fix needs a `tests/origins/unsound/` row (E0911) with a `-pos` twin, and it deletes the gen-known row.
