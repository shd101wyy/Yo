# A nullable-pointer `match` arm binding stores into a same-named hoisted variable's slot

**Status: FIXED** (found and fixed 2026-09-26, by the stage-2 build of
`plans/EVALUATOR_MEMORY_REDUCTION.md` Phase 3).

## Symptom

With `Option` of a reference handle lowered to the nullable pointer (Phase 3),
the compiler's own stage-2 C failed to compile in `run_add`
(`src/install_command.yo`):

```
error: assigning to '__yo_t_…' (aka 'struct … /* ParsedPackage */') from incompatible type '__yo_t_… *' (aka 'struct … /* SemVer */ *')
    sm->var_parsed_12724187469185345837 = parsed;
```

`run_add`'s async body hoists a `parsed : ParsedPackage` across its awaits. A
later non-await arm, `match(parse_semver(tag), .Some(parsed) => parsed, …)`, binds
a second `parsed : SemVer` from an `Option(SemVer)`. With the same type, the
store is silent and clobbers the outer variable: the test below printed the
inner label for the outer binding.

## Root cause

`_gen_nullable_ptr_match` (`src/codegen/exprs/match.yo`) stores a hoisted
pattern binding into its state-machine slot. It resolved that slot by looking
the binding's NAME up in the **arm body's** recorded env. That env can predate
the binding, and here it did, so the lookup found the OUTER `parsed`, which
is hoisted, and the arm's value was stored into its slot. When the lookup
found nothing, a name scan over the hoister's map had the same effect.

`state_code_gen.yo`, which handles await-carrying arms, resolves by the
**pattern atom's own** env, which contains the binding. Before Phase 3 the
nullable-pointer path only ran for `Option(*T)`, which safe code rarely
matches in async bodies.

## Fix

`_gen_nullable_ptr_match` resolves the binding through the pattern atom's
ExprInfo env, as `state_code_gen.yo` does. When that resolution finds the
binding, its id decides: if the binding is not a state-machine variable, it is
a local and is not stored, and there is no name-scan fallback
(the rule from `issues/fixed/async-sibling-arm-match-bindings-store-to-wrong-slot.md`).

## Test

`tests/async_await.test.yo` "Test a nullable-pointer arm binding does not
store into a same-named hoisted variable". It fails on the Phase 3 compiler
without the fix and passes with it.
