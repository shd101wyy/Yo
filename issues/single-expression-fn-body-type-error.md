# Single-expression brace fn bodies mis-type as the annotation's struct

- **Status:** open (surfaced 2026-09-11 during V5 quantifier work; proven
  PRE-EXISTING — the v0.2.30 seed fails identically)
- **Component:** evaluator fn-type application × the single-expression
  begin/tail shared-id construct
- **Severity:** loud compile error on legal-looking code (completeness)

## Reproducer (fails on the seed and on develop)

```rust
f :: (fn(x : i32) -> i32)({ x });
export(f);
```

`yo check` (seed v0.2.30 and current develop builds):

```text
error: Function body has type `<struct:struct_yo_id_7038>`, but the declared result type is `i32`.
```

## What works / what fails

- `({ y := x; y })` (two statements) — OK.
- `({ x; })` (statement-final semicolon, unit return) — OK.
- `({ x })` (single EXPRESSION as the whole body) with a non-unit
  declared result — the type check at the fn-type site
  (`function_type.yo` ~1549) sees the body's type as a STRUCT minted
  from an annotation node's id (the id in the message tracks the
  signature's annotation nodes).

## Likely cause (to verify)

A single-expression begin block SHARES its AST node id with its tail
expr (the begin epilogue's shared-id carry-across,
AGENTS.md/evaluator docs). For a fn body of exactly that shape, the
def-time type check reads the SHARED node's info — which the annotation
evaluation (`x : i32` param spec machinery) already filled with the
param-spec STRUCT — so the body's reported type is that struct instead
of the tail expression's type. Multi-statement bodies get a fresh
begin-level info, which is why they work.

## Direction

The def-time result check (or the shared-id begin epilogue) must not
let the annotation's info clobber the tail's TYPE for the body-level
node — same family as the deferred-drop clobber fixed in
issues/fixed/ref-local-scope-drop-missing-after-value-call.md (fields
the begin epilogue owns vs the tail's). Verify with a driver print of
the shared node's info.ty before/after the annotation pass.
