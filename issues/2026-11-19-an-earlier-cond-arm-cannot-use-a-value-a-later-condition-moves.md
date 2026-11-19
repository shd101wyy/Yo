# An earlier `cond` arm cannot use a value a later condition moves (false E0901)

**Severity:** S2: a valid program is rejected. An arm body that reads or
moves a local is E0901 "use of moved value" when a LATER condition of the
same `cond` moves that local, though that condition never runs on the path
that takes the arm.

**Status:** OPEN. Found 2026-11-19 while fixing
`issues/fixed/2026-11-19-a-move-in-a-later-cond-condition-leaks-when-an-earlier-arm-is-taken.md`.

## Reproducer

```yo
{ println } :: import("std/fmt");

pick :: (fn(a : bool, o : Option(Rc(i32))) -> bool)(
  cond(
    a => o.is_some(),
    match(o, .Some(x) => (x.* > i32(0)), .None => false) => true,
    true => false
  )
);

main :: (fn() -> unit)({
  println(pick(true, .Some(Rc.new(i32(1)))));
});
export(main);
```

`yo check` (v0.2.78 seed and the d8f0d89fa tree) reports
`error[E0901]: use of moved value: o` at `o.is_some()`, with the note
"value moved here" pointing at the second condition's `match`.

## Root cause

`evaluate_cond` (`src/evaluator/exprs/cond.yo`) evaluates every condition
before any arm body, all in the same environment. When the bodies are
evaluated, the move made by condition k is already on the shared `Variable`,
so an earlier arm's body (j < k) sees the value as moved. At run time the
order is c0, then b0 or (c1, then b1 or …): condition k never precedes
body j.

## Fix shape

Evaluate the arms in run order, as the nested form
`cond(c0 => b0, true => cond(c1 => b1, true => b2))` would be: condition k
is evaluated after body k-1, inside the "earlier conditions were false"
region. Its moves would then belong to a later arm's window, the join's
partial-move elaboration would drop them in the earlier arms, and the
condition-move drops added by the leak fix
(`drop_cond_condition_moves_in_earlier_arms`) would become redundant. This
reorders the evaluator's condition pass, which also decides compile-time
arm selection (a compile-time-true condition stops the pass), so it is a
larger change than the leak fix and was kept out of the v0.2.79 cut.

Workaround: borrow in the condition (`match(&o, …)`) or move the value into a
local before the `cond`.
