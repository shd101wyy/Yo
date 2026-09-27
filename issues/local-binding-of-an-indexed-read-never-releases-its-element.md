# `vi := list(i)` of a value-type element with RC fields leaks one reference per binding

Found 2026-09-27 root-causing `issues/verifier-z3-harness-self-test-leaks-40-bytes.md`
(Linux CI's "Formal verification (pinned Z3)" job, red on develop's tip). **Open.**

COORDINATION 2026-09-27: the CI z3 case itself is being fixed by the
drop-liburing agent (branch `fv-param-interior-drop`: by-value COMPOSITE
params own their interior RC references — `_verdict_to_json(verdict)`'s
VerifyVerdict — a different missing-drop site in the same family; their issue
is `issues/fv-z3-self-test-leaks-one-interior-ref-per-composite-argument.md`). Their fix does not
obviously cover THIS issue's local-binding/DCE-tail site; this repro gets
verified against their fix once pushed and this issue closes or follows up
accordingly. The CI "v0.2.44 seed" correlation is disproven: the leak
reproduces under v0.2.43-seed compilers with the pinned z3 5.1.0
(`YO_Z3_PATH` + `YO_TEST_Z3=1`); z3 4.16 passes — the solver's verdict/core
shapes route different payloads through the leaking path.

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

## ROOT CAUSE (2026-09-27, probe-verified with YO_DEBUG_SCOPE_DROPS)

The trigger is narrower than "any := of an index read" — it needs the block's
trailing statement to be a PURE CALL that DCEs:

| shape (straight-line, `vs : ArrayList(JsonValue)`, one `.Str` pushed) | verdict |
| --- | --- |
| `vi := vs(0);` (nothing else) | **clean** — `vi`'s scope drop IS emitted |
| `vi := vs(0); consume(vi);` with `consume` pure → DCE'd to the bare atom `vi;` | **LEAKS** — no `vi` drop |
| `vi := vs(0);` + a live (non-pure) use | clean |
| `(vi : JsonValue) = vs(0);` (no use) | clean |

Mechanism, confirmed by the `[sd]` scheduler probe: when the trailing pure
call is DCE'd, the block's LAST EXPRESSION becomes the bare atom `vi`
(the emitted C literally ends the block with `  vi;`). The scope-end
scheduler (`_schedule_scope_end_drops`, `src/evaluator/exprs/begin.yo`)
deliberately excludes the tail atom — "A bare-atom block result is a named
local moved out (returned) — never drop it":

```
[sd] var=vi owning=false ... e7=false      // e7 excludes the tail atom
```

so `vi` gets no scope-end drop, while the DEFERRED DUP on the index read
(`temp_dup_enum_0` + field `__yo_incr_rc`s) survives at the binding. Net +1,
never released. With no trailing statement (or a live one) the tail is not a
bare atom and the drop is emitted (`[sd-fl] target=vi` present).

The "moved out" premise is false for a DISCARDED block result: a
statement-position begin (or a unit block) whose tail DCE'd to an atom moves
nothing — the value dies with the block and its drop must run.

## Fix directions (either, with the dup/drop emit-diff gate + canary)

1. **DCE shape**: a pure call statement should DCE to unit/nothing, not to
   its bare-argument atom (find where the elided call leaves the argument
   atom as the statement value; `vi;` in the C is that artifact).
2. **Tail-atom exclusion scope**: apply `tail_atom_name` exclusion only when
   the block's result is actually CONSUMED by the enclosing context
   (expression position / function-body return); a discarded/unit-tail block
   keeps the drop. The caller of `_schedule_scope_end_drops` knows the
   context.

`YO_DEBUG_SCOPE_DROPS=1` now ships (gated, module-cached knobs): `[sd]` rows
(scheduler eligibility), `[sd-fl]` rows (flushed drop targets),
`[sd-emq]` rows (begin-path emission queue).

## Earlier analysis (superseded by the above, kept for the C evidence)

## Pinpointed sites (2026-09-27, traced to the end)

1. `emit_deferred_dup_or_code` (`src/codegen/exprs/drop_dup.yo`, the
   `dup_result_name` match) only adopts a dup result temp when the recorded
   dup expression is an fn_call whose ExprInfo carries a `variable_name` with
   `type_key == type_key` of the source. The INLINE VALUE-ENUM dup (no
   registered `___dup`) has no such variable_name → `dup_result_name = None`
   → the `true` arm returns the PRE-dup fallback
   (`_file_…960`) while `generate_deferred_dup_expressions` has already
   materialized the owned temp `temp_dup_enum_0`.
2. `generate_deferred_dup_expressions` (same file) renders the dup's return
   code as a BARE STATEMENT (`  temp_dup_enum_0;`) — the +1 is taken and
   discarded. That is the stray line in the C above.
3. The scalar `:=` path (`src/codegen/exprs/init_assignment.yo`, ~465-525)
   then emits `vi = _file_…960;` from the returned fallback. `vi` gets NO
   scope-end drop in the emitted C (compare `_cache_store`'s `payload`,
   whose scope drop IS emitted — so value-enum locals CAN get one; why `vi`
   does not is part of the fix).

Fix = make the inline value-enum dup's result temp flow back through
`emit_deferred_dup_or_code` (with the same type_key guard), stop
statement-izing it, and ensure the binding's scope-end drop exists. Gate with
the dup/drop emit-diff + an over-cancellation canary (AGENTS.md), plus the
7-line repro as a failing test.

## Fix sketch (next session)

1. In the `:=` lowering, use the value returned by `emit_deferred_dup_or_code`
   as the initializer (not the pre-dup temp) and stop emitting the dup result as
   a bare statement.
2. Register the binding for a scope-end drop (deferred-drop list) when the type
   carries RC fields.
3. Failing test first: the minimal repro above as
   `tests/internal/…` or a language test with a Dispose counter / rc(...) check.
