# A `match` / `cond` passed directly as a call argument never released its result

> Found 2026-09-24 by the evaluator memory campaign
> (`plans/EVALUATOR_MEMORY_REDUCTION.md` §0.5): 98% of the compiler's live
> `TypeValue`s at the end of `yo check src/main.yo` were leaked temporaries.
> **FIXED same day** on `fix/control-flow-call-arg-leak`. Present since at
> least v0.2.32 (reproduced on that seed with a `ref(struct)` + `Dispose`).

## Symptom

Any reference-counted value produced by a `match` or `cond` used **directly**
as a call argument was never released:

```rust
{
  _n := read(match(flag, true => S(n : 1), false => S(n : 2)));
};
// Dispose never runs for the S — the object leaks.
```

Binding the same `match` to a local first (`x := match(...); read(x)`) freed
it, and a constructor call in the same argument position (`read(S(n : 1))`)
freed it too. A 50-line reproducer that interns through
`intern(match(t, .Box1(i) => .Box1(subst(i)), _ => t))` counted 2,000 fresh
nodes built and 0 disposed.

## Root cause

The evaluator was right: the match's result temp is attached as an owning
variable of the enclosing begin block (`attach_temp_variable_to_expr(expr,
true, ctx)`), and the block's scope-end pass schedules `___drop(<temp>)` for it
(traced: owning, unconsumed, every filter passed).

Codegen threw the drop away. `generate_deferred_drop_expressions`
(`src/codegen/exprs/drop_dup.yo`) skips a drop whose target temp is not in
`declared_c_var_names`, which guards against drops of temps whose declaration
was elided. That set is filled by `get_variable_type_string`, the choke point
for typed declarations. `generate_match_expression`
(`src/codegen/exprs/match.yo`) and the cond emitter (`src/codegen/exprs/cond.yo`)
declare their result temp with a raw `get_type_string(...) + " " + tv + ";"`
line instead, so the temp was never recorded and its drop was classified as
"undeclared" and dropped silently. The one cond site that already registered
its hand-written declaration (the value-code recovery path) was unaffected.

Where the temp is consumed (bound to a local, moved into an `own` parameter,
returned as a block's value), no drop is scheduled, which is why only the
argument / discarded-statement positions leaked.

## Fix

Both raw result-temp declarations now insert the temp name into
`declared_c_var_names`, exactly like the recovery path in `cond.yo`. The
scheduled drop is then emitted at the scope end.

## Impact on the compiler itself

`_substitute_at` (`src/types/substitution.yo`) returns
`intern_type(match(ty, ...))`, so every substitution that hit the intern table
leaked the freshly built node. `check src/main.yo` (develop 251522b21, quiet
machine): **9.86 GB → 6.84 GB peak footprint (−3.0 GB, −31%)**, 120 → 93 s,
measured with a stage-2 compiler (built by the fixed stage 1). The emitted C of
the compiler legitimately changes (it gains the drops); the fixpoint holds on
the new emission.

## Tests

`tests/rc.test.yo`, four tests with a `Dispose` counter: a match argument and
a cond argument each release their fresh result exactly once (also as a bare
statement); an arm that returns a caller-owned value does not over-release it
(rc stays 1, disposed exactly once at its own scope end) — the over-release
canary for the newly emitted drop; a nested match argument; a match moved
into an `own` parameter is disposed once. All four fail on the unfixed
compiler.
