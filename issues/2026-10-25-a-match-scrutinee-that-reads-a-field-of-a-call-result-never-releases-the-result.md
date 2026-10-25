# A `match` scrutinee that reads a field of a call result never releases the result

**Severity:** S1 — unbounded leak: `match(mk(i32(7)).n, …)` drops the call's owned result zero times, so
every evaluation leaks it (LeakSanitizer: one direct leak per evaluation when the result holds a `String`).

**Status:** open (evaluator/codegen). Found 2026-10-25 by the review of `fix/s1-closure-field-call-hoist`.
It predates that branch: the develop binary (cff2cfa60) and the branch behave the same, for a direct
call (`mkd(i32(7)).n`) and for a closure-field call (`h.mk(i32(7)).n`).

## Reproducer

`issues/repros/2026-10-25-a-match-scrutinee-that-reads-a-field-of-a-call-result-never-releases-the-result.yo`,
built with `--std-path ./std --sanitize address --allocator system` and run with
`ASAN_OPTIONS=detect_leaks=1`:

```yo
{ assert } :: import("std/assert");
{ String } :: import("std/string");
Rec :: struct(n : i32, s : String);
mk :: (fn(x : i32) -> Rec)(Rec(n : x, s : String.from("payload")));
main :: (fn() -> unit)({
  m := match(mk(i32(7)).n, i32(7) => i32(1), _ => i32(0));
  assert(m == i32(1), "scrutinee");
  ()
});
export(main);
```

```
==…==ERROR: LeakSanitizer: detected memory leaks
Direct leak of 32 byte(s) in 1 object(s) allocated from:
Indirect leak of 7 byte(s) in 1 object(s) allocated from:
```

A `Drop` counter shows the same: the plain field read `{ a := mkd(i32(1)).n; }` drops the result
once, while `{ m := match(mkd(i32(7)).n, …); }` drops it zero times.

## Where to look

Not investigated yet. A starting point: the scrutinee is evaluated and materialized before the arms
(`src/evaluator/exprs/match.yo`, `src/codegen/exprs/match.yo`), and the call result inside it is a
temporary of the enclosing block. Compare where that temporary's drop is scheduled on the scrutinee
path with the binding path (`a := mkd(i32(1)).n`), which releases it.
