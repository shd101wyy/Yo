# A collection lent both `&mut` and `&` to one call loses its caller-owned share

**Severity:** S1 — `f(&mut xs, &xs)` on a collection leaks `xs`'s last value, and a callee that replaces `xs` in a loop reads freed memory through its `&` argument.

**Status:** fixed on `test/decision43-n0-corpus` (2026-10-21).

## Symptom

Found while reviewing decision 43's N0 corpus: the row `call-arg-overlap`
(`tests/origins/corpus/call-arg-overlap.yo`) is a program today's checker
accepts, and running it under AddressSanitizer reports a leak.

```yo
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
_clobber :: (fn(a : &mut ArrayList(i32), b : &ArrayList(i32)) -> unit)({
  mut(i) := i32(0);
  while(runtime(i < i32(3)), {
    a = ArrayList(i32).new();
    a.push(i);
    i = (i + i32(1));
  });
  println(`b.len = ${b.len()}`);
});
main :: (fn() -> unit)({
  mut(xs) := ArrayList(i32).new();
  xs.push(i32(1));
  xs.push(i32(2));
  _clobber(&mut xs, &xs);
  println(`xs.len = ${xs.len()}`);
});
export(main);
```

Measured with seed v0.2.67 and the tree binary of develop 3d3546a21:

- `--sanitize address --allocator system`: `heap-use-after-free` in the
  callee's `b.len()`;
- without a sanitizer (`-O0` and `--optimize 2`): `b.len = 8`, where 2 is
  expected (the addendum of
  `issues/fixed/borrowed-arg-invalidated-by-aliased-container-mutation.md`
  measured the same 8 before Phase 5.2);
- with a callee that does not replace `a` (the corpus row,
  `_both(&mut xs, &xs)` pushing once): `48 byte(s) leaked in 2
  allocation(s)`. Passing `&ys` instead of `&xs` leaks nothing, and so does
  `_two(&xs, &xs)`.

## Root cause

Phase 5.2 (`plans/TYPE_SYSTEM_SOUNDNESS.md`) gives an argument a caller-owned
+1 for the call when another argument of the same call lends the same whole
variable `&mut` (`argument_is_aliased_by_inout`, `src/evaluator/calls/helper.yo`).
`set_expr_as_needs_to_call_dup_for_borrowed_projection(..., force : true)`
(`src/evaluator/utils.yo`) records a `___dup(xs)` on the argument and returns
the balancing `___drop` of the dup's temp for the call's deferred drops.

`_optimize_dup_drop_pairs` (`src/evaluator/exprs/begin.yo`) then saw one
runtime dup of the owning local `xs` and cancelled it against `xs`'s
scope-end drop, as a move. Nothing was moved: the post-call drop of the
dup's temp was emitted for a temp that no longer existed, so neither half of
the pair reached the C. `main` called `_clobber(&xs, xs)` with no `+1` and
never released `xs`. The callee's first `a = …` released the list `b` still
pointed to, and the list `xs` held at the end leaked.

Phase 5.2's own test (`tests/type_soundness.test.yo`, "a by-value argument
outlives the inout argument it overlaps") uses a value struct with a `String`
field. The optimizer never cancels a dup of a value type with counted fields,
so the test passed while every reference type, which includes all the
collections, was unprotected.

## Fix

The Stage 0 dup is self-balancing, so it is never a pair candidate:
`set_expr_as_needs_to_call_dup_for_borrowed_projection` marks it
(`mark_call_scoped_share_dup`, `src/expr_info.yo`), and `_search_dup_calls`
skips a marked dup the way it skips a by-value parameter's share. `main` now
takes the `+1` before the call, releases it after, and drops `xs` at its
scope end.

The same call inside an `io.async` body is still unsound for a different
reason, the state-machine call path never emits this `+1`:
`issues/2026-10-21-an-aliased-argument-in-an-async-body-gets-no-caller-owned-share.md`
(open, S1).

## Test

`tests/type_soundness.test.yo`, "a collection lent both &mut and & to one
call keeps its share": an `ArrayList(_P5Box)` lent `&mut` and `&` to a callee
that replaces it three times. Before the fix the test runner's ASan build
reports `heap-use-after-free` in it; after the fix the borrowed list keeps
its length 2 and all five boxes are released once.

## Relation to decision 28 and decision 43

The call itself stays accepted: decision 28's value-root rule, which rejects
a `&mut` argument overlapping any other argument, lands with V2b
(`plans/VALUES_BY_DEFAULT.md` decision 28 "Phase"), and decision 43's O3
step 2 rejects it too (`plans/backlog/REFERENCES_AND_ORIGINS.md` §7). Until
then the caller-owned `+1` is what keeps such a call sound.
