# `derive(Clone)` and `derive(FromJson)` named types with a DISPLAY renderer

**Status:** FIXED 2026-08-25.
**Found:** 2026-08-25, implementing `derive(Default)` (STD_API_AUDIT D3.1).
**Severity:** two shipped derives were unusable on ordinary shapes.

## Symptom

Both failed outright, with `derive: derive rule function failed`:

```rust
// 1. any GENERIC struct could not derive Clone
GBox :: (fn(comptime(T) : Type) -> comptime(Type))(struct(value : T));
derive(generic(T), GBox(T), where(T <: Clone), Clone);

// 2. any struct with a generic-instantiated FIELD could not derive FromJson
Rec :: struct(id : i32, tag : Option(i32));
derive(Rec, FromJson, ToJson);
```

The second is the more serious of the two: a struct with an optional field is
about as ordinary as JSON gets.

## Root cause

`Type.to_comptime_string` is a **display** renderer — `type_to_string`
(src/types/string.yo) exposed at comptime. It returns a type's written name when
it has one, and a placeholder when it does not:

| type | rendered |
| --- | --- |
| `i32`, `String`, a named enum `Color` | `i32`, `String`, `Color` |
| `Array(i32, 3)` | `Array(i32, 3)` |
| `Option(i32)` | `<enum:enum_yo_id_3586>` |
| `ArrayList(i32)`, any user generic instantiation | `<struct:struct_yo_id_5916>` |

An INSTANTIATED generic has no written name to return. Both derive rules fed
that output back into generated **source**, where a placeholder cannot reparse:

- `__derive_clone` built its constructor call as `<type_name>(field, …)`, so a
  generic struct emitted `<struct:struct_yo_id_N>(…)`.
- `__derive_from_json` built each field's decode as `<ftype>.from_json(…)`, so a
  generic field emitted `<enum:enum_yo_id_N>.from_json(…)`.

Rendering a type back to source is the wrong tool regardless: even when a name
exists, it is only usable if that name happens to be in scope at the impl site.

## Fix

Neither rule needs a type NAME.

- `derive(Clone)` constructs through **`Self`** — always correct, never needs an
  import. (This is why `derive(FromJson)`'s own constructor half already worked:
  it emitted `Self(…)`.)
- `derive(FromJson)` reaches each field's type as a **value**, by index into the
  struct's own field list:
  `(Type.get_struct_fields(Self).get(i).field_type <: FromJson).from_json(…)`.
  Indexing needs no name and no import at the use site.

`Type.to_comptime_string` keeps its behaviour and gains the doc comment it never
had, stating that it is for display and that its result is not guaranteed to
reparse — with a pointer to both name-free techniques above.

`derive(FromJson)` still uses the renderer for its "missing field X in Y" error
MESSAGE, which is exactly what a display renderer is for.

`derive(Default)`, added in the same change, uses the indexing form from the
start.

Note the FromJson fix depends on
issues/fixed/subtype-dispatch-binds-self-to-the-trait.md: the generated
`(… <: FromJson).from_json(…)` is an explicit-dispatch call into a static trait
method whose body constructs `Self`.

## Tests

- `tests/derive.test.yo` — "derive Clone for a generic struct".
- `tests/encoding/json.test.yo` — "derived roundtrip with Option and ArrayList
  fields", plus a `None` case.
