# Bug: `try_match_pat` fails for variant-with-args in self-hosted parser format

## Status: Fixed in eval.yo Phase 3ae

## Summary

`try_match_pat` in `yo-self/evaluator/eval.yo` only handled the TypeScript parser's AST
format for variant-with-args patterns like `.Some(x)`. The self-hosted parser produces a
different AST format that was not handled, causing all `.SomeVariant(binding)` patterns
inside `generate_exprs_from_code` source strings to silently fail (return `false`).

## Root cause

The two parsers produce different ASTs for `.Some(x)`:

**TypeScript parser format** (TS format):

```
.Some(x) → FnCall(
  func: FnCall(Atom(Dot), [Atom("Some")], infix=true),
  args: [Atom("x")],
  infix=false
)
```

**Self-hosted parser format**:

```
.Some(x) → FnCall(
  func: Atom(Dot),
  args: [FnCall(Atom("Some"), [Atom("x")], infix=false)],
  infix=false
)
```

The old `try_match_pat` matched:

- Case 1 (`pat_func.* = Atom(Dot)`): tried to get `pat_args[0]` as `Atom(name)`, but for self-hosted format
  `pat_args[0]` is `FnCall(Atom("Some"), [...])` — a FnCall, not an Atom → returned `false`
- Case 2 (`pat_func.* = FnCall(...)`): handled TS format only

Fieldless variants like `.None` work in both formats because:

- TS format: `FnCall(Atom(Dot), [Atom("None")], infix=true)` — `pat_args[0]` is Atom → ✓
- Self-hosted format: same as TS for fieldless (no call args follow `.None`)

## Fix

Extended Case 1 (when `pat_func.* = Atom(Dot)`) to handle two sub-cases for `pat_args[0]`:

- `Atom(vntok)` → fieldless variant (unchanged behavior)
- `FnCall(sh_vfunc, sh_vargs, ...)` → variant-with-args in self-hosted format:
  - `sh_vfunc.*` = `Atom("Some")` → `sh_vname = "Some"`, `sh_full_v = ".Some"`
  - `sh_vargs` = binding expressions → bound into env

**File changed**: `yo-self/evaluator/eval.yo` (try_match_pat, Case 1 Atom dot handler)

## Test coverage added (Phase 3ae)

Tests in `yo-self/tests/eval.test.yo`:

- `evaluate_module_body: match .Some(x) binding — self-hosted parser format`
- `evaluate_module_body: match .None branch when no match`
