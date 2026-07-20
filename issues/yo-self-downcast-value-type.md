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

## ISOLATED REPRO (2026-07-20 evening) — the bug reproduces standalone

```rust
{ AnyError } :: import("std/error");
open(import("std/string"));
check :: (fn(err : AnyError) -> bool)(match(downcast(err, String),.Some(_) => true,.None => false));
main :: (fn(io : Io) -> unit)({ (err : AnyError) = dyn(`hello`); b := check(err); () });
export(main);
```

`s2 compile … --emit-c` then `clang -fsyntax-only` reproduces
`used type '__yo_t0' (aka 'struct __yo_t1_struct') where arithmetic or pointer
type is required` at `((__yo_t0)__yo_incr_rc((void*)err.data))`. NOTE: annotate
the binding `(err : AnyError) = dyn(\`hello\`)`— a bare`err := dyn(\`hello\`)`additionally emits`/_ Error: dyn() call missing trait values _/` (the dyn
creation needs the AnyError trait context; a separate concern). So the next
session has a ready standalone repro (no batch needed, unlike msu).

## DEEPER (2026-07-20) — the box machinery is INCONSISTENT (confirms Box-model port)

The value IS boxed at dyn creation: `dyn(\`hello\`)`first boxes the String via a
box constructor`yo*id_2747_String*…(String) -> **yo_t27\*`, where the box is
`struct **yo*t27_struct { **yo_ref_header_t header; **yo_t10 \_u42*; }` (RC header

- the String in `_u42_`), then `.data = <__yo_t27*>`. So the CORRECT downcast
  extraction is `((__yo_t27*)err.data)->_u42_` (+ dup), exactly TS's `wasBoxed`
  `((BoxCName*)dyn.data)->field`.

BUT the surrounding machinery is inconsistent because `is_boxed_type≡false`:
`_unwrap_box_concrete(__yo_t27)` (dyn.yo:35) is a NO-OP, so the dyn_impl records
`concrete_type = __yo_t27` (the BOX), not String — and the vtable typeid is built
for the box while `downcast(err, String)` checks `&__yo_typeid___yo_t0` (String).
So it's not just the extraction: the box/concrete/typeid path all assume the box
is the object. A targeted downcast-only patch is NOT enough; the fix is to model
Box consistently (recognize `__yo_t27` as `Box(String)`: `is_boxed_type`,
`_unwrap_box_concrete` → String for concrete_type + typeid, and the box-extract
in downcast). This is the genuine deferred feature, higher-risk (touches dyn
creation + typeid + downcast + dispose). Standalone repro above; a dedicated arc.

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
