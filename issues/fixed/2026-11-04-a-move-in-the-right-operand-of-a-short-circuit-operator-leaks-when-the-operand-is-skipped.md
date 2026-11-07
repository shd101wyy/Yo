# A move in the right operand of `&&` / `||` leaks the value when the operand is skipped

**Severity:** S2: a move-only local that only the right operand of a
short-circuit operator consumes is never dropped on the path that skips that
operand. Its `Drop` never runs and its buffer leaks once per evaluation; the
compiler's own verifier leaks this way on every list-mutating function it
checks.

> Found 2026-11-04 while running `tests/internal/verifier_list_len.test.yo`
> locally (LeakSanitizer reports 9 bytes per test). CI does not see it: the
> FV job and the internal shards run with `YO_TEST_LEAK_VERDICT=0`. The
> leak reproduces with tree binaries from the B8, B9 and B10 branches and
> from develop f82291470, so it is older than the B10/B11 flips.

## Reproducer

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");

eat :: (fn(o : Option(String)) -> bool)(
  match(
    o,
    .Some(s) => (s == String.from("x")),
    .None => false
  )
);

f :: (fn(a : bool) -> bool)({
  bdt := Option(String).Some(String.from("ArrayList"));
  a && eat(bdt)
});

main :: (fn() -> unit)({
  println(f(false));
  println(f(true));
});
export(main);
```

`yo compile --sanitize address --allocator system` and running it reports
`SUMMARY: AddressSanitizer: 9 byte(s) leaked in 1 allocation(s)`: the
`"ArrayList"` buffer of the `f(false)` call, where `eat(bdt)` never runs.

## Where it bites the compiler

`src/verifier/vc.yo` (`verify_function_body`, the list-alias pair check):

```yo ignore
bdt := match(input.param_types.get(apj), .Some(bpt) => _list_dt_of_type(&bpt), .None => Option(String).None);
if((apj != api) && (bdt.is_some() && (bdt.unwrap() == adt.clone().unwrap())) && ..., { ... });
```

`bdt.unwrap()` is the only consumer of `bdt`, and it runs only when
`apj != api`. The emitted C drops `bdt` on no path (it is treated as moved
unconditionally), so every iteration with `apj == api` leaks the cloned
data-type name. Any list-mutating function the verifier checks goes through
this loop.

## Fix shape

Treat a move inside the right operand of `&&` / `||` as a conditional move,
the way a move in one branch of a `cond` is: drop the value on the path that
skips the operand (or keep a drop flag). The regression test is the
reproducer above under the leak verdict, plus a `Drop` type whose drop
count is asserted for both values of `a`.

## Fix

A move inside an operand that a short circuit can skip is now a conditional
move, as a move in one arm of a `cond` already was: the path that skips the
operand drops the value, and the path that runs it moves it.

- **Evaluator** (`evaluate_and_or`, `src/evaluator/builtins/and_or.yo`): an
  operand that follows a runtime (or compile-time unknown) operand is
  skippable. After it is evaluated, `drop_moves_of_skippable_operand`
  (`src/evaluator/utils.yo`) reads the flow log's window for that operand. A
  variable whose first record there starts initialized and unmoved, and which
  ends the operand moved, is one the operand moved. Its `___drop(name)` is
  evaluated with the value still owned, the way `_drop_in_arms_that_keep`
  evaluates an arm's drop. It is recorded for the operand in a side table
  keyed by the operand's id (`record_skipped_operand_drops`,
  `src/expr_info.yo`). The table is purged with the other ExprId tables when a
  trial clone or a module is purged. The eligibility is the same as for that
  arm drop: no module-level value, no borrow, no binding that owns nothing, no
  bare `SomeT`. The name must also reach the value in the operand's
  environment (the parameter re-bind of a specialized body is allowed, as
  there). A move inside a nested `cond`/`match` in the operand is already
  joined there, so the operand moves it on every path through it and only the
  skip path needs the drop. Evaluating the drop logs a move at the drop's
  generated token, so the operator's net effect is logged after it, as a
  branch join logs its own. An enclosing arm or loop then reads the move where
  the operand made it.
- **Codegen** (`generate_op_and` / `generate_op_or`,
  `src/codegen/exprs/and_or.yo`): `_close_short_circuit_if` closes each
  guarding `if` with `} else { … }` holding the drops of every operand that
  path skips. A chain `a && b && eat(t)` drops `t` on both early exits. An
  operand that carries skip drops forces the if-chain form, because the
  native C `&&` has no place for a statement. A closure's capture is left to
  its closure, as every guarded flush leaves it.

The skip-path drops live on no deferred-drop list, so no later flush can
emit them a second time. Each path out of the operator holds exactly one
drop or one move.

This bug also caused the V5 part B memory regression. There
`require_capture_borrow_exclusivity` moved a table `ExprInfo` handle inside
`by_value && match(a_info, …)` and leaked one `ExprInfo`, with its
environment snapshot, for every call argument bound to a non-owning
parameter: 857 MB more live memory at exit on `check src/main.yo`
(`issues/fixed/2026-11-06-check-watch-re-force-rounds-leak-a-bounded-cluster-of-envs-and-exprinfos.md`).
The verifier instance quoted above (`vc.yo`'s `bdt`) is fixed by the same
change, with no source edit.

Tests: `tests/short_circuit_drops.test.yo` gains eight dispose-count tests
over every combination of the two runtime flags: `&&`, `||`, an `Option`
local (the verifier's shape), the end of an `&&` chain, a nested `||` under
`&&`, a `match` arm inside the right operand, statement position, and a
by-value parameter. Each call disposes its one value exactly once. Before the
fix the skip path disposed of nothing, so the totals fell short.
