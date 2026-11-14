# A store through a `&mut` returned by a call does not grow the flow set of the place it borrows

**Severity:** S1. A reference stored through a `&mut` that a CALL returned — a projection `slot(&mut s)`, a user
`IndexMut` — is not joined into the place the `&mut` points into, and the O3-3 invariance check does not see it:
`put(slot(&mut s), ys.index(usize(0)))` stores a reference into a block-local list in `s`, which outlives the list,
and the read after the block is a heap-use-after-free. Pre-existing: v0.2.76 accepts the `put(...)`, named and
`IndexMut` forms (the `slot(&mut s).* = …` spelling does not evaluate on v0.2.76).

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A11). Confirmed on develop `64f33c710`. The named form (`m := slot(&mut s); m.* = …`) is the
call-result twin of `issues/fixed/2026-11-11-a-store-through-a-local-mut-borrow-of-a-holder-does-not-widen-the-holders-flow-set.md`
(A25: the join lands on the borrow, not on the holder); one fix should cover both.

## Reproducers

`tests/origins/unsound/a11-store-through-mut-call-result.yo` (filed under `issues/repros/` with this doc's name, moved with the fix; the `…-` twins below likewise)
(negative, expects E0911):

```yo
S2 :: struct(o : Option(&String), n : i32);
slot :: (fn(s : &mut S2) -> &mut Option(&String))(&mut s.o);
put :: (fn(generic(r : Origin), d : &mut Option(&(String, r)), v : &(String, r)) -> unit)({
  d.* = .Some(v);
});
main :: (fn() -> unit)({
  x := long();
  mut(s) := S2(o : .Some(&x), n : i32(0));
  {
    mut(ys) := ArrayList(String).new();
    ys.push(long());
    put(slot(&mut s), ys.index(usize(0)));
  };
  match(&s.o, .Some(r) => println(`OUT: ${r.*.clone()}`), .None => ());
});
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system --cc clang -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

- `…-deref-store.yo` (negative, E0911; not evaluable on v0.2.76): `slot(&mut s).* = .Some(ys.index(usize(0)));`,
  heap-use-after-free.
- `…-index-mut.yo` (negative, E0911; v0.2.76 accepts): `s(usize(0)) = .Some(ys.index(usize(0)));` through a user
  `impl(S2, IndexMut(usize)(…))` whose `index_mut` returns `&mut self.o`, heap-use-after-free.
- `…-pos.yo` (positive control): the stored reference points into a list declared before `s`.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `put(slot(&mut s), v)`, `slot(&mut s).* = v`, `s(i) = v` through `IndexMut` (the repros) | accepted, heap-use-after-free | E0911 |
| a named result `m := slot(&mut s); m.* = .Some(&y);` (ledger s07d; heap form measured: UAF) | accepted | E0911 |
| the spelled-origin projection `slot(generic(p), s : &mut S3(p)) -> &mut Option(&(String, p))` (ledger s07c) | accepted | E0923 |
| the direct store `s.o = .Some(ys.index(usize(0)))` | E0911 | E0911 |
| `put(&mut slot, &y)` with `slot : Option(&(String, x))`; a named `m := &mut slot; put(m, &y)`; a `&mut` parameter forwarded to `put` (ledger s10–s15) | E0923 | E0923 |

## Root cause

Both checks find the written place by walking the target expression back to a NAMED root, and a call result has
none:

- The assignment forms reach `place_write_join` (`src/evaluator/utils.yo`, called from `src/evaluator/exprs/assignment.yo`
  after the type check) only when `_place_root_variable` (`src/evaluator/exprs/assignment.yo`) finds a root binding. It
  steps through fields of value structs and tuples and elements of arrays and value collections; `slot(&mut s).*` is
  a deref of a reference-typed call result and `s(usize(0))` on a user type is neither, so it returns `.None` and the
  store joins nothing. In the named form `m.*` rewrites to `m`, so the join lands on `m`, not on `s.o`.
- The call form reaches `lend_through` (`src/evaluator/calls/function.yo`). Step 1 (O3-3) fixes an origin parameter
  from the `&mut` argument's TYPE (`_argument_origin_type`); the call result's type `&mut Option(&String)` spells no
  origin, so `r` is not fixed and `&y`-like arguments are not compared. Step 3, the flow write-back, runs only when the
  `&mut` argument's place is an atom (`ast_expr_is_atom(&w_place)`), so the solved set is written back to no holder.

The call `slot(&mut s)` itself is checked (decision 28 lends `s` for the call), but nothing records that its result
IS a path into `s.o`, so a store through it is a store into an unknown place.

## Expected

E0911 at the store (as the direct `s.o = …` form reports: "Cannot store a reference to `ys` in `s` here: `ys`'s
scope ends with its block, while `s` is live"), or E0923 where the projection spells the origin. BCC §5's row "place
write `p = v`, `p.* = v`, `p.f = v`, `xs(i) = v`: the target holder's set grows by `origin_of(v)` (flow) or checks
subset (spelled)" covers every target; R-CALL gives `slot(&mut s)`'s result the origin `{(s, &mut)}`, so the target
holder of a store through it is `s`. BCC §3 `lend_through`: "a flow-inferred set on the caller's side is an inference
variable solved by the unification and written back to the holder after the call", where the holder of a call-result
argument is the root of the result's origin.

## Fix

Fixed by the cluster-4 branch `fix/c4-flow-join`. A store through a `&mut` that a call returned joins the place the call result borrows (`origin_of` of the call; `src/evaluator/utils.yo`, `store_via_mut_reference` / `store_via_targets` / `store_through_mut_join`):

- `slot(&mut s).* = .Some(&y.*)`: the assignment's property path finds the projection call it stores through and joins `s`.
- `s(usize(0)) = .Some(…)` through a user `IndexMut`: the place root of an index place (`_index_place_root`, `exprs/assignment.yo`, via `call_is_index_place`) is the indexed value `s`.
- `put(slot(&mut s), &y)`: `lend_through`'s flow write-back (`src/evaluator/calls/function.yo`, step 3) now accepts an argument that is a `&mut` reference VALUE (`expr_is_mut_reference_value`), not only a bare local, and writes the solved origin into the roots `origin_of` gives for it (`flow_write_back_through`).

## Test

`tests/origins/unsound/` (G-B): `a11-store-through-mut-call-result` (the `put` form), `-deref-store`, `-index-mut` (E0911 each) and `-pos`. The corpus rows the report proposed are not added; G-B carries the shapes.
