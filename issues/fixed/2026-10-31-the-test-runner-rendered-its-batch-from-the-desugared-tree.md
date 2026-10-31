# The test runner rendered its batch from the desugared tree, so decision 47's `mut(...)` markers vanished from every batch

**Severity:** S2 — with the desugar-time `mut(<ident>)` strip (decision 47 "As built", B8 prerequisite), every `yo test` batch lost the `mut(...)` / `thread_local(...)` markers of the file's non-test statements: `tests/mut_bindings.test.yo` failed 15/15 with E0917 (`_MB_MODULE_COUNTER :: 1;` rendered without its marker, then written). Found on the branch that introduced the strip, before it landed.

**Status:** FIXED 2026-10-31 (fix/ast-immutable-before-b8).

## Symptom

`yo test ./tests/mut_bindings.test.yo` on build h1 of `fix/ast-immutable-before-b8` (7145a6039, log `vbd-logs/ast-immutable/t-mut_bindings.log`): all 15 tests fail, each batch dying at evaluation of the file's module-level bindings:

```
error[E0917]: cannot assign to immutable binding `_MB_MODULE_COUNTER`
```

The batch file (`.yo_selftest_batch_*.yo`) showed `_MB_MODULE_COUNTER :: 1;` where the source says `(mut(_MB_MODULE_COUNTER) : i32) = 0;`.

## Root cause

The test runner builds each batch as SOURCE TEXT: it parses the `*.test.yo` file, renders every non-test statement and each test body with `ast_expr_to_string`, writes the synthesized program next to the test file and compiles it (`run_test`, `src/main.yo` ~11725).

Since decision 47's strip moved to `desugar_if_calls`, the runner's `parse(&src, …)` returns a tree whose well-formed `mut(...)` / `thread_local(...)` binders are already stripped — the marker survives only as a registry entry keyed by the ORIGINAL file's tokens. Re-rendering that tree produces source without the markers, and the batch's own parse (which desugars again) can record nothing: the marker text is gone. The evaluator then judges `_MB_MODULE_COUNTER` immutable and every write is E0917.

Any other consumer that renders a DESUGARED tree back into source that is parsed again loses the markers the same way. Audit of the surviving consumers (2026-10-31, this branch):

- `generate_expr_from_code` / `.to_expr()` / `__yo_comptime_string_to_exprs` (`src/parser.yo`, `src/evaluator/builtins/type_fns.yo`): parse USER-AUTHORED strings through the desugaring `parse`, which strips and registers by the generated tokens — splice semantics intact.
- derive (`src/evaluator/builtins/derive.yo`): binds the target/param `AstExpr` values as comptime vars and generates only variable-name code — no tree is re-rendered.
- `yo fix` writers (`_run_migrate_*`, `src/main.yo`): all work from `_raw_parse_or_none` (no desugar) and edit source text by position.
- the formatter renders the token stream; LSP hover / `yo doc` / `vc.yo` render display text; `module_manager.yo`'s `stmt_state` render is a watch fingerprint hashed and compared within one binary run.

The test runner was the only real case.

## Fix

`run_test` parses with the RAW parser (`Parser.new(&src, &file, exn).get_program(exn)`, as `_raw_parse_or_none` does) instead of `parse(…)`. The rendered batch then keeps the markers as text (`if(...)` macro heads included), and the batch's own parse desugars and records them by the batch's tokens. The runner only WALKS the tree (splits `test(...)` declarations from other statements, extracts names and bodies); nothing in it needs the desugared form.

## Result

`yo test ./tests/mut_bindings.test.yo` with the rebuilt binary (build h2 of this branch): 15/15 pass. `tests/mut_bindings.test.yo`'s module-level `(thread_local(mut(g)) : i32) = 0` write case is the regression test.
