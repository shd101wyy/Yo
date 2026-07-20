# yo-self: `downcast(dyn, T)` to a VALUE/newtype type emits an invalid struct cast

_2026-07-20. Diagnosis (not fixed) — blocks `tests/error.test.yo`._

## Symptom

`tests/error.test.yo` (s2) fails C compile with:

```
error: used type '__yo_t10' (aka 'struct __yo_t11_struct') where arithmetic or pointer type is required
error: initializing '__yo_t30' with an expression of incompatible type '__yo_t10' ...
```

at the downcast cast expression:

```c
((__yo_t10)__yo_incr_rc((void*)err.data))   // __yo_t10 = String newtype (a STRUCT)
((__yo_t30)__yo_incr_rc((void*)err.data))   // __yo_t30 = a value enum (math_err)
```

C rejects casting a pointer to a struct type.

## Root

`error.test.yo` does `(err : AnyError) = dyn(\`...\`)`then`downcast(err, String)`(and`downcast(err, SomeValueEnum)`) — downcasting to VALUE types (a String
newtype, a value enum). `generate_downcast`(codegen/exprs/downcast.yo) only has
the OBJECT-type path:`((T)\_\_yo_incr_rc((void\*)dyn.data))`— valid only when`T`is a pointer (reference struct). For a value/newtype`T` the C type is a struct,
so the cast is invalid.

TS handles this in the **`wasBoxed` branch** (downcast.ts:111-150): a value type
wrapped in a dyn is auto-boxed (`dyn.data` → a Box struct), and extraction is
`((BoxCName*)dyn.data)->field` + a `___dup`/newtype-unwrap/incr_rc as
appropriate. yo-self's `generate_downcast` header explicitly DEFERS this: "the
`wasBoxed` branch … is UNREACHABLE — yo-self `is_boxed_type` is hardcoded false
(Box is not modeled in the type system yet)."

So `dyn(String)` stores the String's representation in `.data` (dyn.yo:193,
`.data = value_code`), and the downcast must RECONSTRUCT the value type from that
pointer — not cast a pointer to a struct.

## Fix (a dedicated port — needs the dyn value-boxing model)

Port the `wasBoxed` value-extraction branch (downcast.ts:111-150). It requires:
(1) modeling how yo-self boxes a value type into a dyn (`dyn()` currently rejects
non-object types at dyn.yo:103, yet `dyn(\`String\`)`compiles — so String must be
passing as pointer-sized/newtype-over-pointer; pin down the exact`.data`representation first); (2)`is_boxed_type`+ the`dyn_impls`scan (TS line 92-109,
which also needs Gap-6`SomeType.resolvedConcreteType`); (3) the
`\_\_\_dup`/newtype-unwrap extraction. This is the same Box-modeling gap the
`generate_downcast`header + the dyn.yo`is_boxed_type=false` stub call out.
Not a tail-of-session change; a dedicated dyn/Box arc. Full battery +
STRICT_FIXPOINT mandatory (touches the dyn family + get_dup_function_for_type).
