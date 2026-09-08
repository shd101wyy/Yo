# "Cannot unify incompatible types" is thrown at a SYNTHETIC token, so the LSP underlines line 0 column 0 and the CLI prints no `-->` anchor

**Status:** FIXED 2026-09-08 (see "Fix" below). Found 2026-09-08 while recording
`tests/cli-cases/lsp-member-definition` (a probe document with a
`usize`/`i32` mix). **Severity:** wrong-value on the editor surface (a red
squiggle on the first character of the file for an error elsewhere) and a
missing location in the CLI rendering.

## Symptom

```json
{"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":1}},"severity":1,
 "source":"yo","message":"Cannot unify incompatible types: \"i32\" and \"usize\""}
```

No `code` either: the diagnostic is not a registry error.

## Root cause

`src/evaluator/types/synthesizer.yo` (the throw near line 2154):

```rust
exn.throw(dyn(format_error_message(
  synthetic_token(String.from("type"), ee.module_path),
  `Cannot unify incompatible types: …`)));
```

The synthesizer unifies TYPES and has no expression in hand, so it anchors
the error at a synthetic token (row 0, column 0 of the module). Its callers —
argument checking in `src/evaluator/calls/function.yo` / `helper.yo`,
assignment checking — DO know the expression whose type failed to unify but
let the synthesizer's error pass through unchanged.

## Fix

The first direction: `SynthesizeOptions` already carried an optional `token`
(read once, at the top of `_synthesize_types_impl`, but never used by a
throw). Every synthesis error — incompatible types / tuples / structs /
enums, the two occurs-check "infinite type" errors, and the two effect-row
errors — is now anchored through `_anchor(tok, …)`: the option token when the
caller supplied one, else the old synthetic token. The two callers whose
errors reach the user pass one: `check_if_function_parameter_matches_argument`
(Step 6, the ARGUMENT's token) and `try_to_call_function_with_arguments`
(Step 10, return type vs the caller's expected type: the CALL's token). The
other callers run the synthesizer under swallowing handlers (trials, impl
matching, closure return inference) and are unchanged.

`set_resolved_concrete_type` stays `false` in the supplied options, so the
synthesizer's binding behaviour is exactly what `None` gave it.

## Verification

`tests/cli-cases/check-unify-error-anchor`: `count + i32(2)` with `count :
usize` reports `--> main.yo:4:21` (the `i32` argument) and the message; before,
the anchor was `main.yo:1:1`. Not given a registry code here — `yo explain`
coverage for unification failures is a separate registry addition.
