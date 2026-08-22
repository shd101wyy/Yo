# Generic FromJson impls on prelude containers: Option decode miscompiles, HashMap decode fails to unify

**Found:** 2026-08-22, implementing `ToJson`/`FromJson` (std/encoding/json.yo).
Two independent failures in the DECODE direction of generic trait impls on
prelude type constructors; the ENCODE direction (ToJson) of the identical
shapes works, and `ArrayList(T)`'s FromJson — the same pattern with one
generic param — works in BOTH directions. The failing impls were removed
from std v1 (Option/HashMap ship encode-only); restore them when fixed.

## Failure 1 — `Option(T)` FromJson: emitted C does not compile

Impl shape (see `issues/repros/json-option-fromjson-codegen.test.yo`, run
`yo test` on it):

```rust
impl(
  generic(T : Type),
  where(T <: FromJson),
  Option(T),
  FromJson(
    from_json : (fn(v : JsonValue) -> Result(Self, JsonError))(
      match(
        v,
        .Null => .Ok(Option(T).None),
        _ => match(_from_json_of(T, v), .Ok(x) => .Ok(Option(T).Some(x)), .Err(e) => .Err(e))
      )
    )
  )
);
```

`json_decode(Option(i32), \`null\`)` passes the evaluator but the
specialization's emitted C fails to compile —
`error: expected expression` at a line shaped `(*((void*)NULL))`, plus
several `(*((__yo_tN**)NULL))` null-deref patterns nearby. Something in
the `Option(T).None` / `Option(T).Some(x)` construction path (a comptime
type-constructor call in runtime position, with T bound by the generic
impl) emits a NULL placeholder instead of the value.

Layered history (each shape moved the failure, none fixed it):
- `Self.Some(x)` / `Self.None` in the impl body fail at DEF time:
  `Type mismatch for type member "value": Expected <enum>, Got Type(1)`.
- calling `T.from_json(v)` DIRECTLY (instead of through the
  where-constrained helper `_from_json_of`) fails at def time the same way
  — yet the minimal probe (trait method returning `Result(Self, String)`
  called inside a generic impl on a two-line struct constructor) PASSES,
  so the trigger needs more of the json context than the obvious shape.
- `.map((x) -> …)` on the helper's `Result(T, JsonError)` fails dispatch
  inside the generic impl body (`No matching call found`).

## Failure 2 — `HashMap(String, V)` FromJson: def-time unify error

Impl shape (see `issues/repros/json-hashmap-fromjson-unify.test.yo`):
mixed concrete + generic instantiation `HashMap(String, V)`, body decodes
each value via `_from_json_of(V, jv)` and `out.set(k, decoded_v)`.

`json_decode(HashMap(String, i32), \`{"a":1,"b":2}\`)` fails during the
batch module's def-time evaluation with
`Cannot unify incompatible types: "i32" and "String"` and NO source
location (anchor is `batch:1:1`). The i32-vs-String pairing smells like
positional confusion between the pattern's concrete `String` param and
the bound `V = i32` somewhere in the match/specialization path. Binder
shadowing was ruled out (renamed; same error).

## Notes for the fix

- `ArrayList(T)` FromJson (single generic param, same helper, same
  Result-matching body) works end to end — both bugs need either the
  ENUM-constructor payload path (failure 1) or the mixed
  concrete/generic two-param instantiation (failure 2).
- The encode direction of the SAME impl heads works, so impl matching
  itself is fine; the decode direction differs in constructing/returning
  `Result(Self, …)`-shaped values through the specialization.
- When fixed: restore the two impls in std/encoding/json.yo (the removed
  code is in this issue's repro files verbatim), turn the repros into
  `tests/encoding/json.test.yo` cases, and drop the "encode-only" caveat
  from the ToJson/FromJson doc comments.
