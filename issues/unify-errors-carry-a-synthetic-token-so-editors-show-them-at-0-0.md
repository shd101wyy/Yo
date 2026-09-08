# "Cannot unify incompatible types" is thrown at a SYNTHETIC token, so the LSP underlines line 0 column 0 and the CLI prints no `-->` anchor

**Status:** OPEN — found 2026-09-08 while recording
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

## Fix direction

Thread the expression under check into the synthesizer's error: either pass
the anchoring token down to `synthesize`'s throw, or catch the unification
error at the call-site boundary and re-throw it anchored at the argument /
assigned expression (keeping the message). The second keeps the synthesizer
expression-free but adds a handler per boundary; the first is one parameter
threaded through the unify recursion. Either way the error should also take a
registry code so `yo explain` reaches it.

Not fixed in the PR that found it: it is an evaluator diagnostics change
(plans/reference/ERROR_DIAGNOSTICS_OVERHAUL.md's channel), independent of the
LSP work that exposed it.
