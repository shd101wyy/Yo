# A `&mut` reference parameter passed as both a `&` and a `&mut` argument of one call is accepted (heap use-after-free)

**Severity:** S1: a safe program reads freed memory. Decision 28's argument
exclusivity (E0910) rejects `f(&xs, &mut xs)` for a local `xs`, but when
`xs` is itself a `xs : &mut T` parameter, `f(xs, xs)` passes it to a `&T`
and a `&mut T` parameter of the same call with no diagnostic; the callee then
reads through the shared borrow a buffer the `&mut` side reallocates.

**Status: FIXED.** `_call_lends` (`src/evaluator/calls/function.yo`) now
records a borrow binding passed bare to a reference parameter as a lend of
the place it borrows (`_bare_borrow_argument_lend`), so decision 28's
value-root rule rejects `f(xs, xs)` into `(&T, &mut T)` with E0910. Test:
`tests/type_soundness.test.yo`, "a `&mut` reference parameter lent both & and
&mut to one call is E0910" (fails with a develop f82291470 binary, passes with the fix).

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

## Root cause

The per-call lend collection (`_call_lends`) recorded a lend only for an
explicit `&place` / `&mut place` argument, a borrowed receiver, an operand
its operator borrows, and a called field. Decision 33 lets a borrow binding
(a `x : &T` / `x : &mut T` parameter, a `&` / `&mut` local; `Variable.is_ref`
or `is_imm_borrow`) pass bare to a reference parameter, and such an argument
was recorded as nothing. The overlap checks
(`_check_call_value_root_overlap`, `_check_call_cell_root_overlap`) judge
only recorded lends, so `f(xs, xs)`, `f(&xs, xs)` and `xs.extend_cloned(xs)`
never met in them. The explicit `f(&xs, &mut xs)` on the parameter was
already rejected by the two-phase rule.

## Fix

`_call_lends` reads the callee's parameter slots (a method's from its
resolved `FuncVal`, the receiver taking slot 0; any other callee's from its
`Func` or `Fn` trait type) and, for an unmarked argument that is a place
(`_is_unmarked_lent_place`) rooted at a borrow binding and bound to a `&T` /
`&mut T` slot, records a lend of that place, exclusive for a `&mut T` slot.
The existing checks then apply unchanged; the diagnostic names the side as
"a borrow passed bare to a `&mut` parameter" / "... to a `&` parameter".
Two shared lends of one borrow (`g(xs, xs)` into `(&T, &T)`) and two
separate borrows (`f(xs, ys)`) still pass.

## Fixture retired with the fix

`tests/spec/fixtures/negative/list_distinct_false.yo`'s `onto_itself`
spelled exactly this call (`append_all(xs, xs)`) so the verifier's
`distinct(src, dst)` requires stayed exercised: the verifier was what caught
it (REFUTED at the call). The evaluator now rejects it, so the function is
moved out of the fixture and `tests/internal/verifier_list_len.test.yo`
expects zero refutations from that file.
