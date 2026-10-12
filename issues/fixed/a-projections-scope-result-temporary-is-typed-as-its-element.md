# A projection's scope-result temporary is typed as its element, not a pointer

**Severity:** S2. A valid projection whose body releases an owning local at
scope end produced C that does not compile (clang `-Wint-conversion` /
`-Wincompatible-pointer-types` errors), so the program failed to build.

**Status:** fixed on feat/vbd-v2b-index-mut (VALUES_BY_DEFAULT V2b).

## Symptom

```yo ignore
Chain :: struct(items : ArrayList(i32));
impl(Chain, VIndex(usize)(Output : i32, index : (fn(self : &Self, idx : usize) -> &Self.Output)({
  label := String.from("Chain");
  // ... loop with return(&self.items(i)) ...
  &self.items(usize(0))
})));
```

```
error: incompatible pointer to integer conversion initializing 'int32_t' (aka 'int') with an expression of type 'int32_t *'
  int32_t __yo_scope_ret = ...(&(*__yo_v_self).__yo_v_items, 0ULL);
error: incompatible integer to pointer conversion returning 'int32_t' from a function with result type 'int32_t *'
```

The Generation B std draft hit the same error in `LinkedList`'s and `HashMap`'s
`index`.

## Root cause

When the body has scope-end drops, the result is materialized into a C
temporary, `__yo_scope_ret`, so that the drops run before `return` (B1,
plans/archive/YO_SELF_RC_EMISSION_LAYER.md §8). Both emitters of that temporary
spelled its type from the declared result type `T`:

- `src/codegen/functions/generation.yo` (the body tail);
- `src/codegen/exprs/return.yo` (the shared-id tail).

A projection's C result is `T*`.

## Fix

Both emitters spell the temporary's type as a pointer when
`FuncMeta.result_is_ref` is set: `return.yo` through
`_current_c_result_type`, and `generation.yo` inline.

## Test

`tests/index.test.yo`, "V2b: a projection that drops a local before yielding
its place". It was a C compile error before the fix.
