# Reborrowing a `&Dyn` parameter (`&d.*`) takes the C address of the fat pair

**Severity:** S1 (invalid C: every function that forwards a `&Dyn(T)` / `&mut Dyn(T)` parameter as
`&d.*` / `&mut d.*` fails the whole translation unit)

## Symptom

```yo
_fwd :: (fn(d : &Dyn(Speak)) -> &Dyn(Speak))(&d.*);
```

`tests/dyn_pointer_kinds.test.yo` (`_pass`, `_pass2`, `_fwd`): clang

```text
error: returning '__yo_t_… *' from a function with incompatible result type '__yo_t_…'
  return (&__yo_v_d);
```

## Root cause

Under the flip a `&Dyn` parameter is passed as the `{ data, vtable }` pair by value, and `d.*` on it is
the identity: its code is the bare parameter name. `generate_address_of`
(`src/codegen/exprs/ptr_fns.yo`) recognized an unsized operand only in its `(*F)` and parenthesized
identity forms, so the bare name fell through to the plain `(&code)`.

## Fix

An unsized operand whose code is a bare C member chain is the pair itself: the address-of returns it.

## Test

The dyn_pointer_kinds rows that define `_pass`/`_pass2`/`_fwd` (the whole batch failed to compile
before; passes after).
