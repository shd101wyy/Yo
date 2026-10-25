# A `match` scrutinee that reads a field of a call result never releases the result

**Severity:** S1 — unbounded leak: `match(mk(i32(7)).n, …)` drops the call's owned result zero times, so
every evaluation leaks it (LeakSanitizer: one direct leak per evaluation when the result holds a `String`).

**Status:** fixed 2026-10-25 on `fix/cond-scrutinee-temps` (see Fix). Found 2026-10-25 by the review of `fix/s1-closure-field-call-hoist`.
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

## Root cause

The cause is in codegen. The evaluator already evaluates a non-place
scrutinee as a one-expression block (`evaluate_begin_expression` in
`src/evaluator/exprs/match.yo`), so the call's result is a temporary of the
scrutinee's own frame. That frame's scope-end drops ride the scrutinee node,
which shares its id with its tail. When the tail is itself a call
(`match(mk(i32(7)), …)`), the call emitter's post-call flush emits them.
When the tail is a field read or an operator (`mk(i32(7)).n`,
`mk(i32(7)).n + i32(1)`, `&mk(i32(7)).s`, `RI(v : i32(7)).v`), nothing does:
`_generate_match_expression_body` rendered and materialized the subject but
only ever flushed the MATCH node's drops. The emitted C was
`Rec a = mk(7); int32_t b = a.n; switch (b) { … }`, and `a` was never
released.

## Fix

`_generate_match_expression_body` (`src/codegen/exprs/match.yo`) flushes the
scrutinee node's drops right after the subject is materialized into its own
temp and given its dup. From that point the arms read only that temp, so the
scrutinee's temporaries are dead: a field read by value or a borrowed field
(`&mk(7).s`) is already an owned copy. This is the same point at which a call
tail's post-call flush released them, so an arm that returns, breaks or
continues finds them released. When the arms read through the subject's code
rather than an owned temp, the drops wait until the construct ends. That is a
`mut` match on a place, a pointer-typed subject that may point into a
temporary, or a subject with no temp. `generate_match_expression` keeps the
scrutinee's drops pending while the whole construct renders, so an early exit
inside the scrutinee or an arm releases what is live. It then flushes them
after the construct. The emitted-once set makes every flush idempotent.

That set is also what keeps an exit inside an arm from releasing a second
time, and its missing consult was a bug the fix itself exposed: the own-temp
flush runs before the arms and records the drops' ids, and a
`continue`/`break` in an arm then re-emitted them from the pending list,
because `_emit_loop_body_drops_before_exit` (`src/codegen/exprs/atom.yo`) did
not consult `emitted_deferred_drop_ids` — a `continue` in an arm over a
call-field scrutinee freed the scrutinee twice per exiting iteration (a
heap-use-after-free, probe `s14` of the ASan matrix). The exit emitter now
consults the set, the same contract as `generate_pending_deferred_drops`
(`src/codegen/exprs/return.yo`); it does not record, so the scope-end
flushes of the normal path still emit.

## Test

`tests/match_structs.test.yo`, three tests over a `Drop`-counted
`struct(n : i32, s : String)`:

- "a scrutinee over a field of a call result releases the result once per
  evaluation": a primitive switch over `.n`, the general lowering over `.s`,
  `&mk(i).s`, and an operator over `.n`. That makes 16 releases for 16
  evaluations, where there were 0 before the fix.
- "a call scrutinee is still released exactly once": `&mk(5)` and an enum
  payload binding of a call. These were already correct and must not
  double-release.
- "a scrutinee's call result is released when an arm returns, breaks or
  continues".
