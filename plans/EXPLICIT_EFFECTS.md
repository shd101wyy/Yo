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
  one-shot delimited continuations via `return` / `escape` (renamed —
  see §5).
- **Not** breaking-change safe. This plan accepts full prelude + tests +
  yo-self churn. Migration is one big mechanical pass.

## 1. Surface Syntax — Before/After

| Concept                      | Today                                                                             | Proposed                                                               |
| ---------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Declare effect               | `Raise :: (fn(msg : str) -> i32);`                                                | (unchanged)                                                            |
| Fn param taking effect       | `safe_divide :: (fn(x : i32, y : i32, using(raise : Raise)) -> i32)`              | `safe_divide :: (fn(x : i32, y : i32, raise : Raise) -> i32)`          |
| Call site                    | `safe_divide(1, 0)` (implicit lookup) **or** `safe_divide(1, 0, using(my_raise))` | `safe_divide(1, 0, my_raise)`                                          |
| Install handler              | `given(raise) := (msg) -> { escape(42); };`                                       | `raise := (msg) -> { unwind(42); };`                                   |
| Propagating function         | `wrapper :: (fn(x, using(raise : Raise)) -> i32)(safe_divide(x, 0))`              | `wrapper :: (fn(x, raise : Raise) -> i32)(safe_divide(x, 0, raise))`   |
| Effect record (struct-based) | `using(exn : Exception)` then `exn.throw(...)`                                    | `exn : Exception` then `exn.throw(...)`                                |
| Continuation control         | `return(value)` resumes, `escape(value)` unwinds                                  | `return(value)` resumes, `unwind(value)` unwinds (renamed for clarity) |
| Skip + fallback to given     | `safe_divide(1, 0, using(undefined))`                                             | n/a — `given` is gone, no fallback to resolve                          |

Removed keywords: `using`, `given`. Renamed: `escape` → `unwind`.

## 2. Effect Row Polymorphism — Records, Not Rows

Today's `forall(...(E))` and `using(...(E))` model effect rows as a
**typing-time abstraction** spread across an open list of implicit params.
The explicit replacement is to make a row a **first-class value**: a
record (struct) of evidence values.

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

e := Effects(raise : my_raise, log : my_log);
result := run(might_fail, e);
```

### Specifics

- `Effects` is a **trait** (or a built-in `record(...)` shape) signalling
  "this type is a heterogeneous record of evidence values."
- Combining rows (today's `using(...(E1), ...(E2))`) becomes record
  extension: `Effects(...e1, ...e2)` spread-builds a wider record.
- Field access (`e.raise(msg)`) is regular struct access. The evaluator
  / codegen for struct effect records (today's `Exception` pattern) is
  the only shape needed; bare fn-typed effect params disappear (see §3).
- Monomorphisation is unchanged: at each `run` call with a concrete `E`
  the compiler generates a specialized version with `E`'s fields as
  separate fn-ptr C parameters. Codegen does what it does today.

### Sugar (deferred, optional)

- Auto-derived `Effects(raise, log)` infers the record type from the
  names in scope, equivalent to `Effects(raise : raise, log : log)`.
- `effects { raise, log }` literal as an even shorter form.

These are nice-to-haves to add **after** the core migration lands.

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

Today `given` marks the install site (the stack frame where `escape`
unwinds to). Without `given`, the install site is recovered by data flow:

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

## 5. Rename `escape` → `unwind`

`escape` is misleading — it sounds like "leave this handler" but actually
unwinds to the function that installed the handler. Rename to `unwind`
(or `abort_to` if a longer name is preferred). `return(value)` keeps its
meaning: resume the captured continuation with `value`.

This rename is independent of the rest of the plan and can land first or
last; recommended to bundle with this change since the migration is
already touching every effect site.

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

## 7. Migration Scope

Files touched:

| Area                                                 | Approximate change                                                                                                                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Lexer / parser** (`src/lexer.ts`, `src/parser.ts`) | Drop `using` and `given` keyword tokens; drop the `...(E)` spread parsing. Keep `forall(...)`.                                                                                                         |
| **Evaluator** (`src/evaluator/`)                     | Remove `using` / `given` handling. Replace `...(E)` row-spread evaluation with `forall(E : Effects)` (named record-bound forall). Add data-flow tagging for install-site detection.                    |
| **Codegen** (`src/codegen/`)                         | Drop `using`-param emission paths. Existing fn-ptr param emission stays. Install-site frame setup reads new data-flow tag.                                                                             |
| **Prelude** (`std/prelude.yo`)                       | Rewrite ~30–50 fn signatures: convert `using(exn : Exception)` → `exn : Exception`. Update internal call sites accordingly. Wrap any remaining bare-fn effects (e.g. `Raise`) in single-field structs. |
| **Stdlib** (`std/**/*.yo`)                           | Same pattern as prelude. `std/error.yo`, `std/io/*`, `std/collections/*` are likely the largest.                                                                                                       |
| **Test suite** (`tests/**/*.test.yo`)                | `tests/algebraic_effects.test.yo` (57 cases) gets the largest churn. Other tests touch `Exception` calls that need explicit `exn` arg threading.                                                       |
| **yo-self port** (`yo-self/**/*.yo`)                 | Mirror the TS-side changes one-to-one. Evaluator + codegen + prelude.                                                                                                                                  |
| **Docs** (`docs/en-US/`, `docs/zh-CN/`)              | Rewrite `ALGEBRAIC_EFFECTS.md` to describe the explicit model. Update `ASYNC_AWAIT.md` cross-references.                                                                                               |

### Suggested phasing

1. **Phase 0 — Renaming pass.** `escape` → `unwind` everywhere. Mechanical;
   no semantics change. Land independently to keep the rest of the diff
   focused.
2. **Phase 1 — Wrap bare fn-typed effects in structs.** Prelude + tests.
   Still uses `using` / `given`. Tests stay green after this. Reduces the
   "two shapes" → "one shape" before changing semantics.
3. **Phase 2 — Parser + evaluator: explicit params.** Drop `using` /
   `given` keywords. Replace effect-row spread with record-typed
   `forall(E : Effects)`. Migrate prelude + stdlib + tests. This is the
   big-bang.
4. **Phase 3 — Codegen install-site detection on data-flow tags.**
   Replace `given`-keyword detection with data-flow. Verify
   `tests/algebraic_effects.test.yo` still passes.
5. **Phase 4 — yo-self port catches up.** Mirror all the above changes
   in `yo-self/`.
6. **Phase 5 — Optional sugar.** Auto-derived `Effects(raise, log)`
   shorthand. Can land any time after Phase 2.

Each phase can be its own PR; Phases 0–1 don't break anything, Phase 2
is the migration breaker. Phases 3+ can land incrementally as gen-output
audits succeed.

## 8. Open Questions / Risks

1. **Effect record polymorphism over arbitrary fields.** Yo's current
   trait system supports row-extension for trait `Effects`? Or do we
   need named records with width subtyping? Check whether the existing
   `record(...)` shape (used by struct-record effects today) already
   handles "any struct that contains a `throw : (fn(...)…)` field" as a
   subtype.
2. **Async closures + effect records.** `io.async(action : Impl(Fn(e : E) -> T))`
   — the closure now takes `e` as an explicit parameter. The closure
   capture mechanism currently special-cases implicit params (see
   `EFFECT_INJECTION_VIA_SPECIALIZED_RESUME.md`). With explicit `e`, the
   capture treatment simplifies: `e` is a regular param.
3. **`io.await(fut, using(io, log))`** at the call site becomes
   `io.await(fut, io_log_record)`. Decide whether `IO` itself stays a
   special module-injected value or becomes part of the `Effects`
   record at every call site.
4. **Performance.** Passing a record of 3 fn-ptrs vs. 3 separate fn-ptr
   params: identical after monomorphisation (the compiler can flatten).
   Verify codegen still flattens record-typed evidence params into
   separate C parameters.
5. **Single-effect ergonomics.** `safe_divide(1, 0, Raise(raise : my_raise))`
   is verbose for the common single-effect case. Decide whether sugar
   like `safe_divide(1, 0, my_raise)` (positional) and/or
   `safe_divide(1, 0, raise = my_raise)` (named) is allowed for
   single-field effect records as a value shorthand.
6. **Default evidence values.** Some current `given` patterns provide
   "default handler if no other given is found." The explicit replacement
   is a default parameter value: `(r : Raise ?= default_raise)`. Confirm
   this composes correctly with effect records.
7. **The `escape`/`unwind` value type.** Today's escape value uses a
   thread-local `__yo_escape_value` buffer (64 bytes). With explicit
   effects, nothing about this changes.

## 9. Test Plan

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

## 10. Open work backlog (cross-references)

- `plans/EFFECT_INJECTION_VIA_SPECIALIZED_RESUME.md` — implementation
  detail for async closure effect injection; simplifies under explicit
  effects (closure capture of `e` is just a regular param capture).
- `issues/yo-self-evaluator-gaps.md` §A (HKT) — independent; unaffected.
- `issues/yo-self-evaluator-gaps.md` §C (per-module sub-evaluation) —
  independent; unaffected.
