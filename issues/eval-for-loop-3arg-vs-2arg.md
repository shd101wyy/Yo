# Self-hosted evaluator: built-in `for` handler diverges from TypeScript implementation

## Status: Bug — divergence from reference (TypeScript) implementation

## Description

The Yo `for` loop is a **prelude macro** defined in `std/prelude.yo` (line 5772). It takes
2 arguments and expands to `while runtime(true), { match(iter.next(), .Some(x) => body, .None => break) }`:

```rust
for(iter_expr, x => { body });          // expands at compile-time via prelude macro
for(list.iter(), x => { use(x); });     // first arg must have .next() method
```

### TypeScript reference behavior

The TypeScript evaluator (`src/evaluator/`) has **no built-in handler** for `for`. A grep
for `"for"` in `src/evaluator/` only finds the loop-context tracker `kind: "while" | "for"`
in `context.ts` — never any dispatch case. `for` is handled exclusively through the
generic macro-call path (because `prelude.yo` is auto-loaded into every module).

### Self-hosted evaluator divergence

`yo-self/evaluator/eval.yo` line 4682 contains a built-in handler:

```rust
(fval == "for") => match(args.get(usize(0)), ...)  // expects 3 args!
```

This handler:

1. Doesn't exist in the TypeScript reference
2. Expects the wrong arity — 3 args `for(item_pat, collection_expr, body_expr)` instead of
   the macro's 2 args `for(iter, x => body)`
3. Iterates only over `ArrayVal` values, not generic iterators with `.next()`

## Impact

- Self-hosted eval tests that use the proper 2-arg form crash with WASM unreachable.
- The 30+ existing eval tests in `yo-self/tests/eval.test.yo` use the wrong `for(x, arr, body)`
  3-arg form to work around this.
- Once the bug is fixed (built-in handler removed and prelude macro expansion supported),
  all those tests will need to be migrated to `for(arr.iter(), x => body)`.

## Fix Plan

The yo-self bootstrap actually has TWO evaluator pipelines (discovered during Phase 6 verification):

1. **Proto-evaluator** (`yo-self/evaluator/eval.yo`, ~5727 lines) — flat dispatch on `fval == "..."` strings; used directly by `yo-self/tests/eval.test.yo` via `import { evaluate, ... } from "../evaluator/eval.yo"`. This is where the divergent `(fval == "for")` 3-arg handler lives.

2. **Proper TS-style port** (`yo-self/evaluator/index.yo` `Evaluator.new` → `evaluator/exprs/_expr.yo`) — modular dispatch keyed by `BK_*`/`BF_*` builtin tokens; structurally mirrors `src/evaluator/`. Already imports `evaluate_quote` from `builtins/quote.yo` and dispatches `BK_QUOTE`. Already auto-loads prelude in `Evaluator.new` (unless `@skip_prelude` directive). Already has `builtins/macro_expand.yo`.

### Phase 6 verification results (`yo-self/tests/phase6_verify.test.yo`)

Tested the proper Evaluator path with `@skip_prelude` sources:

- ✅ trivial `x := 1; export x;` works end-to-end (proper Evaluator's basic eval pipeline runs)
- ✗ `q := quote(42); export q;` — `no module value produced` (proto-eval doesn't know `quote`)
- ✗ `y := quote(7); z := quote(unquote(y)); export z;` — same root cause

### THE smoking gun (root cause)

There are **two function-pointer slots**, but `Evaluator.new` only wires one:

- `g_eval_fn` in `evaluator/eval.yo` — set by `_eval_fn_init()` (eval.yo:5714) to the **proto-evaluator's** `evaluate` function. **Used by `evaluate_module_body`** (eval.yo:2657, called from `Evaluator.new` at index.yo:173).
- `g_evaluate_expression` in `evaluator/exprs/expr.yo` — set by `register_evaluate_expression()` to the modular `_evaluate_expression_wrapper`. Read only by external callers of `evaluate_expression(...)`.

`Evaluator.new` calls `register_evaluate_expression()` which fills the modular slot — but `evaluate_module_body` doesn't consult that slot. It calls `g_eval_fn` (proto-eval), which has no quote handler. So the modular `evaluate_quote` dispatch in `_expr.yo:479` is **unreachable** through `Evaluator.new`.

This explains why `quote(42)` silently produces no module value: proto-eval's default function-call fallback fails to resolve `quote` as a variable, returns `None` → `ok = false` in `evaluate_module_body` → `module_value = None`.

### Architectural mismatch (why bridging is non-trivial)

- Proto-eval signature: `(AstExpr, *Environment) -> Option(EvalResult)`. Values are returned inline via `EvalResult.value`. **No EvalContext.**
- Modular signature: `(AstExpr, *Environment, *EvalContext) -> AstExpr`. Values are stored in `ctx.expr_info_table[ast_expr_id(returned)]` and looked up by id. **EvalContext is required throughout `evaluator/builtins/quote.yo`.**

A "minimal" bridge would need to:

1. Have `Evaluator.new` create an `EvalContext` and store it in a stable, globally-accessible slot for the duration of `evaluate_module_body`.
2. In proto-eval's function-call fallback, recognize `BK_QUOTE`/`BK_GENSYM`/`BK_UNQUOTE`/`BK_HASH`/`BF_MACRO_EXPAND` and forward to `g_evaluate_expression` with the global ctx.
3. After modular returns an `AstExpr`, look up the value in the global `ctx.expr_info_table` and translate back to `EvalResult`.

Each step has Yo-semantics subtleties (object lifetime via `Option(EvalContext)` globals; whether `&` of an Option content is stable; how to thread ctx through proto-eval without changing every recursive call). This is significant plumbing — not an afternoon task.

### Recommended fix path (revised, scope-honest)

1. **Phase 6.1a — Add EvalContext lifecycle to Evaluator.new.** Create ctx in `Evaluator.new`, store it in a module-level global, set/clear it around `evaluate_module_body`. Verify trivial test still passes.
2. **Phase 6.1b — Bridge proto-eval to the modular dispatcher** via the global ctx. Initially only for `BK_QUOTE`/`BK_GENSYM`/`BK_UNQUOTE`/`BK_HASH`/`BF_MACRO_EXPAND`.
3. **Phase 6.2** — Verify `phase6_verify.test.yo` passes; add a tiny user-defined macro test.
4. **Phase 6.3** — Wire prelude loading from a real filesystem so `std/prelude.yo`'s `for` macro becomes available.
5. **Phase 6.4** — Migrate `eval.test.yo`'s ~197 affected tests from `for(x, arr, body)` to `for(arr.iter(), x => body)`.
6. **Phase 6.5** — Remove the divergent `(fval == "for")` handler from `eval.yo`; audit other proto-eval built-ins for similar TS divergences.

Long-term: retire the proto-evaluator entirely by fleshing out the modular dispatcher to cover all proto-eval constructs, then switch `evaluate_module_body` to call `g_evaluate_expression` directly. That is the eventual end-state matching the TypeScript reference architecture.

## Workaround (current)

Until fixed, evaluator test source strings continue using the 3-arg form `for(x, arr, body)`
to match the buggy built-in handler in the proto-evaluator. New tests should also use this
form, with a comment referencing this issue.

## Migration attempt log (this session)

Tried to mechanically migrate all 199 occurrences of `for(x, arr, { body })` in
`yo-self/tests/eval.test.yo` to an explicit `while` + `arr.get(i)` rewrite, with the goal of
then deleting the built-in `for` handler from the proto-evaluator.

Result: the migration ran cleanly (a Python brace-balanced rewrite — 199 replacements,
including 4 nested `for` cases). However, compiling the migrated `eval.test.yo` (now ~2 MB
of source after string expansion) made the TypeScript `yo-cli` consume **~30 GB RSS over
30+ minutes with no progress output**, even when restricted to a single test. The compiler
is hitting a pathological case on the larger generated test source — likely related to
literal-string handling or function-body size. This is independent of the migration's
correctness; it's a TS compiler scaling issue.

Decision: **revert the migration and keep the 3-arg `for` handler** with a prominent
"DIVERGENCE FROM TS REFERENCE" warning comment in `yo-self/evaluator/eval.yo`. Removing
the handler is deferred until either:

- the proper Evaluator (`evaluator/index.yo` `Evaluator.new`) is wired into
  `evaluate_module_body` so `eval.test.yo` can switch to using it (and prelude loading
  brings in the real `for` macro), OR
- the TS yo-cli's compile-time scaling on large test files is improved.

The handler is still **wrong** in the same way it was before. It is now clearly marked
as wrong, and the issue file documents the migration attempt so future sessions don't
repeat the same compile-time blowup.
