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
- ✗ `q := quote(42); export q;` — wasm `unreachable` panic (quote builtin path has bugs)
- ✗ `y := quote(7); z := quote(unquote(y)); export z;` — `no module value produced` (no ModuleVal returned)

So even the "proper" Evaluator's quote/unquote machinery is incomplete or buggy. The `evaluate_quote` function exists but the surrounding wiring (callee evaluation, builtin keyword resolution under skip-prelude) doesn't reach it correctly yet.

### Recommended fix path

1. **Triage the proper Evaluator's quote bug** — add error-message printing, find why `quote(42)` traps. Likely a missing dispatch arm somewhere upstream of `evaluate_quote`, or an unreachable in `process_unquotes_in_expr`.
2. **Make `evaluator_index.test.yo` style tests pass for `quote(...)` and a tiny user-defined macro** without prelude — proves macro infrastructure end-to-end.
3. **Then** wire prelude loading from a real file system (so Evaluator can load the actual `std/prelude.yo` and the `for` macro becomes available).
4. **Then** migrate `yo-self/tests/eval.test.yo`'s 2010 tests from the proto-evaluator to the proper Evaluator. ~197 tests use the divergent `for(x, arr, body)` 3-arg form and will need rewriting to `for(arr.iter(), x => body)`.
5. Once the proto-evaluator has no callers among the test corpus, remove `(fval == "for")` (and audit other proto-eval built-ins — `if`, `comptime_assert`, etc. — for similar TS divergences).

## Workaround (current)

Until fixed, evaluator test source strings continue using the 3-arg form `for(x, arr, body)`
to match the buggy built-in handler in the proto-evaluator. New tests should also use this
form, with a comment referencing this issue.
