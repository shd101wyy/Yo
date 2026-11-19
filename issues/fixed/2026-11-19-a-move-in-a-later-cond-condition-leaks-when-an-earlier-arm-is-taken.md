# A move in a later `cond` condition leaks the value when an earlier arm is taken

**Severity:** S2: a move-only local that only a `cond` condition after the
first consumes is never dropped on the paths that take an earlier arm. Its
`Drop` never runs and its memory leaks once per evaluation; since the
`EvalValue` retype (#1997) the compiler leaks this way in every
`evaluate_match`, which broke the v0.2.79 G4 leak gate.

**Status:** FIXED (branch `v0279/g4-leak`).

## Reproducer

```yo
{ println } :: import("std/fmt");

pick :: (fn(a : bool, o : Option(Rc(i32))) -> bool)(
  cond(
    a => true,
    match(o, .Some(x) => (x.* > i32(0)), .None => false) => true,
    true => false
  )
);

main :: (fn() -> unit)({
  r1 := pick(true, .Some(Rc.new(i32(1))));
  r2 := pick(false, .Some(Rc.new(i32(2))));
  println(`${r1} ${r2}`);
});
export(main);
```

`yo compile --sanitize address --allocator system` and running it reports
`SUMMARY: AddressSanitizer: 12 byte(s) leaked in 1 allocation(s)`: the `Rc`
of the `pick(true, …)` call, whose second condition never runs. Measured with
the v0.2.78 seed, the d8f0d89fa tree and the R7 (`v0279/parser-drop`) tree
binary. The same shape through `||` (`a || match(o, …)`) does not leak.

## Root cause

`evaluate_cond` (`src/evaluator/exprs/cond.yo`) evaluates every condition
first and only then opens the branch group for the arm bodies
(`group_log_start` is taken after the condition pass). A move inside
condition k is therefore logged before the branch: the join
(`merge_and_check_envs`) reads it as the pre-branch state, every arm counts
as having moved the value, no arm gets a drop, and the scope end skips the
moved local. But condition k runs only when conditions 0..k-1 are false,
so on a path that takes an earlier arm the value is still owned.

This is the `cond` twin of
`issues/fixed/2026-11-04-a-move-in-the-right-operand-of-a-short-circuit-operator-leaks-when-the-operand-is-skipped.md`:
a later condition is a skippable operand of an `||` chain. That fix covered
`&&`/`||` (`drop_moves_of_skippable_operand`), not `cond`.

## Where it bites the compiler (the G4 regression)

The G4 cut gate (ASan+LSan stage-2 `check src/main.yo`) went from the 3c-era
378 B in 17 allocations (tree 57921c442) to 75,897 B in 2,410 allocations at
d8f0d89fa. 386 direct 56-byte `Rc(EvalValueNode)` cells plus their children
(variant name, shared field list, nested values) were `clone_value` results
stored by `::` bindings inside compile-time function bodies, e.g. the
prelude's `info :: __yo_type_get_info(self)` in `Type.get_struct_fields`
(23 of them in the prelude alone, one per call).

A gdb hardware watchpoint on one leaked cell's refcount (no ASLR, addresses
matched against `LSAN_OPTIONS=report_objects=1`) showed every holder
released except one: `evaluate_match`'s `scrutinee_val_opt := scr_info.value()`
(`src/evaluator/exprs/match.yo`). Its only by-value consumer is the third
condition of the output-value `cond`:

```yo ignore
out_val_em := cond(
  scrutinee_val_opt.is_none() => Option(EvalValue).None,
  (matched_body_val.is_some() && !(ct_undecidable)) => matched_body_val,
  match(scrutinee_val_opt, .Some(sv_ro2) => is_runtime_only_unknown_val(&sv_ro2), .None => false) => ...,
  true => ...
);
```

Every compile-time match whose body value is known takes the second arm,
so the scrutinee value leaked once per evaluation. The line is unchanged
since before 3e; what changed is the type. Before #1997 `EvalValue` was
`ref(enum(...))`, which a by-value use copies, so the `match` moved nothing.
As `Rc(EvalValueNode)` it is move-only, so the `match` consumes it.

## Fix

`cond_condition_moves` (`src/evaluator/utils.yo`) records, right after each
condition after the first, the values it moved, using
`drop_moves_of_skippable_operand`'s criterion. After the join,
`drop_cond_condition_moves_in_earlier_arms` gives every earlier arm that
reaches the join a `___drop(name)` through `_drop_in_arms_that_keep`, the
same elaboration a branch arm that keeps a value its sibling moved gets. It
then records the net effect as a flow-log `Join`. An earlier arm that
returns needs nothing new: the early-return pass's cleanup point lies before
the move, so it already drops the value there.

## Verification

- `tests/short_circuit_drops.test.yo` gains four dispose-count tests
  (second-condition move, the compiler's third-condition `Option` match, a
  by-value parameter, a returning earlier arm). With the v0.2.78 seed the
  first three fail (exit 6, the dispose counts are short) and the returning
  canary passes. All four pass with the tree binary.
- The G4-shaped runs, with an ASan build of the stage-2 C, d8f0d89fa →
  this fix: `check` of an empty file 4,175 B in 132 allocations → no leak;
  a CTFE function matching a local `::` enum value, called three times,
  4,890 B in 155 → no leak; the `info.is_struct()` and `match(info, …)`
  shapes 5,315 B in 166 → no leak. `std/collections/hash_map.yo`,
  `std/fmt/index.yo` and `tests/match_structs.test.yo` check with no leak.

## Related

The same evaluation order also makes an earlier arm's body unable to *use*
a value a later condition moves (a false E0901), filed separately:
`issues/2026-11-19-an-earlier-cond-arm-cannot-use-a-value-a-later-condition-moves.md`.
