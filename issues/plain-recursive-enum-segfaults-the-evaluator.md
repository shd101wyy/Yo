# A plain (non-`ref`) enum whose variant fields recurse into itself SEGFAULTS the evaluator instead of erroring

**Status: OPEN** (surfaced 2026-09-07 by Phase V2 of
`plans/backlog/FORMAL_VERIFICATION.md` — the `src/verifier/terms.yo` VC term
IR was originally written as a plain `enum` and crashed the compiler).

## Error

```
$ yo check src/verifier/terms.yo
Segmentation fault (core dumped)          # rc=139 — no diagnostic at all
```

Reproduces with the seed release v0.2.27 AND with a current-develop
self-built binary. `YO_MAIN_STACK_MB=4096` does NOT help — the recursion is
infinite, not merely deep.

## Reproducer

Any module that (a) defines a plain `enum` whose recursion reaches itself
(`App(op, args : ArrayList(Self))` and/or `Quant(..., body : Self)`), (b)
puts that enum in a `ref(struct(...))` field together with
`ArrayList(<struct-holding-the-enum>)` fields, and (c) defines a function
CONSTRUCTING the struct (forcing size/type walks) — the exact shape is the
pre-`ref` `src/verifier/terms.yo` (see "Root cause" for the minimal
reduction attempts). The crash needs the construction/machinery that forces
a size computation of the cyclic value type; type definitions alone pass.

## Root cause analysis

The crash is an infinite mutual recursion in the TYPE SIZE machinery of
`src/types/utils.yo`:

- `get_size_of_type`'s `.EnumT` branch (utils.yo:1697) computes a value
  enum's size by walking every variant's field types
  (`_variant_storage_field_types` → `_aggregate_size` → per-field
  `get_size_of_type`).
- For a plain enum `E` with `App(args : ArrayList(E))`, the walk descends
  `E → ArrayList(E) → E → …` — but `ArrayList` IS reference semantics, so
  that particular cycle terminates (pointer size). The crash needs the
  cycle to be re-entered through the *enclosing struct* machinery
  (`VcQuery` field walks via compat/constructor paths), where the
  ref-indirection bookkeeping does not cut the loop.
- `get_size_of_type`'s only cycle guard is the `e_ref` short-circuit for
  `ref(enum(…))` ("without it the variant-field walk recurses forever on a
  recursive ref-enum", utils.yo:1691-1696) — there is NO guard for plain
  enums reached through struct fields, and no `visited` set anywhere in the
  size/alignment family (`get_alignment_of_type`, `_aggregate_size`,
  `_max_field_alignment`).

Under gdb the stack is thousands of frames of
`get_size_of_type ↔ _aggregate_size` until the crash lands in mimalloc.

The DEEPER issue: a plain value enum that recursively contains itself
WITHOUT a reference indirection on every cycle is not layoutable in C at
all (infinite size) — `AstExpr` is `ref(enum(…))` for exactly this reason
(`src/expr.yo:281`). The compiler should REJECT such a definition with a
clean diagnostic ("recursive value enum must be `ref(enum(…))` — a value
enum cannot contain itself by value"), not segfault at the next size query.

## Fix direction

1. At enum-type evaluation (definition time), run a structural cycle check
   over the variant field types: any path from the enum back to itself that
   does not pass through reference-semantics indirection (`ref(struct)`,
   `ref(enum)`, `ArrayList`, `Box`, …) is a hard error with the hint above.
2. Belt-and-braces: thread a `visited` set through the size/alignment
   walkers in `src/types/utils.yo` so a missed cycle yields `.None`
   (unknown size) instead of a stack overflow.

## Notes

- `JsonValue` (`std/encoding/json.yo`) is the surviving precedent of a
  plain enum recursive only via `ArrayList(Self)` — legal and unchanged.
- The V2 verifier IR uses `ref(enum(…))` for `VcTerm`/`Z3Sexpr` (the
  `AstExpr` shape), which is the correct design for an interned tree IR
  regardless of this bug.
