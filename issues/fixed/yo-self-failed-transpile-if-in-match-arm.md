# yo-self stage-2: "Failed to transpile" — method call in if-inside-match-arm

## ✅ FIXED

Root cause: `find_function_calls_in_expr` (codegen/functions/collection.yo:432) recursed
ONLY into `ei.macro_expansion`, with no fallback to the durable `g_macro_expansions`
side-table — whereas codegen (generation.yo) AND `collect_types_from_expr` both fall back.
When a later eval pass (match-arm re-eval during branch type-checking) overwrote the if-call's
per-pass ExprInfo WITHOUT `macro_expansion`, function-collection walked nothing while codegen
walked the durable expansion — so the expansion's method-callee functions (e.g. `String.len`
= `yo_id_4154` for `cv.len()`) were never registered (`context.has_function` = false).
Codegen's concrete-method dispatch then found no C name (`_c_func_name` → None), fell through
to `func_expr` (the dot-access, which has no ExprInfo), and emitted "// Failed to transpile",
corrupting the C line.

**Fix (one match arm):** give `find_function_calls_in_expr` the same durable-table fallback
codegen uses: `ei.macro_expansion` else `lookup_macro_expansion(ast_expr_id(expr))`.

**Result:** reproducers v2/vB/vC/fixme → 0 markers. Stage-2 clang errors **1627 → 1312 (−315)**
(each removed marker eliminated a large brace/syntax cascade: implicit-int 172→47, K&R-param
74→20, extraneous-brace dropped out of the top-10). Corpus 97/97, self-compile exit 0.

---

## Original investigation

**Impact:** 66 "Failed to transpile" markers in the baseline stage-2 C. Each emits a
`// Failed to transpile <expr>` COMMENT mid-expression, which eats the rest of the C line
(and can eat parens/braces) → cascades into the "expected ')'", "expected expression",
implicit-int (a following call parsed as a K&R decl), K&R-param, and brace-imbalance
("extraneous closing brace") error classes. So this single root drives a large fraction
of the ~350 syntax/brace/implicit-int cascade errors AND the 15 uncollected-`fn_yo_id`.

**Root:** `generate_func_call` (codegen/exprs/generation.yo:405-412) emits "Failed to
transpile" when the FnCall expr has NO ExprInfo (`get_expr_info → .None`). The failing
sub-expression is a **method call whose receiver is bound in a match arm, used inside an
`if` that is the match-arm body**.

## Minimal reproducer (TS compiles clean; yo-self emits the marker)

Narrowed with fast small-file binary compiles (`<yo-self-bin> compile x.yo --emit-c
--skip-c-compiler`; grep `Failed to transpile` in the `.c`):

- **v1 — method call in a match arm, NO if:** `match(o,.None=>usize(0),.Some(cv)=>cv.len())` → **0** (fine)
- **v2 — method call in an `if` INSIDE a match arm:**
  `match(o,.None=>false,.Some(cv)=>if(cv.len()>usize(0),true,false))` → **1 (REPRODUCES)**
- **v3 — method call in an `if`, NO match:** `if(cv.len()>usize(0),true,false)` → **0** (fine)

So the trigger is the **combination**: if-macro-body-of-a-match-arm. Neither alone triggers.

**Narrowed further to METHOD CALLS specifically** (existing binary, no rebuild):

- **vA — plain fn call `b(cv)` in if-in-arm:** `.Some(cv)=>if(b(cv),true,false)` → **0 (fine)**
- **vB — bool METHOD `cv.is_empty()` in if-CONDITION:** → **1 (reproduces)**
- **vC — METHOD `cv.len()` in if THEN-branch (not condition):** → **1 (reproduces)**

So it is NOT the operator and NOT the branch position — it is **method calls** (`recv.method()`)
on a match-arm binding inside a fresh-cloned macro expansion. Plain function calls survive
`clone_expr_fresh_ids`; method calls do not. Method-call eval sets ExprInfo (and/or the
method-callee side-tables g_method_callee_value/type, keyed by expr id) on a form/id that the
fresh-cloned expansion node does not carry, so codegen's `get_expr_info(cv.len())` → None.
The fix is in how method-call ExprInfo is (re)established when the call node lives inside a
`clone_expr_fresh_ids`'d macro expansion — either clone must carry the method-callee side-table
entries to the fresh ids, or the expansion re-eval must set ExprInfo on the outer call node.

## Mechanism

`if` is a macro (expands to `cond`). In the emitted C for v2 the `if` DID lower to a C
`if/else` (so the if-expr's `ei.macro_expansion` was present and used). But within that
expansion the `>` comparison generated fine (`... > (0ULL)`) while its child `cv.len()`
emitted "Failed to transpile" — i.e. the SAME expansion has ExprInfo on `>` but NOT on
its `cv.len()` child. The if-macro is (re)expanded in the match-arm eval path such that
the expansion object codegen walks has a `cv.len()` child whose id ≠ the id the evaluator
set ExprInfo under. Same family as tasks #10 (match-arm folded-FnCall body ExprInfo), #51
(ExprInfo id mismatch), and the recur/g_macro_expansions durable-side-table fix.

**Hypothesis ELIMINATED (this session):** "a later match-arm re-eval OVERWRITES the durable
`g_macro_expansions` entry with a bad expansion." Tested by making `record_macro_expansion`
first-wins (`expr_info.yo`) + full rebuild: **v2 still emits the marker (1)** → reverted.
So the FIRST (and only relevant) expansion recording ALREADY has a `cv.len()` child with no
ExprInfo. The bug is that the expansion eval at `evaluator/calls/function.yo:3000`
(`evaluate_expression_raw(clone_expr_fresh_ids(expanded), ct_result.caller_env, ...)`) does
not set ExprInfo on the `cv.len()` sub-expression when the receiver is a match-arm binding —
whereas it DOES at top level (v3). Next: instrument that eval (is `cv.len()` reached? under
what id? what env is `ct_result.caller_env` — does it contain the arm binding `cv`?) vs the
codegen lookup id. Likely the macro CTFE's `caller_env` differs from the arm env, so the
cloned expansion's `cv.len()` either isn't evaluated or is evaluated then its ExprInfo keyed
under an id the stored expansion object doesn't carry.

**Mechanistic core (this session, no further rebuild):** BOTH method-call eval branches set
ExprInfo on the call node — `function.yo:3480` (method found) and `:3548` (no method found,
via try_to_call). So eval always sets ExprInfo on `cv.len()`. Since codegen still finds NONE,
codegen must walk a DIFFERENT clone of `cv.len()` than the one eval evaluated. `if` is a macro
that expands to `cond`, which is ALSO a macro (nested expansion). `expanded_expr :=
evaluate_expression_raw(clone_expr_fresh_ids(expanded_box), ...)` (function.yo:3000) returns
the FINAL nested expansion; the method-call node stored in the durable `macro_expansion`
(and walked by codegen) is not the clone whose `cv.len()` received ExprInfo during the
nested if→cond→… expansion. NEXT (needs instrumentation + rebuild): log `ast_expr_id(cv.len())`
at eval (3480/3548) vs at codegen lookup for the v2/vC repro to confirm the id divergence,
then ensure the stored `expanded_expr` IS the evaluated clone (or set ExprInfo on the stored
clone's method-call children). Why method-calls only (vA plain fn call fine): method-call
nodes carry id-keyed side-tables (method_callee_type/value) + are re-resolved per clone, so a
non-evaluated clone has neither ExprInfo nor callee entry; a plain fn call needs less.

**Fix direction:** in the match evaluator's arm-body eval (evaluator/exprs/match.yo /
values/\*), ensure an if/cond-macro arm body's expansion sub-expression ExprInfo is set
under the SAME ids the durable macro_expansion (used by codegen) carries — i.e. don't
re-expand/clone the arm-body macro after ExprInfo is recorded, or record ExprInfo on the
final expansion's children. Verify with v2 → 0 markers, then corpus 97 + `check ./std` 152,
then re-measure the stage-2 error count (expect a large cascade drop, not just −66).

## Not the only "Failed to transpile" shape

The 66 also include method calls in `while(...)` conditions (`while(xs.len() ...)`, several)
and `usize(n)`/`cmd.arg(...)`/`em.emit_string_line(...)` forms — likely the same
macro/loop-body ExprInfo family in different host constructs. Fix the match-arm-if case
first (cleanest repro), then re-scan.
