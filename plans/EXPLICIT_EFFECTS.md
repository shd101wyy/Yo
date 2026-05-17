# Explicit Effects — Remove `using` / `given` Implicit Lookup

> Living plan document. The reference behaviour today is described in
> [`docs/en-US/ALGEBRAIC_EFFECTS.md`](../docs/en-US/ALGEBRAIC_EFFECTS.md);
> this plan replaces the **surface syntax** of effects with an
> entirely-explicit model while preserving the **evidence-passing codegen**
> verbatim.

## Motivation

Yo is targeting LLM authors as primary code producers; humans are primary
code readers/reviewers. Under that workload, the optimisation goal flips:

- **Verbosity is free** on the writing side (LLMs don't tire).
- **Local reasoning matters** on the reading side — a snippet should say
  what it does without referencing distant `given` bindings.
- **Refactor safety matters** — moving a function across files should not
  silently change which effect handler it picks up.

Today's `using`/`given` implicit-parameter machinery optimises for the
opposite ("don't make humans type effect args"). It introduces three
LLM-hostile properties:

1. **Hidden control flow.** `safe_divide(1, 0)` looks pure but may unwind
   the caller. The fact is recoverable only by reading the callee's
   signature plus the lexical scope chain looking for matching `given`.
2. **Spooky action at a distance.** A `given` at the top of a file
   silently provides evidence for every call below.
3. **Non-local errors.** "Ambiguous given" / "no matching given" / row
   unification errors require scope-walking reasoning instead of pointing
   at one offending call.

This plan removes those properties. The new rule: **every fn parameter is
passed explicitly at every call site, no exceptions.**

## Goal

After this work, an LLM (or human) can:

- Read any function body and identify every effect call by syntactic
  pattern alone.
- Predict whether a call can unwind the caller by looking only at the
  call site and the local variable bindings in the same function.
- Refactor without scope chains: moving a function across files cannot
  change its effect resolution.

Evidence-passing codegen stays bit-for-bit identical to today; the change
is at the surface-syntax + evaluator level only.

## Non-Goals

- **Not** changing the codegen strategy. Evidence passing
  (fn-ptr params + `__yo_effect_escaped` flag) stays.
- **Not** changing async/await semantics or the IO event loop.
- **Not** removing effects altogether. The language still supports
  one-shot delimited continuations via `return` / `unwind`.
- **Not** breaking-change safe. This plan accepts full prelude + tests +
  yo-self churn. Migration is one big mechanical pass.

## 1. Surface Syntax — Before/After

| Concept                      | Today                                                                             | Proposed                                                               |
| ---------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Declare effect               | `Raise :: (fn(msg : str) -> i32);`                                                | `Raise :: struct(raise : (fn(msg : str) -> i32));` (see §3)            |
| Fn param taking effect       | `safe_divide :: (fn(x : i32, y : i32, using(raise : Raise)) -> i32)`              | `safe_divide :: (fn(x : i32, y : i32, raise : Raise) -> i32)`          |
| Call site                    | `safe_divide(1, 0)` (implicit lookup) **or** `safe_divide(1, 0, using(my_raise))` | `safe_divide(1, 0, my_raise)` — always explicit                        |
| Install handler              | `given(raise) := (msg) -> { escape(42); };`                                       | `raise := (msg) -> { unwind(42); };`                                   |
| Propagating function         | `wrapper :: (fn(x, using(raise : Raise)) -> i32)(safe_divide(x, 0))`              | `wrapper :: (fn(x, raise : Raise) -> i32)(safe_divide(x, 0, raise))`   |
| Effect record (struct-based) | `using(exn : Exception)` then `exn.throw(...)`                                    | `exn : Exception` then `exn.throw(...)`                                |
| Continuation control         | `return(value)` resumes, `escape(value)` unwinds                                  | `return(value)` resumes, `unwind(value)` unwinds (renamed for clarity) |
| Skip + fallback to given     | `safe_divide(1, 0, using(undefined))`                                             | n/a — no implicit lookup, no fallback                                  |
| Effect row polymorphism      | `forall(T : Type, ...(E))` + `using(...(E))`                                      | `forall(T : Type, E : Effects)` + `e : E` (see §2)                     |

Removed keywords: `using`, `given`. Renamed: `escape` → `unwind`.

## 2. Effect Row Polymorphism — `E : Effects` as Generic Constraint

Today's `forall(...(E))` declares effect row variables as a special spread
construct, and `using(...(E))` spreads them as implicit parameters. The
explicit replacement models an effect row as a **generic parameter bound
by the `Effects` constraint** — it composes with existing `forall` /
generic syntax that the LLM already knows.

### Before

```rust
run :: (fn(forall(T : Type, ...(E)),
    f : (fn(using(...(E))) -> T),
    using(...(E))) -> T)(f());

result := run(might_fail);   // E inferred from might_fail's signature
```

### After

```rust
run :: (fn(forall(T : Type, E : Effects),
    f : (fn(e : E) -> T),
    e : E) -> T)(f(e));

effects := { yield : my_yield, log : my_log };
result := run(might_fail, effects);
```

### Why `E : Effects` over `...(E)`

| Property                                      | `...(E)`                   | `E : Effects`                 |
| --------------------------------------------- | -------------------------- | ----------------------------- |
| Follows existing patterns                     | No — unique spread syntax  | Yes — normal `forall` generic |
| LLM prior knowledge                           | Must learn a new concept   | Already knows generics        |
| Declaration / param / construction consistent | No — three different forms | Yes — `E`, `e : E`, `{ ... }` |
| Grep-able                                     | Bare `E` is ambiguous      | `Effects` is unique           |

### Specifics

- `E : Effects` is a **generic constraint** in `forall` — just like
  `T : Type` today. `Effects` is a built-in constraint that says "this
  type is a struct whose fields are fn-pointer evidence values."
- `e : E` in function signatures is a regular typed parameter. The
  compiler knows `E` is bound to `Effects`, so it applies evidence-passing
  codegen to `E`'s fields (flattening them into fn-ptr C parameters).
- Effect records are constructed with ordinary anonymous struct syntax:
  ```rust
  effects := { raise : my_raise, log : my_log };
  // Type: anonymous struct { raise : Raise, log : Log } — satisfies Effects
  // Shorthand (existing Yo syntax): { raise, log } ≡ { raise : raise, log : log }
  ```
- Combining rows (today's `using(...(E1), ...(E2))`) becomes record spread:
  ```rust
  // Before: using(...(E1), ...(E2))
  // After:  e := { ...e1, ...e2 }  // spread-builds a wider record
  //         f(e)                    // pass as one param
  ```
- Field access (`e.raise(msg)`) is regular struct field access.
- Monomorphisation is unchanged: at each call with a concrete effect
  record, the compiler generates a specialized version with the record's
  fields as separate fn-ptr C parameters via evidence passing.

### Closures with effect rows

```rust
// Before (two styles — inline declaration or call-site resolution)
traverse(arr, (v, using(yield : Yield, log : Log)) => { ... });
traverse(arr, (v, using(_yield, _log)) => { ... }, using(yield, log));

// After — effects are an explicit parameter, one consistent pattern
traverse(arr, (v, e) => { e.log(v); e.yield(v); }, effects);
```

## 3. Bare fn-Typed Effects → Always Wrap in a Struct

Today both shapes are supported:

```rust
Raise :: (fn(msg : str) -> i32);                              // bare fn-typed
Exception :: struct(throw : (fn(forall(T : Type), …) -> T));  // struct record
```

Under this plan, **bare fn-typed effects are removed**. All effects are
struct records. Single-method effects become single-field structs:

```rust
Raise :: struct(raise : (fn(msg : str) -> i32));
```

Rationale:

- One pattern instead of two. The LLM has a single shape to recognise.
- Effect rows always combine into records via field merging, so
  uniformity reduces special cases in the evaluator and codegen.
- Today's "function-typed evidence is resolved by structural matching"
  rule (a known source of LLM confusion) disappears with the bare form.

The migration cost is modest — `Raise`-style effects in the prelude get
wrapped, callers update from `raise(msg)` to `r.raise(msg)`. The codegen
side already handles struct-record evidence (one fn-ptr param per field).

## 4. Handler Install-Site Detection

Today `given` marks the install site (the stack frame where `unwind`
returns to). Without `given`, the install site is recovered by data flow:

- An evidence value whose **origin is a local definition**
  (`r := Raise(raise : (msg) -> { unwind(42); })`) installs at that
  scope. The enclosing function is the unwind target.
- An evidence value whose **origin is a parameter** propagates further
  up the call chain. The function that owns it does not install.

The evaluator tags each evidence binding with its origin during
specialization. Existing evidence-passing codegen already needs this
distinction (to know where to drop the SM unwind frame); the change is
that the marker comes from data-flow analysis instead of a `given`
keyword.

Note: the compiler already auto-detects handler functions via
`evaluatedBodyContainsEscape` → sets `isControlFunction`. The
`isInsideGivenHandler` context flag (which currently gates `escape`)
becomes unnecessary — `unwind` is valid in any function body, and the
compiler detects handlers by body analysis alone.

## 5. Rename `escape` → `unwind`

`escape` is overloaded (shell escaping, HTML escaping, character
escaping). An LLM seeing bare `escape(42)` has no local signal for what
kind of escape this is. `unwind` is unambiguous — it communicates "unwind
the stack" on its own, consistent with Rust's "stack unwinding"
terminology for the same conceptual operation.

`return(value)` keeps its meaning: resume the captured continuation with
`value`. The pair `unwind` / `return` is a clean conceptual pairing:
discard continuation vs. resume it.

This rename is independent of the rest of the plan and can land first or
last; recommended to bundle with Phase 0 (see §7).

## 6. Codegen — Unchanged

The C output is identical to today's evidence-passing strategy:

- Each evidence value becomes a fn-ptr (or `void*` for forall) C parameter.
- Effect call sites still emit:
  ```c
  __yo_effect_escaped = 0;
  result = (fn_ptr_cast)(args);
  if (__yo_effect_escaped) { /* drop locals + propagate */ }
  ```
- Install-site frame still memsets locals + propagates on `__yo_effect_escaped`.
- `__yo_escape_value` thread-local + value-memcpy for non-unit unwind
  values stays.
- Async-context unwind sets `sm->state = -2` etc., identical to today.

The only codegen-adjacent change is that **install-site detection** uses
a data-flow tag instead of a `given`-keyword tag (see §4). The data tag
is already produced by the evaluator and threaded into `ExprInfo`; the
codegen reads it the same way today.

### Constants renamed

- `__yo_effect_escaped` stays (still conceptually correct — the effect
  caused an unwind)
- `__yo_effect_escape_value` → `__yo_unwind_value`

## 7. Migration Scope

Files touched:

| Area                                                 | Approximate change                                                                                                                                                                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Lexer / parser** (`src/lexer.ts`, `src/parser.ts`) | Drop `using` and `given` keyword tokens. Drop `...(E)` spread parsing in `using`. Keep `forall(...)` with `E : Effects` generic constraint.                                                                                 |
| **Evaluator** (`src/evaluator/`)                     | Remove `using` / `given` handling. Remove `...(E)` row-spread evaluation. `E : Effects` is a normal forall generic — the constraint signals effect-record semantics. Add data-flow tagging for install-site detection.      |
| **Codegen** (`src/codegen/`)                         | Drop `using`-param emission paths. Existing fn-ptr param emission stays. Install-site frame setup reads new data-flow tag. Rename `__yo_effect_escape_value` → `__yo_unwind_value`.                                         |
| **Prelude** (`std/prelude.yo`)                       | Rewrite ~30–50 fn signatures: convert `using(exn : Exception)` → `exn : Exception`. Update internal call sites. Wrap bare-fn effects (e.g. `Raise`) in single-field structs. Replace `using(...(E))` with `e : E` patterns. |
| **Stdlib** (`std/**/*.yo`)                           | Same pattern as prelude. `std/error.yo`, `std/io/*`, `std/collections/*` are likely the largest.                                                                                                                            |
| **Test suite** (`tests/**/*.test.yo`)                | `tests/algebraic_effects.test.yo` (57 cases) gets the largest churn. Other tests touch `Exception` calls that need explicit `exn` arg threading.                                                                            |
| **yo-self port** (`yo-self/**/*.yo`)                 | Mirror the TS-side changes one-to-one. Evaluator + codegen + prelude.                                                                                                                                                       |
| **Docs** (`docs/en-US/`, `docs/zh-CN/`)              | Rewrite `ALGEBRAIC_EFFECTS.md` to describe the explicit model. Update `ASYNC_AWAIT.md` cross-references.                                                                                                                    |

### Suggested phasing

1. **Phase 0 — Rename `escape` → `unwind`.** Mechanical rename across all
   files (TS, `.yo`, docs). No semantics change. Land independently to
   keep the rest of the diff focused.
2. **Phase 1 — Wrap bare fn-typed effects in structs.** Prelude + tests.
   Still uses `using` / `given`. Tests stay green after this. Reduces the
   "two shapes" → "one shape" before changing semantics.
3. **Phase 2 — Parser + evaluator: explicit params.** Drop `using` /
   `given` keywords. Replace `forall(...(E))` + `using(...(E))` with
   `forall(E : Effects)` + `e : E`. Migrate prelude + stdlib + tests.
   This is the big-bang.
4. **Phase 3 — Codegen install-site detection on data-flow tags.**
   Replace `given`-keyword detection with data-flow. Verify
   `tests/algebraic_effects.test.yo` still passes.
5. **Phase 4 — yo-self port catches up.** Mirror all the above changes
   in `yo-self/`.

Each phase can be its own PR; Phases 0–1 don't break anything, Phase 2
is the migration breaker. Phases 3+ can land incrementally as gen-output
audits succeed.

## 8. Implementation Details — What Gets Removed

This section documents the specific compiler artifacts associated with
`given` / `using` / implicit resolution that must be removed or reworked.

### 8.1 AST changes (`src/expr.ts`)

- Drop `BuiltinKeywords.given` and `BuiltinKeywords.using` tokens.
- `ControlFlowFlags.escape` → `ControlFlowFlags.unwind`.
- `controlFlowOf("escape")` → `controlFlowOf("unwind")`.
- Drop `...(E)` spread syntax nodes from the AST.

### 8.2 Evaluator changes (`src/evaluator/`)

| Artifact                           | File                                                 | Action                                                                                                                        |
| ---------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `isImplicit` variable flag         | `initialization-assignment.ts:432`, `binding.ts:224` | Remove. Variables are just variables.                                                                                         |
| `isCompileTimeOnly` forced `true`  | `initialization-assignment.ts:170`                   | Remove. Handlers are runtime fn ptrs.                                                                                         |
| `isReassignable` forced `false`    | `initialization-assignment.ts:431`                   | Remove. Handler params are non-reassignable by default (param semantics); local `:=` bindings should be reassignable.         |
| `isInsideGivenHandler` context     | `context.ts:249-254`                                 | Remove. `unwind` is valid in any function body. Handler detection is auto via `evaluatedBodyContainsEscape`.                  |
| `isEffectRecordMember` flag set    | `initialization-assignment.ts:305`                   | Keep the flag but set it via body analysis (already done in `anonymous-function.ts:1084-1089`).                               |
| `throwExprIsImplicitVariableError` | `utils.ts:53-82`                                     | Remove entirely. No implicit variables to guard against.                                                                      |
| `stripImplicitVariablesFromEnv`    | `env.ts:2152-2158`                                   | Remove. Closures capture handlers like regular variables.                                                                     |
| `using` param resolution           | `implicit-resolution*`, `using-param*`               | Remove all implicit lookup logic.                                                                                             |
| `using(undefined)` handling        | Various                                              | Remove. No fallback mechanism.                                                                                                |
| `given` ambiguity / missing errors | Various                                              | Remove. No implicit resolution = no ambiguity.                                                                                |
| `...(E)` spread evaluation         | Evaluator files handling `forall` + `using` spread   | Replace with `E : Effects` generic constraint evaluation. `...(E)` becomes a regular forall type variable bound to `Effects`. |

### 8.3 Codegen changes (`src/codegen/`)

| Artifact                               | Action                                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `generateGiven` / given emit paths     | Remove. Handlers are regular variable declarations, emit like `:=`.                                                               |
| `generateEscape` → `generateUnwind`    | Rename. Body unchanged (still sets flag + propagates).                                                                            |
| `__yo_effect_escape_value`             | Rename to `__yo_unwind_value`.                                                                                                    |
| `emitEffectEscapeCheck`                | Rename to `emitEffectUnwindCheck`. Keep logic.                                                                                    |
| `using`-param evidence emission        | Remove. Evidence params are already emitted as fn-ptr params via regular parameter codegen.                                       |
| `...(E)` spread in codegen param lists | Replace with record flattening: when a param is typed `E : Effects`, flatten its struct fields into separate C fn-ptr parameters. |

### 8.4 `isControlFunction` detection flow (unchanged)

The existing auto-detection already works without `given`:

```
evaluatedBodyContainsEscape() [expr-traversal.ts]
  → sets isControlFunction [anonymous-function.ts:1084-1089, function-type.ts:441-444]
    → effect analysis detects suspension points [effect-analysis.ts:49-50]
      → codegen emits escape checks after calls [other-fn-call.ts:764-771]
```

The `isInsideGivenHandler` gate in `escape.ts:30-35` is the only piece that
ties `escape` to `given`. After removing it, `unwind` works in any function
body, and `isControlFunction` handles the rest.

## 9. Open Questions / Risks

1. **Effect struct field access.** Should struct-record effects always use
   field access (`e.throw(msg)`) or is a bare function invocation
   (`e(msg)`) allowed for single-field structs? Bare invocation is
   convenient but introduces ambiguity (is `e` the evidence record or
   the function?). Recommend: always field access for clarity.

2. **Async closures + effect records.** `io.async(action : Impl(Fn(e : E) -> T))`
   — the closure now takes `e` as an explicit parameter. The closure
   capture mechanism currently special-cases implicit params (see
   `EFFECT_INJECTION_VIA_SPECIALIZED_RESUME.md`). With explicit `e`, the
   capture treatment simplifies: `e` is a regular param.

3. **`io.await` and IO as an effect.** `io.await(fut)` today may
   implicitly take `using(io : IO)`. After migration, IO becomes an
   explicit parameter. Decide whether `IO` stays a special module-injected
   value or becomes part of effect records like any other effect.

4. **Performance.** Passing a struct of 3 fn-ptrs vs. 3 separate fn-ptr
   params: identical after monomorphisation (the compiler flattens).
   Verify codegen still flattens record-typed evidence params into
   separate C parameters.

5. **Single-effect ergonomics.** `safe_divide(1, 0, Raise(raise : my_raise))`
   is verbose for the common single-effect case. With anonymous struct
   shorthand already supported (`{ raise }` ≡ `{ raise : raise }`), this
   becomes `safe_divide(1, 0, { raise })`. For single-field structs:
   should constructor-field inference apply — i.e. `Raise(my_raise)` to
   construct `Raise(raise : my_raise)` without naming the field?

6. **Default evidence values.** A function with an effect parameter may
   want a default handler: `safe_divide(x, y, raise : Raise ?= panic_raise)`.
   Confirm default parameter values compose correctly with effect records
   and evidence-passing codegen.

7. **`unwind` gate.** Currently `escape` requires `isInsideGivenHandler`.
   After removal, `unwind` is valid in any function body. The only
   semantic constraint should be: `unwind(expr)` where `expr`'s type does
   not match the enclosing function's return type → compile error. This
   check already exists in `escape.ts:47-60`.

8. **`Effects` as first-class constraint.** `E : Effects` is a new built-in
   constraint analogous to `T : Type` / `T : Trait`. It signals to the
   evaluator and codegen that `E` is an effect record whose fields should
   be flattened into fn-ptr C parameters. The constraint is compiler-intrinsic —
   users cannot define their own `Effects`-like constraints.

## 10. Test Plan

- **Phase 0 (rename):** all existing tests must pass unchanged after the
  keyword swap.
- **Phase 1 (struct-wrap):** `tests/algebraic_effects.test.yo` plus
  prelude-using tests stay green.
- **Phase 2 (explicit syntax):** translate `tests/algebraic_effects.test.yo`
  to the new syntax. The 57 cases there are the spec. All must pass.
- **Async + effects:** `tests/async_await.test.yo` (9 cases). Must pass
  with the explicit-effect closure shape.
- **yo-self regression:** `./yo-cli test ./yo-self/tests/` self-tests must
  stay at the same pass count after the yo-self mirror migration.

## 11. Open work backlog (cross-references)

- `plans/EFFECT_INJECTION_VIA_SPECIALIZED_RESUME.md` — implementation
  detail for async closure effect injection; simplifies under explicit
  effects (closure capture of `e` is just a regular param capture).
- `issues/yo-self-evaluator-gaps.md` §A (HKT) — independent; unaffected.
- `issues/yo-self-evaluator-gaps.md` §C (per-module sub-evaluation) —
  independent; unaffected.
