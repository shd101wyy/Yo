# yo-self stage-2 fixpoint — error-distribution roadmap

**Goal:** yo-self self-compiles into a _valid_ working compiler (stage-2 C compiles
clean) AND matches TS performance. Perf half already met on `check ./std` (-O2: 10.9s
vs TS 19.9s); the blocker is **stage-2 C validity**.

**UPDATE (commit `4950719fb`): 1627 → 1312 errors (−315).** Fixed the "Failed to transpile"
cascade root: `find_function_calls_in_expr` now falls back to the durable macro-expansion
table (like codegen), so method-callees inside match-arm-`if` macro expansions get collected.
This collapsed the syntax/brace cascades (implicit-int 172→47, K&R 74→20, extraneous-brace
out of top-10). Remaining dominant class is now type-identity (undeclared 707 + incompat 257

- member-ref 95 + passing 43). See issues/fixed/yo-self-failed-transpile-if-in-match-arm.md.

**Verified 1312 distribution + accurate next targets:**

- **undeclared 707** — UNCHANGED by the fix (the −315 was ALL syntax/brace cascade collapse).
  Breakdown: **183 `_file____User_temp` never-materialized-temp drops** (single RC-drop root,
  `drop_dup.yo` — biggest single cluster; RC-correctness-sensitive, validate with ASan), ~60
  `g_*` module globals (module-var port, gated on type-identity), **15 `fn_yo_id` = uncollected
  `.throw` EFFECT-HANDLER closures** in `Exception(throw : (err)->{..})` struct literals
  (verified: all are `(__yo_struct_yo_id_5803){ .throw = fn_yo_id_N }` — the propagate-mode
  exn handlers pervasive in the evaluator). NOT a collection-walker gap: `find_function_calls_in_expr`
  (collection.yo:447) only walks `effect_analysis.handler_value`'s BODY, not registering the
  handler — and TS (collection.ts:293) does EXACTLY the same (faithful). The divergence is the
  effect-handler CODEGEN MODEL: yo-self emits the handler as a struct-field function POINTER
  (`.throw = fn_id`) needing a standalone C definition, so it must be collected+emitted;
  TS lowers `Exception(throw:..)` handlers differently (not a raw fn-pointer needing collection
  here). This is Phase-5 effect-handler codegen, not a quick collection fix.), rest scattered.
  REPRO NOTE: the temp-drop bug does NOT reproduce with minimal concrete-type code — verified
  a faithful transcription of the source construct (`validate_concrete_type_constraints`,
  function.yo:1448: a `while` with a match-early-return then `if(ast_expr_is_fn_call_of(arg,"!",
Some(usize(1))), ..)`) compiles clean. It only manifests in the SPECIALIZED-GENERIC
  instantiation (real AstExpr/enum types), e.g. emitted fn `yo_id_247313` where `drop(temp_144445)`
  is emitted inside an `if` body but `temp_144445` is never declared (declaration elided while
  its deferred-drop survived). NEXT: instrument the real self-compile — log in
  `drop_dup.yo generate_deferred_drop_expressions` when a drop target name was never emitted as
  a C decl (track declared names), and in the RC-emission layer where that drop was scheduled —
  rather than chase a minimal repro.
- **type-identity class ~395** (incompat 257 + member-ref 95 + passing 43) — now the dominant
  CLASS; generic-instantiation cfid consistency (index.yo:755/781), deep + previously-reverted.
  Sub-analysis: 115 incompat assign into `enum_<id>_struct_<id>` (enum-over-struct) — the enum
  structural-sig embeds the payload struct's key, so the ENUM divergence is DOWNSTREAM of the
  struct key inconsistency. **HYPOTHESIS ELIMINATED (this session):** a structural-sig bridge in
  `type_key` (register `s_<name>_<typeargs> → gs_key` in the cfid-full path, look it up in the
  cfid-empty fallback) does NOT fix it — built + corpus 97 + std 152, but stage-2 went 1312→1314
  (incompat +22: it even MERGED some distinct structs). So the two divergent C names do NOT share
  `name`+`type_args` — the divergence is deeper (different type*args, or via the enum-sig path, or
  a struct with empty name). NEXT: instrument `type_key` to dump BOTH C names + the full TypeValue
  (name/id/cfid/type_args/fields) for one concrete incompat pair (e.g. bl-emit.c:23353
  `enum_5152_bool` vs `enum_17883*...`) to see EXACTLY what differs, before attempting a fix.

  **REFINED ROOT (this session, from the C at cs-emit.c:23353):** it is NOT two dedup-able
  instantiations of the same type — it is a **generic-specialization SUBSTITUTION bug**. The C
  is `__yo_enum_yo_id_5152_bool t = yo_id_3872(trait_negated, j)` where `trait_negated :
ArrayList(bool)` and `yo_id_3872` is `ArrayList.get` SPECIALIZED for it. The call site
  correctly expects `Option(bool)` (enum_5152) but the specialized `get` RETURNS
  `Option(enum_17868)` — i.e. the element type `T` was NOT substituted to `bool` in the
  specialized function's return type (`enum_17868` is an unsubstituted `T`/SomeType-derived
  enum). So the fix is in generic specialization / monomorphization (substitute type args into
  the SPECIALIZED return type), NOT in `type_key` dedup — which is why the sig bridge failed.
  This is the create_specialized / substitute() return-type path (related to task #22, #30).
  EXACT LOCUS: `create_specialized_function_inline` (helper.yo:1140) computes
  `spec_ret_ty := evaluate_function_return_type_again(<generic result type>, callee_env, ctx)`.
  For the failing case it yields `Option(enum_17868)` not `Option(bool)` → so `callee_env` binds
  the type param to the wrong type (an unsubstituted/mis-inferred `T`) in this (likely nested)
  specialization context. NEXT: instrument `create_specialized_function_inline` to log func_id +
  the generic result type + `spec_ret_ty` + the callee_env type-param bindings for the
  ArrayList.get specialization, to see why `T` resolves to `enum_17868` rather than `bool`.
  Deep specialization type-inference; validate any fix with corpus 97 + std 152 + re-measure.
  INSTRUMENTATION RESULT (this session): a guarded log at helper.yo:1140 for specializations
  whose `type_to_string(spec_ret_ty)` contains "Option" fired ZERO times over a full self-compile.
  So EITHER `evaluate_function_return_type_again` at 1140 is NOT the path that produces
  ArrayList.get's return type (it may come from a cached specialization / a different call path /
  the funcId side-table `get_func_type`), OR `type_to_string` does not spell generic enums as
  "Option" (likely the raw `enum(None,Some(..))`/id form). NEXT: first add an UNCONDITIONAL
  counter/log at 1140 to confirm the path is hit at all, and log `type_to_string` of a known
  Option value to learn its spelling; then widen the search to where codegen reads the specialized
  return type for a call (get_func_type(specialized_func_id) → its Func result), which is what the
  emitted C prototype's return type actually comes from.

- **Residual 56 "Failed to transpile"** — NOT the macro-fallback family (that is fully fixed;
  plain while-condition/if-begin method calls compile clean now — verified). They cluster in an
  **async/effect function body** (a link/compile command builder that `io.await(cmd.status(io))`)
  whose whole body is un-annotated — the Phase-5 async codegen subsystem, deferred.
- residual syntax (implicit-int 47, K&R 20, expected-\* ~45) — remaining cascade tails.

Recommended next: the **183 temp-drop single root** (`drop_dup.yo`, ASan-validate) OR the
**type-identity class** (biggest, deep). Both are focused standalone tasks.

**Prior baseline (`b3d499966`):** self-compile runs exit 0 and emits
`/tmp/bl-emit.c` (682K-ish lines), which clang reported **1627 errors** (`-ferror-limit=0`;
the default cap of 20 is misleading). This is a **multi-root, multi-session** effort —
no single fix reaches 0. Below is the root-cause-classified distribution to execute
against, most-leverage first.

Reproduce the measurement:

```
YO_MAIN_STACK_MB=2048 <binary> compile yo-self/main.yo --emit-c --skip-c-compiler -o /tmp/bl-emit
clang -std=c11 -fno-strict-aliasing -fwrapv -w -O0 -ferror-limit=0 /tmp/bl-emit.c -o /tmp/bl-bin
grep -o 'error: [a-z].*' clang.txt | sed -E "s/'[^']*'/'X'/g" | sort | uniq -c | sort -rn
```

## Error categories (baseline 1627)

| count | category                                      | root class                                     |
| ----: | --------------------------------------------- | ---------------------------------------------- |
|   729 | use of undeclared identifier                  | **mixed — see breakdown**                      |
|   256 | initializing with incompatible type           | **generic-instantiation type-identity** (deep) |
|   172 | type specifier missing (implicit int)         | decl emitted without return/var type           |
|    95 | member reference base is not struct/union     | type-identity / wrong C type on a var          |
|    74 | K&R param list (no types)                     | malformed fn-ptr/param emission                |
|    43 | passing incompatible type to parameter        | type-identity                                  |
|    41 | expected identifier                           | syntax cascade                                 |
|    37 | expected expression                           | syntax cascade                                 |
|    37 | expected 'X'                                  | syntax cascade                                 |
|    32 | initializer element not compile-time constant | file-scope init of non-const                   |
|    14 | unknown type name                             | uncollected type                               |
|    11 | extraneous closing brace                      | brace-imbalance cascade root                   |

### The 729 "undeclared identifier" breakdown (by name cluster)

- **176 `_file____User_temp_N` inside `__yo_decr_rc(...)`** — **SINGLE ROOT**: deferred
  drops emitted for temps codegen NEVER materialized (declaration elided, e.g. the value
  was inlined, but the RC-drop was still scheduled). Concentrated in specialized-generic
  fns (`yo_id_246160`, `yo_id_12319`, `yo_id_247313`, ...). RC-correctness-sensitive:
  wrongly skipping a drop risks the P0 double-free/leak family — needs careful validation,
  not a blind filter. Fix site: `codegen/exprs/drop_dup.yo:542 generate_deferred_drop_expressions`
  - `return.yo _keep_pending_drop` (the HEAD commit's `_variable_initialized_after_cleanup_point`
    handles drops for locals declared AFTER the drop; this is the NEVER-declared sibling case).
- **~60 `g_*` module globals** (`g_comptime_fn_caches` 13, `g_cached_prelude_env` 12,
  `g_send_derivation_in_progress`, `g_impl_registry_keys`, `g_traverse_visit_expr`,
  `g_tk_visited`, `g_struct_cfid_keys`, `g_macro_quoted_param_indices`, `g_loading_keys`, …)
  — **FIXED by the module-var port** (`issues/module-level-var-port.patch`), but that port
  is itself gated on the type-identity issue (see below); apply after it lands.
- **~15 `fn_yo_id_N`** — functions called but never collected/emitted.
- **remainder** — scattered locals (`env`, `lhs_info`, `expr`, `evaluated`, `ty`, `t`,
  `value_sub`, `label_sub`, `new_pending`, …); likely block-scope / early-elision cases.

## KEY REFRAME: 1627 errors ≈ 4 root CLASSES (not 1627 independent bugs)

Cascade analysis (this session) shows most errors are downstream of a few roots:

- **Brace-imbalance class (~350 errors from ~11 roots).** The 11 "extraneous closing
  brace" errors are match/switch emitters producing an EXTRA `}` that closes the enclosing
  C function early. Everything after then parses at file scope → the 172 "implicit-int"
  (a function _call_ like `yo_id_20848(env);` read as a K&R decl), the 74 "K&R param list",
  and much of the "expected identifier/expression/'X'" (~115) are ALL cascades from these
  ~11 sites. Example root (bl-emit.c:55505): a `switch` over an enum tag closes, then an
  extra `}` appears before an `else {}` whose `if` brace was miscounted — a nested
  match-in-if / match-arm brace-accounting bug in the match/cond emitter. **Highest-leverage
  tractable target: pure codegen emission, no RC/type-identity sensitivity.** Fix the
  emitter brace accounting; ~350 errors should collapse.
- **Type-identity class (~256 + 95 member-ref + 43 passing ≈ 394).** Generic-instantiation
  key inconsistency (details below).
- **Temp-drop class (176).** Deferred drops for never-materialized temps (details below).
- **Uncollected-functions/globals (~75).** ~60 fixed by the module-var port; ~15 `fn_yo_id`.

So the effective work is ~4 focused investigations, and the brace class (~350, safest) is
the recommended FIRST fix — it needs no type-identity or RC reasoning.

## Priority order

-1. **"Failed to transpile" markers (66) — THE cascade root, DO FIRST, has a MINIMAL REPRO.**
`generate_func_call` emits a `// Failed to transpile <expr>` COMMENT when a FnCall has no
ExprInfo (generation.yo:405). That comment eats the rest of the C line — parens AND braces —
so it is UPSTREAM of the brace-imbalance (#0), implicit-int, K&R-param, and expected-\*
syntax cascades. Fixing the 66 markers likely collapses ~350-500 errors together.
**Minimal TS-divergent reproducer** (`issues/yo-self-failed-transpile-if-in-match-arm.md`):
a method call inside an `if` that is a match-arm body — `match(o,.Some(cv)=>if(cv.len()>0,..),.None=>..)`
— loses ExprInfo on `cv.len()`. `if` is a macro; its expansion is cloned-fresh + evaluated at
`evaluator/calls/function.yo:3000` (works at top level), but the match-arm path gives codegen a
`cv.len()` whose id ≠ the eval-set id. Fix in the match evaluator's variant-arm body eval
(`evaluator/exprs/match.yo`) so the arm-body macro expansion's child ExprInfo matches codegen's
ids. Fast loop: `<bin> compile x.yo --emit-c --skip-c-compiler` + grep `Failed to transpile`.
The 66 also include method calls in `while(...)` conditions — same family, re-scan after.

0. **Brace-imbalance in match/switch emission (~350 errors, ~11 roots) — largely DOWNSTREAM of -1.** Safest
   (pure emission, no RC/type-identity). Roots at bl-emit.c:55505/55546/60853/103512/110431/
   110813/125872/158456/182714/188670. Each is a match/switch (often nested match-in-if or a
   match arm) emitting an unbalanced `}`. Reproduce by extracting the offending yo-self source
   construct into a standalone `.yo`, compile with `./yo-cli compile` to see the C, count braces.
   Fix the emitter (`codegen/exprs/match.yo` / `cond.yo`) brace accounting. Validate corpus 97.
1. **Generic-instantiation type-identity consistency** (unlocks 256 incompat + 95 member-ref
   - 43 passing + the module-var port's ~60 globals). Localized in `codegen/utils/index.yo`:
     generic structs key as `gs_<constructor_func_id>_<typeargs>` (line ~755) only when cfid
     is populated (stamped at `evaluator/calls/comptime_fn.yo:872`), else fall back to an
     unstable bare `sid` (line ~781). Same logical `Option<value-struct>` reaches `type_key`
     with cfid at one site, empty at another → two C names. **CAUTION:** this code path was
     profiled at O(n²)/hours and carefully optimized; a prior evaluator-side cfid-population
     attempt was reverted (memory `yo-self-phase3-generic-impl-funcid`). First diagnostic:
     disambiguate _different-sids_ (needs a structural-sig bridge, perf-careful) vs _ordering_
     (needs pre-registration, cheap). See `issues/module-level-var-port.md`.
2. **Never-materialized-temp drops** (176). Single root, RC-sensitive; validate with corpus
   97 + std 152 AND an ASan/leak check, since it touches drop correctness.
3. **implicit-int (172)** — find the decl-emission path dropping a return/var type.
4. **Syntax cascades (~130: expected-identifier/expression/'X' + extraneous-brace)** — likely
   a few malformed emissions; fix the brace-imbalance roots first (cascades collapse).

## Validation gates (every fix)

- corpus: `YO_SELF_BIN=<bin> bash scripts/diff-test.sh tests/codegen-bootstrap` → 97/97
- `<bin> check ./std` → 152, `check ./tests`, `check ./yo-self`
- re-measure the clang error count on the regenerated stage-2 C
- for RC-touching fixes: also `--sanitize address` a representative binary
