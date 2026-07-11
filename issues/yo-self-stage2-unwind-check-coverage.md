# yo-self codegen: effect-unwind checks missing on method-call emission paths (stage-2 crash + fixpoint blocker)

## Status

DRAIN ITEM 8 — TWO faithful fixes LANDED (2026-07-11):

- **3ed667915**: `type_contains_rc_type` `.SomeT` follows `resolved_concrete`
  (was stubbed `=> true`; TS utils.ts:187-192). Fixes the out_none-path
  over-release.
- **75939ebb4**: evaluate_function_call struct-construction arm uses explicit
  `return(expr)` (was bare tail `expr`; TS function.ts:2470 `return expr`).
  Explicit returns emit the AstExpr node dup; the bare tail skipped it when
  set_expr's type gate (utils.yo:638) saw the concrete NON-RC struct result.
  Confirmed by emission diff: TS `___dup(expr)` (s1-ref:191041) vs yo-self
  `= expr` (stage2-fix:329107).
- **RESULT**: stage-2 `check` now passes t5.yo/t2.yo/t1.yo (comptime_list of
  structs, rc=139→0) AND yo-self/token.yo (rc=134→0). Gates: corpus 118/118
  DIFF 0, check ./std 153/153. Stage-1 (binf3) checks template_multibyte +
  expr.yo clean.
- **STILL-OPEN stage-2 crashes (separate bug classes)**:
  - `tests/codegen-bootstrap/template_multibyte.yo` (template strings): rc=139
    at clang -O1, but runs CLEAN (rc=0) under the -O0 RC-tombstone with ZERO
    UAF detected. Since the tombstone quarantines frees and only checks
    incr/decr, this is a **plain use-after-free** (reading a freed struct field,
    NOT via \_\_yo_incr/decr_rc) that the RC tombstone MASKS — a different bug
    class. Needs ASan (`clang -O1 -g -fsanitize=address`, libc allocator) or
    lldb, not the RC tombstone. LESSON: an -O1-only rc=139 that the RC tombstone
    can't reproduce/detect = plain UAF or clang UB, not an RC imbalance.
  - `yo-self/expr.yo`: rc=139 (untriaged; may be same class).

DRAIN ITEM 8 — SomeT fix LANDED (3ed667915), struct-ctor arm OPEN (2026-07-11):

- **FIXED (committed 3ed667915)**: `type_contains_rc_type` `.SomeT` stub
  (`=> true`) now follows `resolved_concrete` (faithful to TS utils.ts:187-192).
  This was making SomeT-resolved-to-non-RC results owning → their return-tail
  dup was skipped → over-release. Fixes t1.yo (fmt-import case, rc=139→0) and
  the corpus file template_multibyte.yo. Gates: corpus 118/118 DIFF 0, check
  ./std 153/153.
- **OPEN — struct-construction return arm** (t5.yo:
  `S :: struct(n:usize); lst :: comptime_list(S(usize(1)), S(usize(2)))`,
  still rc=139; yo-self/token.yo rc=134, expr.yo rc=139 — the real fixpoint
  blocker). Object-level probe of comptime_list.yo's loop shows for t5's
  elements: `argid == evalid` (same node) and `evalty = S`, `contains_rc=false`.
  The element flows through `evaluate_function_call`'s STRUCT-CONSTRUCTION arm
  (function.yo:2075-2079: `out_s := new_expr_info(caller_env, func_type);
out_s.value = struct_val; ...; expr_info_table_set(...); expr`), NOT the
  out_none arm (verified: guarded probes at 3271/3598/3723 never fire for t5).
  The over-release: comptime_list drops `evaluated_arg` (an AstExpr node, RC at
  its META/declared type), but `evaluate_function_call`'s struct-ctor return
  did not dup the node. The return-tail dup at set_expr (utils.yo:638) is gated
  on `type_contains_rc_type(ei.ty)` where ei.ty = the struct-ctor result type.
  At OBJECT time that's concrete non-RC `S` → no dup; the emission decision is
  made at DEF-TIME (compiling function.yo), where the result type is
  generic/SomeT — the TS/yo-self divergence is in that def-time type.
- **REGRESSION LESSON**: TS's struct-ctor arm calls
  `attachTempVariableToExpr(expr, true, ...)` (function.ts:2461); yo-self's
  omits it. But naively PORTING that call REGRESSES t1/t2 to rc=138 — for RC
  structs, attach makes an owning temp → set_expr CONSUMES it (no dup) AND the
  owning temp gets a scope-end drop → double-free. So the attach call is NOT a
  safe standalone port; the RC-struct fall-through (no attach → dup) is
  currently correct, and only the NON-RC-struct case is missing its dup. The
  real fix must give the non-RC-struct return its AstExpr-node dup WITHOUT
  breaking the RC-struct path — likely by ensuring the def-time struct-ctor
  result type is treated as its AstExpr node (RC) for the return dup, or by
  the attach preserving the borrowed-param ownership (utils.yo:146-150) so
  set_expr builds the dup rather than consuming. Next: -O0 alloc-tombstone on
  the 3ed667915 stage-2 for t5 to get the exact no-dup yo_id, then compare the
  struct-ctor def-time type_to_string between TS (`./yo-cli`) and the stage-2
  binary via a guarded probe in function.yo's struct-ctor arm.

DRAIN ITEM 8 ROOT-CAUSE PINNED (2026-07-11, stage2-v24, tombstone+alloc-table):
The t1/t2 `check` SIGSEGV (rc=139) is an **over-release of a comptime_list
element AST node** inside `evaluate_comptime_list_value` (yo_id_277811,
yo-self/evaluator/values/comptime_list.yo:73-144 loop).

- **Minimal deterministic repro**: `printf 'x :: "p";\nexport(x);' > /tmp/t2.yo`
  then run the stage-2 binary `check /tmp/t2.yo` FROM THE REPO ROOT (needs
  ./std). No `open(import("std/fmt"))` needed — the doomed node is a PRELUDE
  AST node (allocated by the parser, `parse_expression` → FnCall via
  yo_id_226313), flowing as an element of a prelude comptime_list.
- **The TS reference emission of yo-self (`/tmp/s1-ref-v3.c`) runs t2 CLEAN**
  (rc=0). Same yo-self source → this is a **pure emission divergence** in a
  callee, NOT in evaluate_comptime_list_value itself (its emitted RC ops are
  provably equivalent to TS: arm dups `a`, val arm dups `v`, both ct arms
  dup, `return expr` does `incr(expr); return expr`; every apparent
  "missing INCR" in the normalized count diff was a naming artifact — yo-self
  materializes the bound var into a temp and does `INCR temp`).
- **Exact RC ledger** (from the alloc-table tombstone, -O0 clean backtraces):
  the doomed element gets exactly **2 acquisitions** — `INCR` in
  `get()` (yo_id_3136, the ArrayList get-dup) and `INCR` in the arm
  (`.Some(a) => a` arm-dup, yo_id_277811) — but **3 drops** at the loop-body
  scope-end: `decr(Option-inner)`, `decr(arg)`, `decr(evaluated_arg)`.
  All three drops hit the SAME pointer because
  `evaluated_arg := evaluate_expression(arg)` **returns `arg` aliased with NO
  +1** (no evaluate_expression INCR appears in the object's history).
- **The imbalance**: `arg`/`Option-inner` drops are balanced by get+arm
  (+2/-2). The `evaluated_arg` drop is UNBALANCED — evaluate_expression
  returned a borrow but the loop drops evaluated_arg as owned → net -1 →
  frees a live parser AST node → UAF on the next touch.
- **TS is balanced** because TS's `evaluate_expression` returns the element
  with +1 (its `evaluated_arg` is genuinely owned / distinct), so its
  (identical) `___drop(evaluated_arg)` is safe. TS's emitted loop-body drop
  set is IDENTICAL to yo-self's (both drop evaluated_arg, arg, Option-inner).
- **FAST STANDALONE REPRO** (no prelude spelunking):
  `printf 'S :: struct(n : usize);\nlst :: comptime_list(S(usize(1)), S(usize(2)));\nexport(lst);\n' > /tmp/t5.yo`
  Then `YO_MAIN_STACK_MB=16384 /tmp/s2bin check /tmp/t5.yo` (from repo root) →
  rc=139. `/tmp/s1ref check /tmp/t5.yo` (TS-compiled yo-self) → rc=0. Plain
  `./yo-cli check /tmp/t5.yo` → rc=0. Same 2-INCR(get,arm)/3-DECR genealogy as
  t1/t2. Element = a struct-ctor FnCall `S(usize(1))` with a compile-time value.
- **NEXT — pinpoint target**: `_evaluate_expression`'s FnCall fall-through is
  `evaluate_function_call(expr, env, t_unit(), None, ctx, exn)` (\_expr.yo:923).
  `evaluate_function_call` (yo-self/evaluator/calls/function.yo) has MANY
  comptime return points that return the INPUT `expr` (lines 3273, 3326, 3416,
  3599, 3647, 3724). For the comptime struct-ctor element, one of these returns
  `expr` as a BORROW (the return-tail dup is skipped by
  set_expr_as_needs_to_call_dup's `has_concrete_value` early-return because the
  node carries a real comptime value). TS's evaluate_function_call gives the
  same return a +1 (its `evaluated_arg` is genuinely owned, so the identical
  loop-body `___drop(evaluated_arg)` is safe). **ACTION**: find
  `evaluate_function_call` (the yo*id whose body matches, or fn*...\_evaluate_function_call
  in s1-ref-v3.c), diff the comptime return-`expr` emission between stage2-v24.c
  and s1-ref-v3.c — the TS side has a `___dup(expr)`/distinct-fresh-node the
  yo-self side lacks. Port that dup. `has_concrete_value` skipping the dup is the
  suspected root: for a returned node that ALIASES a caller-owned AST node the
  skip is unsound; TS must not skip here (verify why — likely the returned node
  is a FRESH synthesized node in TS vs the input node in yo-self, or TS's temp
  lacks the value so has_concrete_value is false).
  Rebuild loop: fix function.yo → `./yo-cli compile yo-self/main.yo --release -o /tmp/yo-self-bin`
  (~few min) → emit stage-2 → clang → `check /tmp/t5.yo` must be rc=0. Gates:
  corpus 117/117, check ./std 153/153.
- **EXACT no-dup return site pinned** (stage2-v24.c:319905 in yo_id_264759 =
  evaluate_function_call): `_file____User_temp_399763 = expr;` with NO
  `incr(expr)` — this is the `out_none` UnknownVal fall-through tail
  (function.yo:3720-3724): `out_none := new_expr_info(...); out_none.value =
Some(_call_result_unknown(...)); expr_info_table_set(...,expr,out_none);
attach_temp_variable_to_expr(expr, true, ctx); expr`. ALL other
  `return expr;` sites in this fn DO `incr(expr)` first; only this comptime
  tail path omits it → returns the caller-owned input AST node as a borrow,
  which the comptime_list loop then drops as `evaluated_arg`.
- **PUZZLE RESOLVED — it is a CODEGEN / compiled-evaluator divergence, NOT an
  evaluator-logic or node-identity difference**:
  - A TS-side probe in `src/evaluator/values/comptime-list.ts` shows `arg ===
evaluatedArg` (SAME object) in TS too — the TS evaluator uses JS GC and does
    ZERO manual RC on AstExpr nodes. So node identity is NOT the difference.
  - The manual-RC drops/dups only exist in the COMPILED output. Diffing the two
    emissions of the SAME yo-self source `evaluate_function_call` (function.yo
    out*none path): the TS-compiled reference `s1-ref-v3.c:204540` emits
    `\_temp = fn*...\_\_\_dup(expr); ... return \_temp;`— it DUPS expr. The
yo-self-compiled`stage2-v24.c:319905`emits`\_temp_399763 = expr;` — NO dup.
  - Both C files come from compiling the IDENTICAL function.yo source
    (`out_none := new_expr_info(...); out_none.value = Some(_call_result_unknown(...));
expr_info_table_set(...); attach_temp_variable_to_expr(expr, true, ctx); expr`).
    The ONLY difference is the codegen: TS-codegen computed a
    deferredDupExpression for the tail `expr`; yo-self-codegen did not.
  - Therefore the yo-self-COMPILED evaluator's `set_expr_as_needs_to_call_dup`
    (utils.yo:577) / `attach_temp_variable_to_expr` (utils.yo:112) computes a
    DIFFERENT deferred-dup at RUNTIME than the TS evaluator does on the same
    input. `check ./yo-self` is green (type-check only, never runs these paths),
    so this is a compiled-behavior divergence invisible to `check`.
  - **HYPOTHESIS**: attach makes an OWNING temp for `expr` (new-temp branch,
    utils.yo:184-204, `_is_owning_rc=true`); then set_expr_as_needs_to_call_dup
    sees an owning temp → CONSUMES it (utils.yo:642-658) → returns WITHOUT a dup.
    In TS the temp ends up NON-owning (borrowed), so set_expr builds the dup.
    The divergence is the temp's `is_owning_the_rc_value` at that point — likely
    the preserve-borrowing rule (utils.yo:146-150) fires in TS but not yo-self
    because `expr` had an existing BORROWED variable_name in TS (→ existing-var
    branch, preserved borrowed) whereas in yo-self `out_none` reset variable_name
    to None (→ new-temp branch, owning). Verify: does TS's evaluator keep
    `expr.$.variableName` across the out_none ExprInfo replacement while yo-self's
    `new_expr_info`+`expr_info_table_set` drops it?
  - **REFINEMENT (narrows the fix to the TYPE domain)**: the deferred-dup is
    gated at utils.yo:638 `if(!(type_contains_rc_type(ei.ty)), { return; })`
    (faithful to expr.ts:2500 `if (typeContainsRcType(expr.$.type)) { ...dup... }`).
    So set_expr only builds the dup when `ei.ty` (the expr's SEMANTIC type =
    out_none.ty = the call's `ret_type_none`) contains RC. TS emits `___dup(expr)`
    ⟹ in the TS-codegen run `ei.ty` IS RC; yo-self does NOT ⟹ in the yo-self run
    `ei.ty` is non-RC (or `type_contains_rc_type` disagrees). The divergence is
    therefore in what `ret_type_none` resolves to for the comptime element, or in
    `type_contains_rc_type` / shell-resolution on it — NOT in attach/set_expr
    control flow (those are faithful). Instrument `type_contains_rc_type(ei.ty)`
    and `ei.ty` (type_to_string) at utils.yo:638 for the out_none tail; compare to
    TS. Suspect: the element's return type is an AstExpr/ref(enum) shell whose
    is_reference_semantics is lost (cf. [[yo-self-refstruct-get-dup-chain]] shell
    resolution in types/guards.yo `is_rc_type`) → type_contains_rc_type wrongly
    returns false in yo-self.
- **NEXT EXPERIMENT**: add module-guarded eprintln in yo-self
  `attach_temp_variable_to_expr` and `set_expr_as_needs_to_call_dup` printing,
  for the out_none tail expr, which branch runs + the temp's is_owning; rebuild
  stage-1 (`./yo-cli compile yo-self/main.yo --release -o /tmp/yo-self-bin`);
  emit stage-2; run `check /tmp/t5.yo`; compare to what TS does (instrument
  src/expr.ts attachTempVariableToExpr similarly + `./yo-cli check /tmp/t5.yo`).
  Fix so yo-self matches TS (likely: preserve `expr`'s existing borrowed
  variable_name across the out_none ExprInfo swap, OR don't mark the tail temp
  owning when expr is a caller-owned input node).
- **~~OPEN PUZZLE~~ (superseded above)**: TS's
  equivalent (function.ts:2358-2369) ALSO resets `expr.$` to a new ExprInfo
  WITHOUT variableName and calls `attachTempVariableToExpr(expr, true)`, which
  ALSO creates an OWNING temp → `setExprAsNeedsToCallDup` would consume it
  (no dup) the same way. So the attach/set-dup logic is faithfully ported and
  is NOT the divergence. The real difference must be one of: (a) in TS the
  comptime_list ELEMENT node handed to evaluate_function_call is a distinct
  (macro-expanded / freshly-synthesized) node, not the shared parser node, so
  its drop is safe; (b) the element's `value`/ownership state entering the
  loop differs; or (c) an upstream dup (get/arm/macro-expansion) produces a
  different net count in TS. RESOLVE with EVALUATOR-LEVEL instrumentation:
  add a guarded eprintln in comptime_list.yo's loop printing
  `ast_expr_id(arg)` vs `ast_expr_id(evaluated_arg)` and the arg element's
  variable ownership, in BOTH `./yo-cli check /tmp/t5.yo` (TS) and the
  stage-2 binary — if TS's evaluated_arg id != arg id but yo-self's are equal,
  the divergence is that yo-self returns the SAME node where TS returns a
  fresh one (fix: make the out_none/comptime path return a fresh node or dup,
  matching TS's node identity). This is the precise next experiment.
- **Tooling**: `scripts/rc-tombstone-instrument.py` now bounds the decr body
  by the incr-fn start (fixes the 3rd stray `__yo_free` in the fast/tracked
  paths). A one-off alloc-backtrace-table extension (persistent per-pointer
  table, survives ring wrap) lives in the scratchpad recipe below and was the
  key to catching a long-lived parser node whose alloc had scrolled off the
  4M event ring.

DRAIN LOOP STATUS (2026-07-11 third session, through stage2-v20): the
t1.yo repro is surfacing stage-1 RC-emission divergences ONE AT A TIME —
two fixed, one open:

1. FIXED (fb079277e): match-arm property-read dup lost to STALE eval-temp
   (evaluate_function_call's `.Some(ci) => ci.env` → callee_env net −1;
   was rc=133). Fix: generate_case_body's unnamed-dup fallback dups the
   GENERATED declared temp. Corpus test: match_arm_property_dup.yo.
2. FIXED (5eff2ff23): cond emitter had NO arm deferred-dup handling
   (cond.ts:409-470 unported) — `resolved_methods := cond(..., true =>
methods)` in get_receiver_methods_by_name_from_env double-dropped
   `methods` (was rc=139). Corpus test: cond_arm_local_dup.yo.
3. OPEN (stage2-v20, t1 rc=133) — PINNED TO THE EXACT EXTRA DROP:
   inside yo*id_228095 = merge_and_check_envs (utils.yo), the
   consumed-at store `base_var.consumed_at_token =
Option(Box(Token)).Some(box(t.clone()))` emits (stage2-v20.c:318326+):
   save old; clone; box(clone); store Some(box);
   \_\_yo_decr_rc(clone_temp); // ← EXTRA — box() MOVED the clone
   drop displaced old; // correct
   The TS reference emission (s1-ref-v3.c:253483+) has NO decr of the
   clone temp — box consumes its argument, so the post-store drop of the
   box's arg temp over-releases the Token/Box (GC trial-delete then walks
   the freed child of a Variable → t1 rc=133). DIVERGENCE CLASS: a call
   argument MOVED into an own(...)-param callee (box) must be marked
   consumed so the statement's rhs-temp cleanup skips it; stage-1's
   emission of this property-assignment shape drops it anyway. Find where
   the post-store `decr(clone_temp)` is emitted (property-assignment rhs
   temp cleanup in codegen/exprs/assignment.yo, or deferred-drop list on
   the box-call ExprInfo) and compare the consume marking against TS's
   call-site handling of own params (calls/helper.ts).
   NOTE: the same `x.consumed_at_token = Some(box(tok))` construct exists
   at consume.yo / utils.yo (this session's perf fix) and many merge
   sites — one codegen fix covers all.
   NEXT STEPS (verified so far): helper.yo Step 4b (own-param move
   consume, lines ~543-560) IS a faithful port of helper.ts:411-451 —
   so either (a) box()'s call path BYPASSES Step 4b (box may route
   through a builtin/generic fast path — check where `box` calls bind
   args: evaluator/values/box handling vs try_to_call/bind_argument), or
   (b) the statement-level rhs-temp cleanup that emits the post-store
   `decr(clone_temp)` (property-assignment path in
   codegen/exprs/assignment.yo — the `_tmpN; decr(...)` right between
   the store and the displaced-old drop) ignores the consumed mark.
   PROBE RESULTS (2026-07-11, [PIO-LOOP]/[4B] label-guarded probes):
   RUNTIME REPRO LANDED: tests/codegen-bootstrap/box_arg_move_property_store.yo
   (TS prints "alpha\nalpha"; stage-1-compiled binary prints EMPTY line
   then "alpha" — the boxed payload is freed by the extra drop; the corpus
   diff runner flags it). Probes prove box's `value` arg NEVER binds
   through try_to_call_function_with_arguments' param loop (helper.yo
   Step 7 → check_if_function_parameter_matches_argument → Step 4b): the
   only "value"-labeled params seen there during the repro compile are
   std/string methods. box (forall(V : Type)) is routed through the
   COMPTIME-FN path (evaluate_comptime_fn_call / specialization), which
   has NO own-consume — but TS's comptime-fn.ts ALSO has none, and TS
   still emits no extra drop. So the REAL divergence is on the DROP
   side: yo-self's property-assignment evaluator schedules a
   statement-level drop for the rhs's intermediate call-arg temp (the
   clone) that TS never schedules — diff yo-self
   evaluator/exprs/assignment.yo's property-path ExprInfo tail (what it
   pushes into deferred_drop_expressions / which temps stay owning)
   against assignment.ts's property path. try_to_implement_function_by*
   function_type is NOT the binder (it is the fn-DEFINITION handler).
   FINAL PIN: TS's emitted mark() has NO drop of the clone temp ANYWHERE
   (not statement-level, not scope-end) — TS marked it CONSUMED at the
   call. So the fix is on the CONSUME side: yo-self's comptime-generic
   call path (evaluate_comptime_fn_call's arg-collect, comptime_fn.yo —
   where box(forall(V : Type), own(value) : V) binds) must apply
   helper.yo Step 4b's own-consume (owning arg → move/consume; borrowed
   → dup+consume), keyed on the fn's param_is_owning flags (mind
   forall-slot alignment). Verify: box_arg_move_property_store.yo flips
   from DIFF to PASS; then gates → stage-2 → t1.

4. FIXED (d8211eaf1): own-param move consume in the inline FuncVal arg
   loop — evaluate_function_call pre-evaluates args in its own loop,
   bypassing try_to_call_function_with_arguments, so own(...) params
   (box) never consumed their args; the statement cleanup then dropped
   the box-moved clone temp. Corpus test box_arg_move_property_store.yo
   flipped to PASS (116/116). t1 rc=133 → rc=139.
5. OPEN (stage2-v21, t1 rc=139): STILL merge_and_check_envs, next shape —
   a PLAIN FIELD READ of an RC-payload value enum:
   `base_var.consumed_at_token` (Option(Box(Token))) feeding `.is_some()`
   materializes the Option into a temp WITHOUT dup'ing the payload
   (stage2-v21.c:315145: `_tmp = base_var->consumed_at_token;` — no
   incr), then the read-temp cleanup drops the payload
   (stage2-v21.c:315160: `switch(_tmp){Some: decr(...)}`) — net −1 on
   the field's Box each time the check runs. The TS reference emission
   dups the Option payload right after the same read
   (s1-ref-v3.c:253470: `temp2 = ___dup(temp1)`). DIVERGENCE: the
   property-READ path for value-enum results with RC payloads either
   fails to attach the deferred dup (evaluator) or fails to emit it
   before scheduling the temp drop (codegen) — same family as the
   match-arm/cond-arm fixes but at a direct statement read. Repro
   direction: `if(h.slot.is_some(), ...)` on a ref-struct with
   Option(Box(T)) field, called repeatedly — each check leaks −1 until
   the box frees while the field still holds it.
   REPRO ATTEMPTS (both print correctly under stage-1 bin — do NOT
   reproduce): plain `h.slot.is_some()` AND `flag && (h.slot.is_some())`
   (tests/codegen-bootstrap/value*enum_field_read_dup.yo, kept as a
   guard). The divergence needs merge's exact context — receiver is a
   Variable ref obtained from frame.variables.get() match arm, inside a
   while loop, under `all_consumed && v.consumed_at_token.is_some()`.
   RECOMMENDED NEXT ROUTE instead of repro-hunting: direct RC event-
   stream diff of the EMITTED yo_id_228095 (stage2-v21.c:314xxx-318xxx)
   against TS's fn*...\_merge_and_check_envs (s1-ref-v3.c:251848+) —
   enumerate every incr/decr on Option(Box(Token)) temps in both and
   fix ALL mismatches in one pass (the fn is the single hottest
   consumed-at writer; several drain items have landed here).

6. FIXED (814363d43): match-SUBJECT deferred dup — begin-wrapped non-atom
   scrutinee (`match(base_var.consumed_at_token, ...)`) carried the
   begin-tail dup but generate_match_expression never emitted it. Emits
   on the declared subject temp now. t1 rc=139 → rc=138. Corpus 117/117.
7. OPEN (stage2-v22, t1 rc=138): UAF READ (incr on freed 96-byte object,
   MethodEntry-like) during generic-impl method lookup
   (yo_id_242332(concrete_type, method_name, env) ← yo_id_243603 ←
   get_receiver_methods ← evaluate_function_call). The object was freed
   by `__yo_decr_rc(m_to_push)` inside yo_id_242796 (an evaluate handler,
   stage2-v22.c:190524) right AFTER a push/registration sequence that
   also built a variable binding via yo_id_20399(forall_env, name, ty,
   Some(mval), ...) — a PUSH-THEN-DROP: the pusher drops the MethodEntry
   it just stored (or the registration under-retains) while the method
   registry still references it. SOURCE FOUND: yo-self/evaluator/values/
   impl.yo:1667-1673 — `(m_to_push : EvalValue) = mval` (or the
   \_stamp_impl_forall_on_method copy) then `method_values.push(m_to_push)`
   then scope-end drop. The `=` typed-binding is the dup-on-store class
   (d684840c8): check whether BOTH branches' assignments got the rhs dup
   and whether ArrayList(EvalValue).push retains — then compare the TS
   emission's RC ops around the same push (impl.ts:773 region in
   s1-ref-v3.c), fix, gates, re-emit, t1.

7b. FIXED (ce0d64133 + 052ddea94): the non-retaining push was TWO bugs —
(a) is*rc_type read is_reference_semantics off recursive SELF-SHELLS
without resolving them (guards.yo now resolves via
resolve_enum_shell/resolve_struct_shell); (b) set_expr_as_needs_to*
call_dup's `if (expr.$.value)` port early-returned for params bound
Some(UnknownVal) by create_specialized_function_inline's rebind
(helper.yo:1372/1387) — UnknownVal now counts as NO value (TS
undefined parity). VERIFIED: both ArrayList(EvalValue).push
specializations in stage2-v24 retain. Gates 117/117 + 153/153. 8. OPEN (stage2-v24, t1 rc=139, crash MOVED): UAF incr inside
yo_id_277811 = evaluate handler of values/comptime_list.yo — the
element loop's per-iteration cleanup `__yo_decr_rc(arg)`
(stage2-v24.c:332695) frees an element of the expr's ARGS list, then
a later read (yo_id_277811+840, inlined incr+2) touches the freed
AstExpr. Same lost-arm-dup family: `arg := match(args.get(j),
   .Some(a) => a, ...)` — the get()-payload arm dup didn't materialize
in this emission (unnamed/stale variant that generate_case_body's
item-1 fallback doesn't reach, OR the loop-context clobber). Next:
read the emitted arg-binding in stage2-v24.c above :332695 to see
which of the three dup routes was taken, compare TS's emission of
the same loop (values/comptime-list.ts), extend the drift-safe
fallback to the missing shape.
VERIFIED (v24 emission): the arg binding itself BALANCES — args.get's
+1 (payload decr at stage2-v24.c:332687) and the arm dup at :332382
(decr(arg) at :332695) pair correctly. The over-release is therefore
on the THROW / effect-escape path inside the element loop (the
"Failed to evaluate expr_list element" throw runs constantly under
def-time swallowed evaluation): the escape block drops loop locals,
and either control re-enters the loop after a swallowed unwind
(double-drop of that iteration's refs) or the escape block drops refs
the normal tail also drops. Compare the escape-block emission of this
loop vs TS's (TS emits full per-return cleanup; stage-2's is thinner)
— the FIRST crash-class instance of the documented escape-path
fidelity gap.

8-REFINED (tombstone detector, scripts/rc-tombstone-instrument.py):
the full RC event history of the doomed object (an ARGS ELEMENT of a
comptime_list call) is: creation(+1) + get-dup(+1) + arm-dup(+1) −
get-temp-drop − decr(arg) − decr(evaluated_arg) = rc 0 → freed, later
re-read. All comptime_list-side ops BALANCE (the fn's own tail dup IS
emitted — earlier "450 bare return expr" reading was a grep-window
error; the ~100 dup-before-return-expr counts are the true handler
tails). The missing +1 is the RESULT convention on the ARG's OWN
evaluation: `evaluated_arg := evaluate_expression(arg, ...)` is
dropped as OWNED by the caller, but for simple/atom-class arg nodes
the DISPATCHER's inline arm returns the INPUT node bare (no dup) —
callee broke the owned-result convention. NEXT: find the
evaluate_expression dispatch arm(s) that assign the input `expr`
directly to the dispatch result temp (stage2 `_file..._temp_446846 =
   expr` shapes) and compare TS's emission of the same arms (TS handler
tails dup ×531); the ring tool pins any next object in minutes
(single-file compile of values/comptime_list.yo REPRODUCES the crash
context: /tmp/yo-self-binNN compile ... --emit-c then instrument +
run `check /tmp/t1.yo`).

8-STATE (corrected censuses + next probe): per-fn-windowed census of
stage2-v24 shows only ~44 GENUINE un-dup'd `return expr;` sites (the
earlier 350 number was a 1-line-window artifact — most incrs sit
~10-40 lines above their return, past the drop switches). 13 of the
44 are in evaluate_match (yo_id_269822; e.g. stage2-v24.c:96379 — a
mid-body `return(expr)` after a matched_type reassignment region).
Same fn has OTHER returns WITH the dup → per-return-site variance in
the arm-begin tail-ownership attach (BT2 conditions: var found /
not-consumed / ty_ok at THAT return's eval). The RET probe confirmed
the return EMITTER consumes dups whenever attached (63/63 in match.yo
single-file, which reproduces the miss pattern in ~30 s:
`/tmp/yo-self-binNN compile yo-self/evaluator/exprs/match.yo --emit-c`
then the per-fn census script). NEXT: extend the BT2 probe to log
per-return-site expr ids + failing condition during the match.yo
single-file compile, map missing ids to match.yo source lines, fix
the attach condition that fails for those sites. The doomed t1 object
(args element) is consistent with its arg's eval path returning bare
through one of these evaluate_match returns.

DRAIN WORKFLOW (repeatable, ~30 min/iteration):
a. lldb -b with DYLD_INSERT_LIBRARIES=libgmalloc.dylib +
MallocStackLogging=full on /tmp/s2vNN `check /tmp/t1.yo`;
at fault run malloc_history <pid> $x0 → ALLOC/FREE stacks → fn ids.
b. Identify ids via `grep 'static inline.*yo_id_N(' stage2-vNN.c`
(signature → yo-self source fn).
c. clang -O2 -g the stage2 .c, `image lookup -a <addr>` → exact C line
of the extra drop / missing dup; read the emitted shape.
d. Compare with the TS reference emission of the same source fn
(/tmp/s1-ref-v3.c) — find the missing \_\_\_dup / extra decr.
e. Fix STAGE-1's emission (yo-self/codegen/...) or the evaluator mark —
match.yo generate_case_body and cond.yo \_emit_value_arm are the
proven drift-safe templates (stale eval-temp → dup the GENERATED
declared temp instead of the recorded atom name).
f. Gates: corpus 115/115 DIFF 0 + check ./std 153/153 → commit →
re-emit stage-2 → clang (0 errors) → t1.yo again.

PREVIOUS FRONTIER NOTE (stage2-v18): stage-2 emit is
now FAST (72 s, was 45 min), deterministic (×2 byte-identical), clang -O2
0 errors (the v17 Bucket GC-tracer type-identity collision is FIXED via
type_key structural fallback, commit 5e75a87ea). The /tmp/t1.yo repro
still dies rc=133 — NEW PIN (gmalloc + MallocStackLogging +
malloc_history at fault): crash is **yo_gc_trial_delete_visitor walking
**yo_traverse**\_yo_t59 (t59 = ExprInfo) — the GC visits `obj->env` whose
112-byte Environment was ALLOCATED by new_expr_info→clone_env
(yo_id_224310→yo_id_222750) under a sub-evaluation (yo_id_249280) of
**evaluate_function_call** (yo_id_264748, calls/function.yo), and FREED
by an inlined decr chain INSIDE evaluate_function_call itself
(yo_id_264748+~0xC2xx, direct malloc_zone_free) while the ExprInfo table
still references the info. Same over-release class as the fixed env_mut
alias, different site: stage-1's emission of function.yo drops an
ExprInfo-held env at net −1. GC disable (YO_GC_THRESHOLD=0) does NOT
avoid it — the full-scan trigger in **yo_gc_register keys on
\_\_yo_gc_full_threshold, not the env-set threshold (faithful to TS; the
GC is only the detector). Next: clang -g build of stage2-v18.c →
malloc_history under the -g binary → atos the FREE site to the exact C
line → map to the function.yo construct stage-1 mis-emits, then fix the
STAGE-1 (yo-self codegen) RC emission for that shape.

ROOT CAUSE OF THE expr_info.yo UAF PINNED AND FIXED (2026-07-11 second
session): NOT the ExprInfo table at all — the freed object was the module
**Environment**. malloc_history under gmalloc + MallocStackLogging (lldb
`script` + `platform shell malloc_history <pid> $x28` at the fault) showed
ALLOC by `Environment.new` (yo_id_20142, 112 bytes, from the check driver)
and FREE inside the stage-2 emission of **evaluate_trait_type**
(yo_id_283186) invoked from evaluate_expression_raw while
evaluate_initialization_assignment evaluated a prelude `X :: trait(...)`
rhs. The stage-2 emission binds `(env_mut : Environment) = env` as a PLAIN
ALIAS (`__yo_t60* env_mut = env;` — no dup) yet still emits the scope-end
`__yo_decr_rc(env_mut)` — net −1 on the caller's env per call. The TS
reference emission has `env_mut = ___dup(env)` at the same site.

Evaluator divergence (the fix, in yo-self/evaluator/exprs/assignment.yo):
the atom/typed-binding `=` path never ported assignment.ts:305-323
(`lhsConsumedByRhs`, `requireExprNotConsumed(rhs)`,
`setExprAsNeedsToCallDup(rhs)` + env re-read) nor the ts:759-800 ExprInfo
tail (3-branch: init → unit; lhs-consumed → unit; real reassignment →
old-value info + attach_temp_variable_to_expr so codegen saves+drops the
old value). The codegen side (codegen/exprs/assignment.yo) was already
complete — it honors needs_to_call_dup via emit_deferred_dup_or_code and
ei.variable_name via the save-old-value temp; only the evaluator never
marked the rhs. Every `(x : T) = param` / `x = rhs` in the whole compiler
(env_mut bindings in trait.yo etc.) was a net-release of the RHS object.
Corpus regression test: tests/codegen-bootstrap/param_alias_binding.yo
(pre-fix stage-1-emitted binary prints `5 5 ` — "hello" freed — instead of
`5 5 5 hello`).

Remaining known port gaps on the same TS region (deferred, corpus-green):
assignment.ts:716 generates a NEW variable id on reassignment ("dup calls
on the old ID won't be matched with drop calls on the new ID") — yo-self
keeps `id : updated_variable.id`; assignment.ts:717-744
findRcValueOwnerRelationship / isOwningTheSameRcValueAs shared-ownership
tracking on reassignment is not ported (yo-self attach_temp_variable_to_expr
takes no third argument). PERF NOTE: the dup-on-store + temp-attach port
made stage-1 evaluation of yo-self markedly slower (stage-2 emit went from
~5 min to 45+ min; `sample` shows 85% in \_\_yo_decr_rc under
\_schedule_scope_end_drops → set_variable_as_consumed →
update_existing_variable String-id compares) — more owned temps per frame
× linear env scans. Faithful (TS attaches the same temps; TS comptime
`while` unrolling clones the body per iteration in BOTH compilers, so
counts match) but the env-scan cost is yo-self's (task #78 territory).
Quantified: `check yo-self/tests/expr_traversal.test.yo` went 26.7 s →

> 16 min (aborted); every String== / ArrayList(ref-struct).get() in the
> env scans pays an incr/decr pair, so the extra per-assignment scans
> (lhs_consumed_by_rhs lookup + attach lookups + one \_\_\_drop eval per RC
> temp) multiply into ~40x. PERF ROOT PINNED AND FIXED (2026-07-11 third
> session): `sample` of the live check showed ~88% of the worker inside
> `_schedule_scope_end_drops → evaluate_drop → set_variable_as_consumed →
update_existing_variable` — and that write-back is a PURE NO-OP in
> yo-self: `variable` comes from get_variables_from_env which returns the
> env's actual Variable REFS (Variable is reference-semantics), so
> `(new_var : Variable) = variable; new_var.consumed_at_token = ...`
> already mutates the env's object in place; the subsequent
> update_existing_variable full-env scan copied the object's fields onto
> itself. TS needs the write-back because its `{...variable}` spread makes
> a COPY — the alias port didn't. Landed (semantics-neutral): consumed-at
> marking mutates in place at consume.yo + utils.yo (2 sites), dropping the
> scan on the hot path entirely; update_existing_variable also early-exits
> after the unique-id match for its remaining REAL callers (assignment /
> va_start / synthesizer construct genuinely new Variables and keep the
> write-back).

Known REMAINING (separate, leak-class, non-crashing) divergences found by
the ExprInfo RC event-stream diff of yo_id_236636 vs the TS reference
emission of evaluate_initialization_assignment: stage-2 never emits the
normal-path scope-end drops for `actual_lhs_info`/`ali_after`/`ali_final`/
`lhs_info`/`expr_info` locals and the Option(ExprInfo) get() temps (TS
drops all of them), and the property-assignment save-old-value temps
(\_347666 etc.) are dropped only on early-return paths. Leaks, not UAFs.

PARTIALLY RESOLVED (2026-07-11, commit 5a5d28d15) — the sandbox-prelude
crash is FIXED: method-call unwind coverage (codegen method branch +
evaluator temp attach, TS function.ts:2263) and the multi-statement
fn-body TAIL deferred-dup port (generation.ts:1699-1754; tail temp
declared via get_variable_type_string). The stage-2 binary now handles
/tmp/s2box exactly like stage-1 (graceful "Variable foo not found",
rc=0), evaluates the REAL std/prelude.yo (trivial file check rc=0), and
its emission is deterministic (stage-2 emit ×2 byte-identical).

REMAINING (next frontier): the full self-compile still dies — stage-3
emit rc=133 (SIGTRAP malloc abort). Bisect: `check yo-self/token.yo`
rc=0, `check yo-self/expr_info.yo` rc=133, `check yo-self/parser.yo`
rc=133. Smallest repro: YO_MAIN_STACK_MB=16384 /tmp/s2v16 check
yo-self/expr_info.yo (heap-corruption abort). Guard-malloc pin
(DYLD_INSERT_LIBRARIES=/usr/lib/libgmalloc.dylib under lldb): first bad
access inside the stage-2 emission of **evaluate_initialization_assignment**
(yo_id_236636 in /tmp/stage2-v16.c, offset +3264) — reading freed memory
while evaluating expr_info.yo's top-level `::`/`:=` bindings. REFINED PIN (gmalloc + disassembly): the faulting sequence inside
yo_id_236636 (evaluate_initialization_assignment) is
`temp = yo_id_224488(table, id); if (temp.tag == SOME) { dup(temp.value->field...) }`
where **yo_id_224488 = expr_info_table_get** — the table returns an
ExprInfo whose memory is FREED (guarded page). I.e. the stage-2 binary
over-releases an ExprInfo the table still references — the ExprInfo-table
UAF class (see memory yo-self-macro-dispatch-corruption-fixed for the
previous instance) — but this time in STAGE-1'S EMISSION of the
evaluator's own table/dup code.

Minimal repro (5s, no rebuild): any nontrivial import —
printf 'open(import("std/fmt"));\nx :: "p";\nexport(x);\n' > /tmp/t.yo
YO_MAIN_STACK_MB=16384 /tmp/s2v16 check /tmp/t.yo # rc=133
Under gmalloc the first bad access is deterministic at yo_id_236636+3264.
NOTE: content bisection is UNRELIABLE for this bug (UAF visibility depends
on allocation patterns — some richer probes "pass" while corrupted).

VERIFIED: the emitted HashMap.get for the ExprInfo table (yo_id_12570…,
called by expr_info_table_get) is RC-correct — net +1 (double-incr +
single-decr of bucket.value; the earlier get()-dup fixes reached it). So
the table-held ExprInfo is freed by a DIFFERENT over-release: an ExprInfo
alias somewhere in the emitted evaluator is dropped without a matching
dup (candidates: expr_info_table_set overwrite dropping while borrowed
aliases live, begin.yo's last_info alias flow, or scope-end drops of
`info` locals that were bound WITHOUT the +1 in some emission shape).

FURTHER VERIFIED: emitted HashMap.set (yo*id_12568…) stores the ExprInfo
at net **+2** (incr(value) + temp_dup incr; wrapper drops the displaced
old entry correctly) — over-retained, so the premature free does NOT come
through table_set/get. Remaining suspects, in order: (1) an ArrayList
field SHARED between two ExprInfos without dup (e.g. begin.yo's
shared-id clobber carries: `out_info.deferred_dup_expressions =
last_info.deferred_dup_expressions`, runtime_arg_exprs_in_order,
index*\* carries) — both infos' disposals drop the same list →
double-free → heap corruption; (2) the ~15 missing dups in stage-2's
evaluate_initialization_assignment vs TS-ref (62 vs 77 dups; TS also has
2672 vs 127 drops from full escape-path cleanup — stage-2's thinner
escape cleanup is a separate fidelity gap). Fresh TS reference:
/tmp/s1-ref-v3.c.

Next: find which stage-2-emitted drop releases a table-held ExprInfo —
candidates: (a) the arm-dup/arm-drop pairing around expr_info_table_get
match arms (nullable-ptr Option(ExprInfo) cleanup dropping the TABLE's
reference), (b) an over-drop in expr_info_table_set replacing entries,
(c) interaction with today's attach_temp_variable_to_expr addition
(more table-held infos mutated). Differential: extract the table-get
match-arm cleanup shape from /tmp/stage2-v16.c vs a FRESH TS reference
emission (regenerate s1-ref: ./yo-cli compile yo-self/main.yo --emit-c
--skip-c-compiler -o /tmp/s1-ref-v3).

ORIGINAL ISSUE (2026-07-10): Current stage-2 runtime frontier after the
ref-struct-get() dup chain and the frontend fidelity fixes landed
(6e2313264, 66326af85).

## Symptom

The stage-2 binary (built from /tmp/stage2-v12.c, clang -O2, 0 errors)
SIGSEGVs evaluating the 6-comment sandbox prelude (/tmp/s2box):

- -O0 build: NULL `rhs_evaled` reaches `ast_expr_is_fn_call` in the
  assignment control-flow validator after a swallowed "Variable foo not
  found" throw.
- -O2 build: UAF — crash address is ASCII (`"check: p"`) — a freed
  object's memory reused by a println buffer, read as a pointer, inside
  `evaluate_anonymous_module_begin_exprs`.

Stage-1 (TS-compiled) handles the same input gracefully.

## Root cause (quantified)

`grep -c __yo_effect_escaped`:

- TS-emitted reference (/tmp/s1-ref-v2.c): **32,911**
- stage-2 (/tmp/stage2-v12.c): **3,216**

yo-self codegen emits the post-call unwind check at ~10% of the sites TS
does. Concrete example — `parse()` (parser.yo:1448):

- TS emission (fn_yodb87f9d4_id_511_parse): BOTH calls (`Parser.new`,
  `p.get_program(exn)`) wrapped in
  `__yo_effect_escaped = 0; call; if (__yo_effect_escaped) { drops; return {0}; }`.
- stage-2 emission (yo_id_228309 / yo_id_236592): NEITHER call has any
  check — after a throw deep inside, execution CONTINUES with a garbage
  result (NULL AstExpr at -O0; UAF at -O2).

## Why the coverage differs

- TS computes `callMayUnwind` (other-fn-call.ts:1205) and calls
  `emitEffectUnwindCheck` from **6 sites** (other-fn-call.ts:1384, 1517,
  1702, 1718, 1808 + functions/generation) — covering void calls,
  temp-var calls, and METHOD calls.
- yo-self computes `ou_may_unwind` (`_call_may_unwind`,
  other_fn_call.yo:709 — the predicate itself looks faithful;
  `type_is_control_bound` DOES recurse into struct fields so
  `exn : Exception` qualifies) but consults it on only ONE call-shape
  branch (other_fn_call.yo:1406 → emissions at 1433/1471/1592/1622).
  METHOD-call emission paths (property-access callees like
  `Parser.new(...)`, `p.get_program(exn)` — the dominant call shape in
  yo-self source) never compute or emit the check.

## Fix plan (faithful port)

Map each TS emitEffectUnwindCheck site to the corresponding yo-self
emitter branch and add the missing computation + emission:

1. other-fn-call.ts:1384 (void-result call, gated on callMayUnwind) and
   :1517 (temp-var-result call, same gate) — in TS these cover ORDINARY
   METHOD CALLS too, because TS compiles a method call through the same
   main call path (receiver as first arg). yo-self's METHOD-call emission
   branch is separate and has NO ou_may_unwind computation/emission —
   that's the dominant missing coverage (`Parser.new(...)`,
   `p.get_program(exn)`).
2. other-fn-call.ts:1702 (direct local-handler atom call, install-point
   check via isHandlerAtomBoundLocally) and :1718 (`exn.throw(...)`
   effect-record-field call, propagate) ↔ verify yo-self equivalents.
3. other-fn-call.ts:1808 ↔ verify.
4. functions/generation.ts site ↔ verify.

The `_call_may_unwind` inputs at the method branch need the resolved
method Func type's param types (g_method_callee_types side-table has the
resolved method type when ExprInfo lacks it).

Gates after: corpus 112/112 (the io_async files are the unwind-sensitive
ones), check ./std 153/153, stage-2 emit ×2 byte-identical, clang 0
errors, sandbox `/tmp/s2box` check t.yo must print the same
"Variable foo not found" error as stage-1 (no SIGSEGV), real
`std/prelude.yo` must parse >0 exprs. Then stage-3 emit + fixpoint diff.

## Repro

```bash
./yo-cli compile yo-self/main.yo --release -o /tmp/yo-self-bin
YO_MAIN_STACK_MB=16384 /tmp/yo-self-bin compile yo-self/main.yo --emit-c --skip-c-compiler -o /tmp/stage2
clang -std=c11 -w -O2 /tmp/stage2.c -o /tmp/s2
cd /tmp/s2box && /tmp/s2 check t.yo   # rc=139 today; must match stage-1
```
