# yo-self P1 — `recur(...)` markers are a CODEGEN macro-expansion gap (NOT eval/try_to_call)

Status: **✅ FIXED (commit 4529a1b94): full self-compile 416 → 141 (−275, ~66% of the tail),
EXIT=0, check ./std 152/152, A/B corpus 83/83 CHANGED=0.** The largest single P1 drop of the
effort. 7 recur markers remain (recur OUTSIDE the if-macro path) — small residual, below.

## The fix (durable macro-expansion side-table)

Root: `if(c,t,e)` is a macro → `cond(c=>t,true=>e)`; yo-self codegen lowers a macro call ONLY
via `ei.macro_expansion`. That per-pass ExprInfo lives in a SIDE-TABLE (vs TS's node-stored
`expr.$`), so a later eval pass re-sets the same call id WITHOUT macro_expansion, dropping it.
recur was the discriminator (its eval perturbs which pass last writes the entry); normal ifs
survived. Confirmed via id correlation: the SAME id (e.g. 34745) was macro-set once, then read
at codegen with `macro_expansion=None` (`[FALLTHROUGH]`).

Fix (4 files): a durable id-keyed `g_macro_expansions` side-table (expr_info.yo,
record_macro_expansion / lookup_macro_expansion) written once by the macro path
(function.yo). BOTH codegen dispatch (generation.yo:414) AND type-collection (collection.yo:477)
fall back to it when the per-pass `ei.macro_expansion` is None. **Collection needed the SAME
fallback** — v1 (codegen-only) drained the recur markers but SIGABRT'd: codegen emitted the
newly-unmasked closure code while the capture struct was never collected
(`get_type_string: no C type name found for <struct:capture_…>`). The collection fallback
collects the expansion's types, keeping the two passes consistent. A macro call's expansion is a
stable syntactic property of its id, so the durable record is always correct (faithful
equivalent of TS's node-stored ExprInfo; same pattern as g_method_callee_values).

**Residual (7 markers):** recur used OUTSIDE the if-macro path (e.g. directly in some
construct that doesn't route through the macro_expansion side-table). Separate sub-case;
re-measure the [TTERR]/per-C-fn clustering on the 141 base to characterize.

## Original diagnosis (how it was pinned)

A large slice of the (then-416) tail was `if(...recur...)` markers (every recur use in
yo-self's recursive type/value walkers — `_value_contains_unknown`, the `is_function_type`
recursions, etc.).

## The headline: it is NOT an evaluator / try_to_call throw

The earlier framing (recur fails at def-time in `try_to_call_function_with_arguments`,
[[yo-self-fixpoint-tail-run-compile]] "recur-at-def-time DEAD END") is **disproven** by the
[TTERR] instrumentation (swallow-handler print in `_trial_eval_fn_body`, full self-compile):
- **0 recur-related throws.** The 39 def-time throws are all the known clusters (20
  hash_map/hash_set warm-up noise, branch-merge "Frame level", recursive-type "value", etc.).
  None mentions recur; none is located in `begin.yo` (where `_value_contains_unknown` lives).
- In the emitted C, `_value_contains_unknown`'s whole body transpiles (the match/switch,
  while, locals, Some/None) **except** the `if(recur(f), ...)` lines — confirming eval
  succeeded (all ExprInfo present) and **codegen** specifically can't emit it.

So recur is a **codegen** gap. (`try_to_call` ignoring `skip_ctfe_execution`, helper.yo:2075
vs TS helper.ts:1758, is a real latent divergence but is NOT this bug — runtime-return recur
never reaches the comptime gate.)

## Bisection (fast ~10s repro — recur was previously thought un-isolable)

KEY: the recursive fn must be **CALLED** or it's dead-code-eliminated (never codegen'd → a
false "clean"). Repro (`src/tests/fixme.yo`): `RecV :: enum(Leaf, Node(fields : ArrayList(Self)))`
+ a `contains(v : RecV) -> bool` that recurses over the field, **called from main**.

| form | result |
| --- | --- |
| `b := recur(f);` (recur as assignment RHS, no if) | **transpiles** → `bool _t = yo_id_5462(f);` (real self-call) |
| `cond(recur(f) => {found=true}, true => ())` (direct cond) | **transpiles** (0 markers) |
| `if(recur(f), {found=true})` (recur in if **condition**) | **FAILS** (1 marker) |
| `if(!(found), {b := recur(f); found = b;})` (recur in if **body**) | **FAILS** (1 marker) |

So: **recur codegen works, `cond` works — only the `if` MACRO with recur anywhere in its
args fails.** `recur` itself is also confirmed to eval fine (a `[RECUR-PROBE]` in recur.yo
showed the normal path entered 7× and completed 7×; short-circuit 3×).

## Mechanism (disambiguated, confirmed)

`if(c, t, e)` is a **macro** (prelude.yo:7598) → `cond(c => t, true => e)`. yo-self has NO `if`
codegen dispatch case; `if` transpiles ONLY via `ei.macro_expansion` (generation.yo:414, the
already-expanded cond). Tagging the two "Failed to transpile" sites distinctly
(`[NOINFO]` at generation.yo:408 = no ExprInfo; `[FALLTHROUGH]` at :555 = ExprInfo present
but no dispatch matched) showed the recur-if is **`[FALLTHROUGH]`**: it HAS ExprInfo but
**`macro_expansion` is None**.

Yet the if-macro DOES expand (recur fires during the expansion eval). So `macro_expansion` is
set during *some* eval pass but **lost** on the IF node codegen reads.

**The TS divergence (the likely root):** TS (function.ts:2041-2062) evaluates the macro
expansion **directly** (`evaluateExpression({ expr: returnValue.value })`) and stores ExprInfo
on the node (`expr.$`), so every re-eval through the macro path re-sets `macroExpansion` on the
same node. yo-self (function.yo:2888-2917) instead **`clone_expr_fresh_ids(expanded)`** (a
necessary adaptation for its **side-table** ExprInfo model — id-preserving copies alias
side-table entries) and stores in the side table. Across yo-self's multiple eval passes
(def-time validation + call specialization + …) the IF's side-table entry ends up WITHOUT
`macro_expansion` for the recur case (a non-macro pass overwrites it, or the macro-path pass's
fresh-id clone isn't the id codegen walks). A normal (non-recur) `if` survives — recur is the
discriminator, so the recur eval inside the expansion perturbs which pass sets the final entry.

## Next step (the fix — direct from here)

Instrument `function.yo:2888-2917` (the macro-unquote path) to print the IF's `ast_expr_id` +
"macro_expansion SET" each time, AND `generation.yo` to print the codegen-read IF's id +
`macro_expansion` state. Correlate: either (a) the macro path is NOT taken on the
codegen-relevant pass for the recur-if (→ ensure it is, or make recur not perturb it), or (b)
id mismatch from a body clone (→ preserve `macro_expansion` across the clone / re-expand).
Likely faithful fix: ensure the IF node codegen reads carries `macro_expansion` — e.g. when
re-evaluating a macro call whose result is already known, don't drop the prior
`macro_expansion`; or route codegen's `if` through the cond form when `macro_expansion` is
absent but the call IS a macro (mirroring that `if`≡`cond`).

Fast validation loop: edit codegen/eval → `./yo-cli compile yo-self/main.yo -o /tmp/bin
--optimize 1` (~590s) → run the ~10s `src/tests/fixme.yo` repro (recur-if) → expect the marker
gone → then full self-compile for the marker delta vs 416 + `check ./std` 152/152 + corpus 83/83.

Related: [[yo-self-fixpoint-tail-run-compile]], [[yo-self-macro-expansion-port]].
