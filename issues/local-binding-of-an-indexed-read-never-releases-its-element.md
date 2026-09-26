# `vi := list(i)` of a value-type element with RC fields leaks one reference per binding

Found 2026-09-27 root-causing `issues/verifier-z3-harness-self-test-leaks-40-bytes.md`
(Linux CI's "Formal verification (pinned Z3)" job, red on develop's tip). **Open.**

## Minimal reproducer (leaks 33 B: one String + its 1-byte buffer)

```rust
{ String } :: import("std/string");
{ ArrayList } :: import("std/collections/array_list");
{ JsonValue } :: import("std/encoding/json");

main :: (fn() -> unit)({
  vs := ArrayList(JsonValue).new();
  vs.push(JsonValue.Str(String.from("x")));
  vi := vs(usize(0));            // ← leaks one reference to the String
  consume(vi);                   // any reader; unused also leaks
});
export(main);
```

`yo compile --sanitize address` + run → `SUMMARY: 33 byte(s) leaked in 2 allocation(s)`.
The element type must be a VALUE enum (or struct) carrying RC fields (`JsonValue`
holds `String`/`ArrayList` handles); a `String` element alone does not trigger it.

Discriminators already measured:

| shape | verdict |
| --- | --- |
| `vi := vs(i); consume(vi);` | **leaks** (1 String per binding) |
| `consume(vs(i));` (direct argument) | clean |
| loop body, hoisted `vi := vs(i)` | leaks per iteration |
| `stringify` of an `Object` with both lists non-empty | leaks (its loop reads `values(i)` — but note the ARGUMENT form is clean, so the stringify path's leak routes through its own hoisted/binding shapes) |
| construction + push only, no read | clean |

## What the emitted C shows

```c
__yo_t_json _file_...960 = (*__yo_fs_index(&vs, 0ULL));      // the read (borrowed copy)
__yo_t_json temp_dup_enum_0 = _file_...960;                   // deferred dup emitted
switch ((temp_dup_enum_0).tag) { ... __yo_incr_rc(fields) ... }  //  ← the +1
  temp_dup_enum_0;                                            //  ← the OWNED copy DISCARDED as a statement
  __yo_t_json vi = _file_...960;                              //  ← binding takes the PRE-dup temp
  vi;                                                         //  ← binding value, also bare
/* scope end: drops the push temp and vs — NOTHING drops vi or temp_dup_enum_0 */
```

`emit_deferred_dup_or_code` (`src/codegen/exprs/drop_dup.yo`) correctly emits the
inline value-enum dup and returns `temp_dup_enum_0` as the owned-value code — but
the `:=` binding path (the begin-block statement emitter,
`src/codegen/exprs/generation.yo:735` dispatches `":"` to the decl-only
`generate_binding`; the assignment flows elsewhere) prints that return value as a
bare expression statement, binds `vi` to the pre-dup read temp, and registers no
scope-end drop for `vi`. Net: `+1` per binding, never released.

This is the same family as the #888/#891 argument-temp fixes and the
dup/drop-pair hazards in AGENTS.md ("a move … manufactured by the dup/drop pair
optimizer"); any fix must go through the dup/drop emit-diff gate plus an
over-cancellation canary per the standing rules.

## Where it bites

`JsonValue`-shaped data read out of containers: the verifier driver
(`_stringify_into`'s Object arm → `verifier_harness_self_test` in
`tests/internal/verifier.test.yo`, the CI red), and any user code doing
`v := list_of_value_enums(i)`.

## Fix sketch (next session)

1. In the `:=` lowering, use the value returned by `emit_deferred_dup_or_code`
   as the initializer (not the pre-dup temp) and stop emitting the dup result as
   a bare statement.
2. Register the binding for a scope-end drop (deferred-drop list) when the type
   carries RC fields.
3. Failing test first: the minimal repro above as
   `tests/internal/…` or a language test with a Dispose counter / rc(...) check.
