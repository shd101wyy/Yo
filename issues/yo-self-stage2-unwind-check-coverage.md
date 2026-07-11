# yo-self codegen: effect-unwind checks missing on method-call emission paths (stage-2 crash + fixpoint blocker)

## Status

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
