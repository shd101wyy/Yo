# The def-eval swallow: remaining roots, measured and attributed

**Live inventory.** `_trial_eval_fn_body`
(`yo-self/evaluator/calls/function_type.yo`) wraps definition-time body
evaluation in a capture-free handler that unwinds `()` on ANY error, and the
FuncVal registers anyway. TS's counterpart (`function-type.ts:499`) is FATAL, so
**every swallowed error is a place where yo-self's definition-time environment is
thinner than TS's** — and a body whose statements lose their ExprInfo is exactly
what codegen turns into a `// Failed to transpile` comment.

Making the handler fatal is the endgame. It can only happen AFTER these roots are
gone: an attempt at the fatal version (2026-08-12) broke 10 corpus files, because
the swallow is currently load-bearing.

## How to reproduce this inventory

```bash
# Any stage-1 binary from this tree; the hook is in-tree, not scaffolding.
YO_DEBUG_SWALLOW=1 <bin> compile <file.yo> --emit-c --skip-c-compiler -o /tmp/x 2>&1 \
  | awk '/\[trial\]/{t=$2} /\[swallow\]/{sub(/.*\[swallow\] /,""); print t"\t"$0}' \
  | sort | uniq -c | sort -rn
```

`[trial] <module>:<row>:<col>` is printed before each definition-time trial;
every `[swallow]` belongs to the `[trial]` above it. The marker exists because
the handler is a capture-free `->` and **cannot** capture `body`, so the owner
cannot be printed from inside it — and many swallowed errors carry a token
pointing at line 1, which makes the message alone unattributable.

Use a MINIMAL input (prelude + `std/fmt` only). A program importing `yo-self/`
adds its own roots and drowns the baseline.

## Progress

| stage                         | distinct roots | `Variable "X" not found` |
| ----------------------------- | -------------- | ------------------------ |
| baseline (2026-08-13)         | 33             | 17                       |
| + generic TYPE binders bound  | 17             | 1                        |
| + generic VALUE binders bound | 16             | 0                        |

Both landed with the full battery: FIXPOINT_HOLDS, sweep 188 GREEN,
`tests/internal` 868 passed / 0 markers, `check ./std` 154/154,
`check ./yo-self` 247/247.

## The remaining 16, attributed to the function being trialled

| #   | owner (fn whose body was trialled)                         | swallowed error                                            |
| --- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | `array_list.yo:73:59` `slice_copy`                         | Cannot unify incompatible types: `usize` and `unit`        |
| 2   | `array_list.yo:89:78` `slice_copy_inclusive`               | Cannot unify: `usize` and `unit`                           |
| 3   | `array_list.yo:797:45`                                     | Cannot unify: `usize` and `unit`                           |
| 4   | `array_list.yo:881:74` `slice_copy` (Array impl)           | Cannot unify: `usize` and `Type`                           |
| 5   | `array_list.yo:890:93` `slice_copy_inclusive` (Array impl) | Cannot unify: `usize` and `Type`                           |
| 6   | `prelude.yo:7608:6`                                        | Cannot unify: `usize` and `Type`                           |
| 7   | `array_list.yo:116:4`                                      | Incompatible type with expected type                       |
| 8   | `array_list.yo:537:68`                                     | Incompatible type with expected type                       |
| 9   | `array_list.yo:616:6`                                      | Incompatible type with expected type                       |
| 10  | `array_list.yo:383:4`                                      | Type mismatch for type member "value"                      |
| 11  | `prelude.yo:7837:49`                                       | Type mismatch for type member "value"                      |
| 12  | `prelude.yo:7942:6`                                        | Type mismatch for type member "value"                      |
| 13  | `prelude.yo:7973:6`                                        | Type mismatch for type member "value"                      |
| 14  | `prelude.yo:578:8`                                         | evaluate_comptime_fn_call: function_value is not a FuncVal |
| 15  | `prelude.yo:599:4`                                         | evaluate_comptime_fn_call: function_value is not a FuncVal |
| 16  | `array_list.yo:188:4`                                      | Failed to evaluate, got `(last_element_ptr.(*))`           |
| 17  | `array_list.yo:211:4`                                      | Failed to evaluate argument expression                     |
| 18  | `prelude.yo:5611:51`                                       | `__yo_array_fill` expects a compile-time known second arg  |
| 19  | `prelude.yo:5801:4`                                        | Expected ComptimeList value for `__yo_comptime_list_car`   |

(19 swallows across 16 distinct `(location, message)` roots.)

## Two families identified, with evidence

### A. Sibling-method calls evaluate to `unit` (#1, #2, #3 — the "Self-slot" class)

```rust
slice_copy : (fn(self : Self, r : Range(usize)) -> Self)({
  e := cond((r.end > self.len()) => self.len(), true => r.end);
```

`self.len()` yields `unit` at definition time, so the `cond` arms cannot unify
(`usize` vs `unit`). **NOT a declaration-order problem** — measured: `len` is at
`array_list.yo:29`, well before `slice_copy` at :74. A struct-module's methods
are not registered until the whole module literal finishes evaluating, so ANY
sibling call is unresolvable during a def-time trial regardless of order.

This is the documented "Self-slot" class (`(result : Self) = Self.new()` types
UNIT — `issues/retired/yo-self-hollow-test-batch-main.md`). Fixing it means
registering a module's methods before evaluating their bodies — a two-pass
change with broad blast radius, so it wants its own gated slice.

### B. Impl-level VALUE binder bound as a TYPE (#4, #5, #6)

```rust
impl(
  generic(T : Type, N : usize),
  Array(T, N),
  slice_copy : (fn(self : Array(T, N), r : Range(usize)) -> ArrayList(T))({
    e := cond((r.end > N) => N, true => r.end);
```

`usize` vs **`Type`** means `N` is bound as a TYPE. Same kind-correctness bug the
fn-level fix just cured, one level up: these are IMPL-level binders, a different
list from the fn's `forall_labels`, so the new binding does not reach them.

Ruled out so far: `evaluator/types/function.yo:1774` IS kind-guarded
(`is_type_0` → TypeVal, else `create_unknown_val`) and is the fn-parameter path;
`:2283` is unguarded but sits in `parse_where_clause_constraints`, whose subject
is always a type, so unconditional is correct there. The impl-level binder
declaration site is still unlocated — the next probe is a `[trial]`-style print
at each `t_some_t` mint site, filtered to `N`.

## Method notes

- **Never guess a root; measure it.** Three hypotheses were refuted by
  measurement this session (a missing specialization, the
  `other_fn_call.yo:1805` producer, `Self`-typed params) — and one prediction
  that binding `N` would also clear family B above was wrong.
- **Kind matters in both directions.** A value binder bound to a `TypeVal` is
  the `usize`-vs-`Type` misbind of
  `issues/yo-self-collections-batch-residuals.md`; a type binder bound to
  `create_unknown_val(Type)` throws "expected type for element" because
  yo-self's TypeValues are snapshots and a placeholder must BE a type.
- **Every root gets the full battery.** This area's history
  (`issues/retired/yo-self-hollow-test-batch-main.md`) is a catalogue of fixes
  that cleared a repro and regressed another gate — including one that passed
  every gate while adding 13 hollow markers to the self-compile.
- Re-test the fatal `_trial_eval_fn_body` after each root falls; it is the
  definitive check that the swallow has stopped being load-bearing.
