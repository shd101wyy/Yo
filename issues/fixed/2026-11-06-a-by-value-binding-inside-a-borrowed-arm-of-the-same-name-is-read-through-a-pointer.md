# A by-value binding inside a borrowed arm's binding of the same name is read through a pointer

**Severity:** S2 — a compile failure (clang rejects the emitted C) for ordinary nested `match` code. No wrong value is produced at run time.

Found while rebasing the fix for
`issues/fixed/2026-11-05-a-match-arm-binding-that-shadows-a-local-is-never-dropped.md` onto
develop a98cf263d, which carries #1795 (a `&` match's binding is a pointer into the scrutinee).

## Symptom

```yo ignore
e := _Two.Two(x : i32(1), y : i32(2));
o := Option(i32).Some(i32(9));
got := match(
  &e,
  .Two(v, _) => {
    inner := match(o, .Some(v) => (v + i32(100)), .None => i32(0)); // by-value `v`
    (inner + v.*)                                                    // the borrowed `v`
  },
  _ => i32(-1)
);
```

clang: `error: indirection requires pointer operand ('int32_t' (aka 'int') invalid)`. The inner
`v` is an `int32_t` local, and its read was emitted as `(*__yo_v_v)`. The test
"nested same-named borrowed and by-value bindings each read their own way" in
`tests/shadowed_binding_early_return_drop.test.yo` makes the whole batch fail to compile on
develop a98cf263d.

## Root cause

`FunctionGenerationContext.place_bindings` records the pattern bindings whose C local is a
pointer to the part (a `mut`/`&` match's place binding, a reference payload's binding), and a
read of such a binding is emitted through the pointer. The set was keyed by the binding's
sanitized SOURCE name. A nested arm's same-named by-value binding therefore inherited the outer
binding's place-ness, and it was read through a pointer it is not. Closing the inner arm then
removed the name, so the outer pointer binding was read as a value after a nested same-named
arm.

## Fix

`place_bindings` is keyed by the binding's C local, `shadow_bindings`' `c_name`. A pattern
binding that shadows a declared C local gets its own C name (the fix above), so place-ness is per
binding. `_is_place_binding` (`src/codegen/exprs/atom.yo`) and `_deref_place_binding`
(`src/codegen/exprs/closures.yo`) resolve the name to its innermost binding's C local first.
`_shadow_remove` (`src/codegen/exprs/match.yo`) drops the popped binding's C local from the set.
