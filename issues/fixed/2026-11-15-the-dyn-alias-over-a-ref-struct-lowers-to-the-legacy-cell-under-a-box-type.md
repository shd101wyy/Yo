# The `dyn(v)` alias over a `ref struct` value lowers to the legacy counted cell under a `Box(Dyn)` type

**Severity:** S1 (a NULL function-pointer call at runtime: dropping, or calling a defaulted slot on, the
`Box(Dyn(T))` that `dyn(r)` makes from a `ref struct` value `r` crashes)

## Symptom

```yo
_Child :: ref(struct(tag : String, up_tag : String));
(c : Box(Dyn(_Node))) = dyn(_Child(tag : `C`, up_tag : `R`));
```

`tests/error_source_chain.test.yo`'s "a user trait's Dyn(SelfTrait) payload binds and passes as
Dyn(ThatTrait)" row: `AddressSanitizer: SEGV on unknown address 0x000000000000 (pc 0x0)` in the box's
dispose. The `_Child` vtable is the legacy one (`__yo_drop_in_place = NULL`, `__yo_retain =
__yo_incr_rc`), not the payload-convention (`_P`) one the box dispose reads.

## Root cause

`_dyn_payload_is_plain_value` (`src/evaluator/values/dyn.yo`) excluded `ref struct` values from the
alias's auto-box: before the flip a `ref` object was its own counted cell, so the legacy `Dyn` adopted it.
Under decision 49 S2 every owning erasure is typed by `_erasure_handle_name`, which names `Box` for
anything that is not an `Rc`/`Arc` cell, so the result was `Box(Dyn(...))` while codegen
(`generate_dyn_call`) built the legacy cell over the unboxed handle. The migration's kind-2 predicate
(`_record_unsized_dyn_site`) had the same exclusion, so `yo fix --migrate unsized` left `dyn(r)`
unrewritten.

## Fix

A `ref struct` value is a plain payload: the alias boxes it (`Box(_Child)` holds the counted handle, so
the box's `drop_in_place` releases one reference), and the migration's kind 2 uses the same predicate.

## Test

The error_source_chain row above; probe `tmp/p/p22.yo`. Fails before, passes after.
