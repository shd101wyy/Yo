# LSP completion/hover shows `<struct:struct_yo_id_4057>` instead of a type name

**FIXED 2026-09-08** — not by naming instantiations (the compatibility layer
treats a struct/enum NAME as nominal identity, so stamping every instantiation
broke unification — see the Box note in `src/evaluator/calls/comptime_fn.yo`)
but by a RENDER-ONLY side table: `src/types/string.yo` keeps
`type_id → "Ctor(args)"`, filled by the comptime constructor call that mints
the instantiation (`register_type_display_name` in comptime_fn.yo — the callee
spelling, identifier or operator such as the `?` Option shorthand, plus the
rendered arguments), and `type_to_string` consults it whenever a struct/enum
has no written name. Nothing else reads the table, so identity is untouched.
`mm_reset` clears it. Result: hover reads `list : ArrayList(i32)`,
`opt : Option(i32)`; completion details read `fn(self : ArrayList(T)) -> …`
(`tests/cli-cases/lsp-member-definition`, and the re-recorded
`lsp-completion` golden — which also stops churning on prelude id renumbering).
Enum instantiations needed no new type field after all: the id is enough as
the key.

**Status:** OPEN
**Found:** 2026-08-25, reading the `lsp-completion` CLI golden while landing
`derive(Default)`.
**Severity:** low (cosmetic), but it is on the most-seen surface in the language.

## Symptom

Every `ArrayList` method in the completion response carries a `detail` string
built from the compiler's internal type rendering:

```json
{"label":"push","detail":"fn(self : <struct:struct_yo_id_4057>, value : T) -> <enum:enum_yo_id_4081>"}
```

A user hovering `push` is told its receiver is `<struct:struct_yo_id_4057>` and
that it returns `<enum:enum_yo_id_4081>`. The intended reading is
`fn(self : ArrayList(T), value : T) -> Result(unit, ArrayListError)` or similar.

Also visible in the golden: the ids renumber whenever the prelude gains a
declaration, so this golden churns on unrelated prelude edits (it moved by
exactly +1 for the two lines `derive(Default)` added).

## Root cause

Same renderer as
issues/fixed/derive-rules-name-types-through-a-display-renderer.md:
`type_to_string` (src/types/string.yo) returns a type's written `name` when it
has one and `<struct:${id}>` / `<enum:${id}>` when it does not. An INSTANTIATED
generic — `ArrayList(T)`, `Option(i32)`, `Result(A, B)` — has no written name, so
it renders as the placeholder.

For that fix the answer was to stop rendering types at all (construct through
`Self`; reach field types by index). The LSP has no such option: its whole job is
to SHOW the type to a human, so this one has to be fixed in the renderer.

## Fix sketch

Render an instantiated generic structurally as `Ctor(Arg, …)`. The pieces are
half-present: `StructT` already carries `constructor_func_id` and
`type_arguments`, so a struct instantiation can be reassembled once the ctor id
resolves to a NAME. `EnumT` carries neither, so `Option(i32)` needs the
constructor identity plumbed through the enum type first — which is the larger
half of this work and why it is filed rather than fixed in passing.

Worth doing with the D3.9/S2 window, when type identity is already being touched.

## Note

Fixing it will churn the `lsp-completion` golden substantially — that is expected,
and the golden becomes far more readable (and far less prone to renumbering churn)
afterwards.
