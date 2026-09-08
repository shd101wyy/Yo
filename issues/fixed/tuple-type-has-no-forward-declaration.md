# A tuple type has no forward declaration, so `ArrayList(Tuple(..))` emits an unknown type name

**Status: FIXED** (2026-09-09) — `src/codegen/types/generation.yo`.

## Reproducer

`issues/repros/arraylist-of-tuple-unknown-type-name.yo`:

```rust
{ ArrayList } :: import("std/collections/array_list");
open(import("std/string"));
main :: (fn() -> unit)({
  xs := ArrayList(Tuple(String, String)).new();
  xs.push((`a`, `b`));
  p := xs(usize(0));
  cond((p.0 == `a`) => (), true => ());
});
export(main);
```

```
tup.c:389:3: error: unknown type name '__yo_t2'
```

`yo check` is green; this is a C-compile failure, so it is loud — but it makes
`ArrayList(Tuple(K, V))` unusable, which is the natural return type for
anything yielding pairs (`Url.query_pairs` is what hit it).

## Root cause

`generate_type_declarations` emits a forward declaration for every
future-trait, struct and enum type:

```c
typedef struct __yo_t0_struct __yo_t0; // Forward declaration
```

Tuples got none — and could not have one, because `generate_tuple_declaration`
emitted an ANONYMOUS struct:

```c
typedef struct { // Tuple(0 : String, 1 : String)
  __yo_t3 _0;
  __yo_t3 _1;
} __yo_t2;
```

An anonymous struct has no tag to forward-declare. So when the ArrayList's own
declaration — which holds a POINTER to its element type — was emitted first,
it named a type C had not seen:

```c
struct __yo_t0_struct { //  : ArrayList(Tuple(0 : String, 1 : String))
  __yo_ref_header_t header;
  __yo_t2* _ptr;          // <- line 389
  ...
};
...
typedef struct { ... } __yo_t2;   // <- line 438
```

Ordering alone would not be a complete fix: a pointer cycle (`A` holding a
`Tuple(*B)` while `B` holds an `*A`) has no valid order. C's rule is that a
pointer to an incomplete type is fine *provided the name is declared*, and only
a named struct tag can be declared ahead of its definition.

## Fix

Two lines of the same change:

1. `generate_tuple_declaration` emits `struct <c_name>_struct { … };` — the
   same shape `generate_struct_declaration` and `generate_enum_declaration`
   already use — instead of an anonymous `typedef struct { … } <c_name>;`.
2. `generate_type_declarations`'s forward pass gains an `is_tuple_type` arm
   emitting `typedef struct <c_name>_struct <c_name>; // Forward declaration`.

Every use site still names the typedef, so nothing else moves: compound
literals (`(__yo_t2){ ._0 = …, ._1 = … }`), members, and pointer arithmetic are
unchanged. The emitted C for every tuple changes shape, which is why the
fixpoint gate is the acceptance test rather than byte identity against develop.

## Tests

`tests/basic.test.yo` — "a tuple element type inside a generic container
declares its C name in time": an `ArrayList(Tuple(String, String))` pushed,
indexed and read back, plus the one-level-deeper
`ArrayList(Tuple(i32, ArrayList(i32)))`. On the pre-fix (v0.2.29) compiler the
whole file fails to C-compile with two `unknown type name` errors.

## Found by

Writing `Url.query_pairs() -> ArrayList(Tuple(String, String))`
(`plans/STD_API_STABILIZATION.md` §4 Encoding).
