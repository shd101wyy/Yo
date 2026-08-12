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
(`usize` vs `unit`).

### Measured facts (2026-08-13) — and TWO refuted causes

Bisected by editing `std/collections/array_list.yo` self-revertingly and
recompiling a 4-line importer (~25 s per iteration, no compiler rebuild — `std`
is read fresh by any stage-1 binary):

| variant of `slice_copy`'s first statement    | swallowed error                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| original `cond((r.end > self.len()) => ...)` | Cannot unify: `usize` and `unit`                                                      |
| `e := self.len();`                           | Cannot unify: `usize` and `unit` (so `e` is unit ⇒ `self.len()` is unit)              |
| `e := r.end;`                                | Expected enum type … for match expression, got `unit` (the `match(self.get(i), ...)`) |

So **both** sibling calls are unit: `len` (declared at :29, BEFORE `slice_copy`
at :74) and `get` (declared at :211, AFTER it). Removing one statement simply
exposes the next failure in the same body.

**Refuted cause 1 — "methods are not registered until the module literal
finishes".** A plain `impl(M, len : ..., via_instance : ...)` where `via_instance`
calls `self.len()` inside a `cond` RESOLVES cleanly at definition time (rc=0, 0
markers, no swallow).

**Refuted cause 2 — "it needs a generic impl whose `Self` carries an unresolved
type argument".** The same probe rebuilt as
`G :: (fn(comptime(T) : Type) -> comptime(Type))(ref(struct(v : T, n : usize)))`
with `impl(generic(T : Type), G(T), size : ..., via : ...)` — mirroring
ArrayList's exact declaration shape, sibling declared first — ALSO resolves
cleanly.

### THIRD FACTOR FOUND: `Self.<method>()` static dispatch (2026-08-13)

Minimal reproducer: **`issues/repros/self-static-method-at-def-time.yo`** (15
lines of substance) — reproduces the exact `usize`/`unit` error.

The trigger is `out := Self.new();` — STATIC dispatch on `Self` inside a method
body at definition time. Narrowed by probe series:

| probe                                                              | result         |
| ------------------------------------------------------------------ | -------------- |
| `?*(T)` field + `pragma(AllowUnsafe)`                              | clean          |
| ... + a `Range(usize)` parameter                                   | clean          |
| ... + `new : (fn() -> Self)(...)` declared AND `Self.new()` called | **REPRODUCES** |
| ... + `new` declared but NOT called                                | clean          |

Instance dispatch (`self.len()`) works throughout, before or after its
declaration. So it is specifically STATIC-on-`Self` that fails.

**The root is DELIBERATE.** `evaluator/values/impl.yo:3110-3114` makes only
TYPE-valued fields visible to later fields' `Self.X`:

> Only TYPE-valued fields (associated types like `Output : u8`) — `Self.X` never
> resolves to a method value, and copying FuncVals into the context list proved
> fragile.

So a sibling METHOD is unreachable through `Self` during the impl's own
evaluation; `Self.new()` yields `unit` and the trial swallows the body. The
`g_method_values` path at `:2578-2585` has the same TYPE-only restriction.

This IS the documented "Self-slot" class after all (`(result : Self) = Self.new()`
types UNIT) — an earlier note in this file said it was not; that was wrong.

### Attempt 2026-08-13 — implemented in TWO places, neither fires (reverted)

Both halves type-checked at 247/247 and BOTH were built and measured; the repro
still swallows and the root count stays at 16, so neither path is the one
`Self.new()` actually takes.

1. **`property_access.yo`'s `Self.X` fallback** extended to resolve a
   FUNCTION-typed entry to its FuncVal (ExprInfo type = the Func type, value =
   the FuncVal), with `impl.yo` publishing sibling methods into the in-flight
   context lists — the method VALUE in a NEW parallel list
   (`current_impl_trait_field_values`) rather than in
   `current_impl_trait_field_types`, since conflating methods with associated
   types is the likely reason the older attempt "proved fragile". No effect:
   `Self.new()` is a CALL, so it does not come through property access.
2. **`calls/function.yo`'s static-dispatch path**, where `hits.len() == 0`
   returns `None` and the call degenerates to `unit`: added an in-flight-impl
   fallback that scans the same context lists and synthesizes a `MethodEntry`
   hit, scoped to `is_static` and FuncVal-valued entries. Also no effect.

So the call is resolved somewhere neither of those covers, OR the context lists
are empty at that moment (the push happens per-field as the impl is evaluated,
and `new` precedes `via` in the repro, so they SHOULD be populated — unverified).

### INSTRUMENTED 2026-08-13 — where it actually breaks

Two probes (`PROBE-SELFX` at the `Self.X` fallback, `PROBE-PUSH` at each impl
field push), built and run against the reproducer:

1. **The `Self.X` fallback IS reached** for `prop=new` — so it is not shadowed by
   an earlier branch, as suspected.
2. **But it sees `n_labels=0`**: the in-flight context lists are EMPTY at the
   moment `Self.new` resolves. That is why both earlier fix locations were inert.
3. **The push fires on two different paths.** With only the generic-impl branch
   (`g_mval`, impl.yo ~:2578) patched, pushes appear for `clone`, `dispose`,
   `hash`, `index`, `next`, `trace` — all TRAIT-impl methods, never the
   reproducer's `len`/`new`/`via`. An INHERENT impl
   (`impl(generic(T), G(T), len, new, via)`) goes through the "Case 3" site
   (~:3110) instead; patching that too fires 885 pushes.
4. **Even with both pushing, `Self.new` still sees `n_labels=0`.** So the lists
   do not survive from the push into whatever context evaluates the body.

Also established:

- Pushing methods into `current_impl_trait_field_types` WITHOUT the matching
  consumer branch breaks 87 files, while the two together are 247/247. That is a
  concrete explanation of the original "copying FuncVals into the context list
  proved fragile" note: the earlier attempt most likely landed the push without a
  consumer.
- The impl RESTORES the saved lists when it finishes (impl.yo:2607 and :3431),
  and `PendingDefEval` carries none of them — but the deferred-re-run path is
  gated on `has_fwd_comptime_fn_cap`, which is narrow, so "the trial re-runs
  after the restore" is NOT the explanation either (checked, not assumed).

**The one remaining question, and the exact next probe:** add `n_labels` to the
existing `[trial]` print in `_trial_eval_fn_body`. If the trial itself already
runs with empty lists, the body eval happens outside the impl's field loop and
the lists must be carried to it; if the trial has them populated, the loss is
inside the body evaluation's context threading (`function_type.yo`'s
`create_function_body_evaluation_context` copy).

That single bit decides which half to fix, and costs one build.

**Next step must be instrumentation, not a third guess**: print at
`_try_find_receiver_method` entry whether `is_static` is true for `Self.new()`
and what `ctx.current_impl_trait_field_labels` contains at that moment. Two build
cycles were spent on plausible-looking locations that never executed; a single
`[trial]`-style probe would have named the right one first.

**Fixing it means making FuncVal fields resolvable for `Self.X` at def time —
exactly what a previous session tried and abandoned as fragile.** TS has no such
limitation (its def-time body eval is fatal and it compiles `array_list` fine),
so it is a real porting gap rather than a design choice to keep. Any attempt
needs the full battery plus the stage-2 marker count, since the abandoned attempt
was abandoned for fragility, not for being wrong.

(Superseded note: a third factor WAS unidentified when this section was first
written.)

**Superseded — the following was the state before the probe series.**

**So a third factor distinguishes the real `array_list` impl from a minimal
generic impl with the same shape, and it is not yet identified.** Candidates not
yet tested: the `?*(T)` optional-pointer field, `pragma(Pragma.AllowUnsafe)`, the
number of methods in the impl (ArrayList has dozens; the probes had two), or
interaction with a method that itself failed its trial earlier in the same impl
(note `[trial] :57:4` runs immediately before `[trial] :73:59`).

Related but NOT the same as the documented "Self-slot" class
(`(result : Self) = Self.new()` types UNIT —
`issues/retired/yo-self-hollow-test-batch-main.md`); that one is about `Self.X`
static access, this one is instance dispatch.

Next probe: extend the minimal generic-impl repro one property at a time toward
the real ArrayList (optional-pointer field → many methods → a preceding failing
trial) until it reproduces; that names the third factor without guessing.

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

**Site LOCATED — `evaluator/values/impl.yo:2331-2349`.** Every impl binder is
bound as a type, unconditionally:

```rust
some_ty := t_some_t(param_name_str.clone(), frame_lvl);
tv := create_type_value(some_ty);
add_variable_to_env(forall_env, param_name_str, t_type(), .Some(tv), ...)
```

The annotation's right-hand side is parsed for the NAME and then discarded, so
`N : usize` becomes a `TypeVal` exactly like `T : Type`.

Also ruled out along the way: `evaluator/types/function.yo:1774` IS kind-guarded
(`is_type_0` → TypeVal, else `create_unknown_val`) and is the fn-parameter path;
`:2283` is unguarded but sits in `parse_where_clause_constraints`, whose subject
is always a type, so unconditional is correct there.

### The obvious fix is REFUTED — measured twice (2026-08-13)

Binding a value binder to `create_unknown_val(<declared type>)` instead — the
fn-level fix's exact shape — **breaks 87 of 247 files**, all with
`Cannot destructure from a module that is still being evaluated (circular
import)`.

Two attempts, isolating the cause:

1. Reading the annotation with `evaluate_expression_raw` → 86 circular-import
   failures. Plausible cause: impls are evaluated WHILE the prelude module is
   still evaluating, so evaluating anything there re-enters module evaluation.
2. Reading it with a PURE `find_variable_in_env` lookup instead — no evaluation
   at all → **the same 86 failures**. So the annotation lookup was never the
   problem: it is the BINDING itself.

Conclusion: the `TypeVal(SomeT)` binding is **load-bearing for evaluating the
impl's receiver pattern** (`Array(T, N)`), which runs in this same `forall_env`.
A value binder cannot simply be re-kinded there.

### FOUR measured attempts, all reverted — read before trying a fifth

`check ./yo-self` (~3 min, no build needed) was the gate for each. Baseline 247/247.

| #   | attempt                                                                                                                | result      |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ----------- |
| 1   | re-kind the impl env binding; read the annotation with `evaluate_expression_raw`                                       | **160/247** |
| 2   | same, but read it with a PURE `find_variable_in_env` (no evaluation)                                                   | **160/247** |
| 3   | leave the env binding alone; register the kind, resolving the annotation via `get_variables_from_env` during impl eval | **160/247** |
| 4   | register the kind NAME only (purely syntactic, zero resolution), resolve it later in `_build_def_time_body_env`        | **238/247** |

Isolated sub-results, each measured separately:

- The `creators.yo` side table alone: **247/247** — harmless.
- Adding `register_some_binder_kind` to `impl.yo`'s existing `creators.yo`
  destructure, with NO code using it: **247/247** — so the added import is not
  the problem either.
- Attempt 3's code block, differing from attempt 4 only by resolving the
  annotation at impl-eval time: 160/247. **So a lookup during impl evaluation is
  itself unsafe** — `get_variables_from_env` can trigger lazy module resolution.
- Attempt 4 fails only 9 files, and they are the import-cycle-heavy ones:
  `main.yo`, `evaluator/index.yo`, `build_runner.yo`, `doc_command.yo`,
  `fetch_command.yo`, `macro_expand.yo`, `closure_type.yo`, `recur.yo`,
  `anonymous_function.yo`.

Every failure mode is the same error: **"Cannot destructure from a module that is
still being evaluated (circular import). The requested fields are not yet
available."**

### What that actually says about the codebase

yo-self's circular-import handling is **order-sensitive**: a module mid-cycle can
only be destructured for fields already evaluated. So ANY change that perturbs
evaluation order in this path — even re-kinding one variable in a body env —
re-orders enough to break a partially-evaluated destructure. That is why this
whole family resists otherwise-correct fixes, and it is the real blocker, not the
kind correction itself.

A fifth attempt should therefore NOT try another place to re-kind. It should
either

- make the binder kind available WITHOUT touching evaluation order at all (e.g.
  carried on the FuncVal at method-registration time, read only by the body-env
  builder), or
- fix the order-sensitivity first, so the module system tolerates a
  destructure of a not-yet-evaluated field (that is the deeper bug, and it would
  also de-risk every other def-eval fix).

`t_some_t_with_kind` was considered and rejected as the carrier: its field is
documented as the HKT kind and "must be a `Func` TypeValue", so putting `usize`
there would make a length binder look like a higher-kinded variable to the
TypeApplication paths.

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
