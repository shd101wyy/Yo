# An `Option(&String)` is declared before `String`'s typedef, so the C does not compile

**Severity:** S2 — a valid program fails the C build: a value type with a reference field or payload whose referent is a newtype (`String`, a `Box`) names a typedef that is declared later.

Found while giving `OnceCell(T).get` Rust's `-> Option(&T)` result
(the `OnceCell` move-only read S2 filed on `vbd/v5-part-b-tests`),
on develop 68b45b81d.

## Symptom

```yo ignore
Holder :: struct(v : Option(String));
get_ref :: (fn(h : &Holder) -> Option(&String))(
  match(&h.v, .Some(s) => Option(&String).Some(s), .None => Option(&String).None)
);
```

```
error: unknown type name '__yo_t_4750620371396087897'
    __yo_t_4750620371396087897 const * __yo_v_value;
```

The `Option(&String)` union names `String`'s typedef (`typedef … __yo_t_4750620371396087897;
// String : String (newtype)`), which is emitted about a hundred lines later.

## Root cause

The type declarations are emitted in a topological order built by
`src/codegen/types/generation.yo` (`_walk_by_value_dep`). A reference field (decision 43
N2b) lowers to `const T*` / `T*`, and the walk added no edge for it: a struct referent needs
only its forward declaration, but a newtype referent is spelled by its typedef, which cannot
be forward-declared. Pointer fields of structs already get this edge
(`_walk_pointee_newtype`); reference fields and payloads did not.

## Fix

`_walk_by_value_dep` gives a reference field, payload or tuple element whose referent is
spelled by a newtype (`_pointee_spelling_newtype`) an edge to that newtype.

## Test

`tests/ref_payload_binding.test.yo`: "a reference to a later newtype, struct or enum is a
valid payload": an `Option(&String)` and an `Option(&Box(_Later))` result, and an enum
whose payloads are references to a struct, `String`, `Box`, `Option` and `ArrayList` all
declared after it. The `String`, `Box` and `ArrayList` cases fail the C build on develop.
