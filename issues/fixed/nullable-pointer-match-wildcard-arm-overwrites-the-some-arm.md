# A `_` arm in a nullable-pointer `match` overwrites the `.Some` arm

**Status: FIXED** (found and fixed 2026-09-26, by the stage-3 fixpoint of
`plans/EVALUATOR_MEMORY_REDUCTION.md` Phase 3).

## Symptom

With `Option` of a reference handle lowered to the nullable pointer (Phase 3),
the stage-2 compiler, itself built with the niche layout, emitted different
C from stage 1. The fixpoint broke, and the visible difference was every
async future's dispose losing its "Drop captured variables" lines (a leak of
every capture).

The code behind them reads the capture struct's fields as
`match(get_struct_fields(id), .Some(fs) => fs, _ => ArrayList(TypeField).new())`.
`get_struct_fields` returns `Option(ArrayList(TypeField))`, which is now a
nullable pointer, and the match always took the fallback:

```rust
Crate :: ref(struct(v : i32));
pick :: (fn(o : Option(Crate)) -> i32)(match(o, .Some(c) => c.v, _ => i32(-1)));
// pick(Option(Crate).Some(Crate(v : i32(7)))) returned -1
```

## Root cause

`_gen_nullable_ptr_match` (`src/codegen/exprs/match.yo`) sorts arms into a
null case and a pointer case. It sent every arm that was not a `.`-call
(`.None`) to the pointer case, and each later arm overwrote the earlier one.
A trailing `_` therefore replaced `.Some(c) => …` as the pointer case, with no
binding.

The await-carrying twin in `src/codegen/async/state_code_gen.yo` skipped the
`_` atom entirely, so its `.None` path ran no arm. Both also bound a
`.Some(_)` payload to a C local literally named `_`.

Before Phase 3 these paths only lowered `Option(*T)` and similar, which safe
code rarely matches with a wildcard.

## Fix

Both classifiers are first-match, like the tagged lowering. `.None` claims
the null case, `.Some(v)` the pointer case, and `_` whichever of the two is
still unclaimed, with no binding. A `.Some(_)` payload is not bound. Guards,
`name := pattern` bindings and `.Some(_)` arms were already lowered correctly
on the niche path (checked with a probe program).

## Tests

- `tests/match_catch_all.test.yo` "a wildcard after .Some on a nullable-pointer
  Option only covers .None"
- `tests/match_async_arms.test.yo` "a wildcard arm on a nullable-pointer Option
  with awaits"

Both fail on the Phase 3 compiler without the fix and pass with it.
