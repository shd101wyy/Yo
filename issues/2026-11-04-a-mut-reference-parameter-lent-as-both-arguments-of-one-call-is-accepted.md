# A `&mut` reference parameter passed as both a `&` and a `&mut` argument of one call is accepted (heap use-after-free)

**Severity:** S1: a safe program reads freed memory. Decision 28's argument
exclusivity (E0910) rejects `f(&xs, &mut xs)` for a local `xs`, but when
`xs` is itself a `xs : &mut T` parameter, `f(xs, xs)` passes it to a `&T`
and a `&mut T` parameter of the same call with no diagnostic; the callee then
reads through the shared borrow a buffer the `&mut` side reallocates.

> Found 2026-11-04 while repairing `tests/spec/fixtures/negative/list_distinct_false.yo`
> after VBD B8 (ArrayList became a value). Reproduced with a tree binary
> built from develop 8559f3a26 (B10 #1741).

## Reproducer

```yo
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");

append_all :: (fn(src : &ArrayList(i32), dst : &mut ArrayList(i32)) -> unit)({
  (mut(i) : usize) = usize(0);
  n := src.len();
  while(i < n, {
    dst.push(src(i));
    i = (i + usize(1));
  });
});

onto_itself :: (fn(xs : &mut ArrayList(i32)) -> unit)({
  append_all(xs, xs);
});

main :: (fn() -> unit)({
  mut(xs) := ArrayList(i32).new();
  xs.push(i32(1));
  xs.push(i32(2));
  xs.push(i32(3));
  onto_itself(&mut xs);
  println(xs.len());
});
export(main);
```

`yo check` accepts it. `yo compile --sanitize address --allocator system`
and running it reports `heap-use-after-free ... READ of size 4`: the
fourth `push` grows `dst`'s buffer, which `src` still points into.

The local spelling of the same call is rejected, as it should be:

```text
error[E0910]: This argument lends `&mut` `xs`, which an earlier argument of the same call lends to it (`&(xs)`) …
```

## Likely root cause (not yet confirmed in the code)

The per-call lend collection (`_call_lends`, `_check_call_value_root_overlap`
in `src/evaluator/calls/function.yo`) records a lend from an explicit
`&place` / `&mut place` argument. A bare argument whose type is already a
reference (an implicit reborrow of a `&mut T` parameter) is not recorded as
a lend of its root, so two such arguments, or one of them beside an explicit
`&xs`, never meet in the overlap check.

## Fix shape

Treat a bare reference-typed argument as a lend of its place: `&` when the
parameter it binds is `&T`, `&mut` when it is `&mut T`, so the existing
overlap and E0910 wording apply unchanged. The regression test is the
reproducer above as an E0910 case (both orders of the two arguments).

## Fixture to revisit with the fix

`tests/spec/fixtures/negative/list_distinct_false.yo`'s `onto_itself`
spells exactly this call (`append_all(xs, xs)`) so the verifier's
`distinct(src, dst)` requires is still exercised: today the verifier is what
catches it (REFUTED at the call). Once the evaluator rejects it, that
function no longer loads; move it out of the fixture and change
`tests/internal/verifier_list_len.test.yo`'s "onto_itself must refute"
assertion to expect zero refutations from that file.
