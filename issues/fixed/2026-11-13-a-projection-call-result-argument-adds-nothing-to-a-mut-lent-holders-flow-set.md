# A projection call's result argument adds nothing to a `&mut`-lent holder's flow set

**Severity:** S1. `put(&mut o, ys.index(usize(0)))` with
`put :: (fn(generic(r : Origin), d : &mut Option(&(String, r)), v : &(String, r)) -> unit)` passes `yo check` when
`ys` is a block-local list and `o` is read after the block. `put` stores the reference into `o`, and the read is a
heap-use-after-free. Binding the argument first (`yr := ys.index(usize(0)); put(&mut o, yr);`) is E0911. v0.2.76
also accepts the program, so the hole predates this cycle.

Found 2026-11-13 by the `flow` lane (cluster 4) while confirming A11's `put(slot(&mut s), ys.index(usize(0)))` form
(`issues/fixed/2026-11-11-a-store-through-a-mut-returned-by-a-call-does-not-grow-the-flow-set-of-the-place-it-borrows.md`):
with the `&mut` side fixed, the value side still contributed no root.

## Reproducer

`tests/origins/unsound/c4-put-projection-arg.yo` (negative, expects E0911):

```yo
main :: (fn() -> unit)({
  x := long();
  mut(o) := Option(&String).Some(&x);
  {
    mut(ys) := ArrayList(String).new();
    ys.push(long());
    put(&mut o, ys.index(usize(0)));
  };
  match(&o, .Some(r) => println(`OUT: ${r.*.clone()}`), .None => ());
});
```

Positive control: `tests/origins/unsound/c4-put-projection-arg-pos.yo` (`ys` declared before `o`).

## Root cause

`lend_through`'s flow write-back (`src/evaluator/calls/function.yo`, step 3) solves an unfixed `&mut` holder from
the call's other arguments "whose parameters name the same origin parameters". It decided that an argument's
parameter names them from `_argument_origin_pairs`, which pairs the parameter's origin positions with the
argument's TYPE. A projection call's result is typed as its place (`String`), not as a reference, so it paired no
position, the argument was taken to name nothing, and its roots (`origin_of`, which does give `ys`) were never
read.

## Fix

The solve also reads the parameter's own spelling: when the pairs name none of the holder's origin parameters,
`origin_param_names_of` over the argument's slot type decides. `put`'s `v : &(String, r)` names `r`, so
`ys.index(usize(0))`'s roots join `o`, and the read after the block is E0911.

## Test

`tests/origins/unsound/c4-put-projection-arg.yo` (E0911) and `c4-put-projection-arg-pos.yo` (accept), G-B.
