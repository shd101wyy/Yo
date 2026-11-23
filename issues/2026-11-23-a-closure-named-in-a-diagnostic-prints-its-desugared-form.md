# A closure named in a diagnostic prints its desugared form

**Severity:** S3 — an E0910 names the closure argument as `_(__yo_mut(m) : &mut(s))() => (m.push_str)(…)`, the compiler's internal spelling, instead of the source text.

Filed 2026-11-23 by the test 7 lane while respelling the audit corpus's drifted negatives
(`scripts/test7/respell-manifest.tsv`, plan `plans/handover/VBD_V0279_RETIREMENTS_AND_CLAIM.md` §3.6). Probe: `probes/closures/e04.yo`
in `scripts/test7/audit-corpus.tar.gz`. Reproduced with a stage 1 of develop `f06ff5889`.

## Reproducer

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
run2 :: (fn(r : &String, f : &mut Impl(FnMut() -> unit)) -> usize)({
  f();
  r.clone().len()
});
main :: (fn() -> unit)({
  mut(s) := String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz");
  n := run2(
    &s,
    &mut ({ m : &mut s }() => m.push_str("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"))
  );
  println(`OUT: ${n.to_string()}`);
});
export(main);
```

```text
error[E0910]: `_(__yo_mut(m) : &mut(s))() => (m.push_str)("0123…")` is lent exclusively to this call (it is a `&mut` argument, or it holds a `&mut` capture), and it reaches `s` (the capture `m : &mut s` at …)
```

## Root cause

The argument-exclusivity diagnostic formats the argument with `ast_expr_to_string`, which prints the desugared
closure (`__yo_mut` capture markers, `(m.push_str)(…)` call heads).

## Fix

Name a closure argument by its source span or as "the closure" with its capture list, as the other E0910 texts do.
