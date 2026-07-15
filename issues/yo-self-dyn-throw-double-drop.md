# yo-self: pre-existing double-drop of the dyn-consumed error temp on escape paths (stage-2 startup crash)

**Status:** root-caused 2026-07-15; fix pending. **This is the actual stage-2
runtime blocker** — it PREDATES the 2026-07-15 session work (verified: a clean
`7d6b0385a` baseline s1→stage2.c→s2 build crashes identically TODAY, rc=139,
on `s2 check tests/codegen-bootstrap/empty_main.yo`).

## The bug (Guard Malloc + lldb, deterministic)

Crash: `__yo_decr_rc(ptr)` reads a FREED page (double-drop; Guard Malloc traps
at the second decrement). Site (`stage2l.c` ~493546, fn `yo_id_292354` = the
`unquote` evaluator, but the PATTERN is every `exn.throw(dyn(format_error_message(...)))`
in the compiler — i.e. every throw site):

```c
__yo_t2   t317 = String.from("unquote: argument must have a compile-time value");
__yo_t206* t318 = format_error_message(tok, t317, false, None);
__yo_t774  t319 = { .data = t318, .vtable = ... };          // dyn fat pointer
__yo_effect_escaped = 0;
__yo_t26*  t320 = exn.throw(t319);
if (__yo_effect_escaped) {
  // Drop local variables before early return
  ... drop t317 ...            // ok
  __yo_decr_rc((void*)(t318));        // ← WRONG: t318 was consumed into t319
  __yo_decr_rc((void*)(t319).data);   // ← .data == t318 → DOUBLE DROP → UAF
  ...
}
```

No compensating dup is emitted (Guard Malloc proves rc hits 0 at the first
decrement). The throw path fires constantly during def-time trial evaluation →
heap corruption early in any nontrivial run. Whether it crashes (segv /
malloc-freelist trap / GC tracked-list cycle spin) depends on allocator layout
luck — which is why it presented as a heisenbug that ANY emission change
appeared to "cause".

## TS oracle (same site, `stage1-ref.c` ~385453)

TS's escape list after the throw drops the **dyn once** (`___drop(dyn_temp)`)
and **never the raw `format_error_message` result** — the inner temp's pending
drop is suppressed/never scheduled once the value is consumed by the dyn
construction. TS `generateDyn` (src/codegen/exprs/dyn.ts:115) documents the
invariant: _either_ the inner value is dup'd (then both the dyn drop and the
scope drop are correct) _or_ it is moved (then only the dyn's drop exists).
yo-self emits no dup but keeps BOTH drops.

Where the two sides diverge (to pin down during the fix): the inner temp's
deferred drop is scheduled by `attach_temp_variable_to_expr` on the call
result; TS suppresses it on escape paths via its env-path consumed filter
(`variableWasConsumedBeforeCleanupPoint`) and/or never re-schedules it after
the dyn consumes the value. yo-self's escape checkpoint uses
`skip_env_check=true` → the `!use_env` branch of `_keep_pending_drop`
(return.yo), whose consumed check via `_get_deferred_drop_target_variable`
apparently does not see a `consumed_at_token` for this temp — either yo-self's
dyn evaluation never marks the inner temp consumed, or the marking/lookup
misses (end-of-scope env / name-resolution).

## Fallout of this discovery (bisect-matrix invalidation)

The 2026-07-15 session bisected s2 crashes across ~8 variants and blamed, in
turn: the `;`-form uninit-decl recording, the type*key Pointer branch, the
specialization-signature split (both type_key and state-free variants), the
emitter DECL_RE refactor, and the drop gates. **All those verdicts are
invalidated**: every variant crashed because the baseline crashes. Components
reverted on that evidence (helper.yo `\_id*`signature split, type_key Pointer
branch, emitter`;`-form recording) should be re-evaluated on their own merits
AFTER this double-drop is fixed — with `s2 check`health as a then-meaningful
gate. (The`;`-form uninit-decl recording remains independently dangerous per
the garbage-drop analysis in emitter.yo and the historical "uninit-`;`-decl →
s2 startup crash" note — keep `=`-only unless zero-init lands.)

Kept regardless (validated by deterministic gates, not runtime luck):

- The HashMap same-key-overwrite leak fix (hmap repro `tracked=101→2`, == TS).
- The scope-stack drop gates (stage-2 self-emit clang errors 84→0).
- The gc.yo signature-consistent traverse (kills the 3 `.key.tag on size_t`
  errors deterministically regardless of registration order; see
  issues/yo-self-specialization-signature-type-identity.md).

## Repro / validate

- Fast crash repro: build any stage2.c (baseline or current), `clang -O2`,
  `s2 check tests/codegen-bootstrap/empty_main.yo` → rc 139/133/124 within
  seconds (layout-dependent flavor).
- Guard Malloc pins the exact site:
  `lldb -o "env DYLD_INSERT_LIBRARIES=/usr/lib/libgmalloc.dylib" -o "env YO_MAIN_STACK_MB=16384" -o run -k "bt 12" /tmp/s2l -- check tests/codegen-bootstrap/empty_main.yo`
  (build s2l from an `--allocator libc` emission at `-O0 -g`).
- Fix gate: the escape drop list after `exn.throw(dyn(X))` must contain
  EITHER a dup of X + both drops, OR only the dyn drop (TS emits the latter);
  then s2 `check` runs clean, and the corpus needs a new
  `tests/codegen-bootstrap/` case exercising throw-dyn + escape + Gc counts.

## Fix (landed 2026-07-15)

`evaluator/values/dyn.yo` now calls `set_expr_as_needs_to_call_dup` on the
final inner value expr in BOTH evaluation paths (non-executing `ne_final_expr`

- executing `final_value_expr_ex`), mirroring TS dyn.ts:321. Verified:
  `/tmp/dd.yo` yo-self-compiled prints `done tracked=0` rc=0 (== TS); the
  stage-2 emission's throw sites now drop only the dyn's `.data` (raw payload
  temp drop gone — TS parity); corpus test added as
  `tests/codegen-bootstrap/dyn_throw_double_drop.yo`.

## Round 2 — a SECOND pre-existing corruption class remains (s2 still rc=139)

With the dyn fix in, Guard Malloc now traps on `__yo_incr_rc` (a DUP) of a
FREED page inside an `ArrayList(...).get(index)` specialization called from
`evaluate_function_parameter` (yo_id_246541, stage2l.c:131855) ←
`_evaluate_function_parameters` loop (yo_id_248305) ←
`synthesize_function_type_from_tokens` (yo_id_249345). I.e. a param-expr list
(or its element) is freed while still reachable — ANOTHER over-drop/missing-dup
divergence, hit during every function-type synthesis. Hunt method that worked
for round 1 (use it again): Guard Malloc bt → map the C site → compare the
same function against the TS oracle emission (/tmp/stage1-ref.c, locate via
distinctive string constants) → build a seconds-fast standalone repro
(TS-compiled vs yo-self-compiled behavior diff) → find the missing
consumption/dup in the yo-self evaluator → fix → re-run
dd.yo + hmap + clang-0 + s2-health gates.

### Round-2 site detail (for the next session)

The freed object is an **AstExpr node**: `evaluate_function_parameter`
(evaluator/types/function.yo; C site stage2l.c:131855) does
`_fn_call_args(expr_mut).get(1)` — reading the param expr's TYPE sub-expression
(`label : Type` → args[1]) — and `ArrayList.get`'s element dup
(`__yo_incr_rc`) traps: the CHILD NODE is already freed while its parent
`expr_mut` still references it. So something over-dropped an AST subtree that
is revisited later — prime suspect: `synthesize_function_type_from_tokens`
makes MULTIPLE passes over the same `param_exprs` (pass 1 forall, pass 2
implicit/using, where-clause pass), and an earlier pass's evaluation drops
node(s) a later pass re-reads. Compare with TS `synthesizeFunctionTypeFromTokens`
(no drops — GC) and find which yo-self eval path drops an arg node it only
borrows. Crash fires during PRELUDE eval → forall/using-heavy signatures;
build the repro from a forall+using fn signature shape.

### Round-2 repro attempt — CORRECTION (2026-07-15 late)

The earlier "REPRO CAPTURED rc=134" claim was MISATTRIBUTED: the rc=134 was
**s1 itself aborting while COMPILING** the file (the `compile && run; echo rc`
chain made the compile's exit code look like the program's — s1 produced NO
binary). Two real findings from the attempt:

1. The match-arm-payload reassignment shape (`(cur : Node) = parent;
match(opt, .Some(child) => { cur = child; })`) is emitted CORRECTLY by
   yo-self (manual RC accounting balanced; runs clean incl. under Guard
   Malloc). That hypothesis for round 2 is DEAD.
2. NEW, separate bug: s1 ABORTS (SIGABRT, silent, after "prelude OK") while
   compiling a match arm containing `(-(i32(1)))` (unary negation of a call
   result in arm position; `i32(-1)` in the same position works, though TS
   REJECTS `i32(-1)` — a frontend divergence — and accepts `(-(i32(1)))`).
   Repro: /tmp/r3.yo with `.None => (-(i32(1)))`. Also: the emitted C for a
   negation helper types its temp `void*` (`void* t = (-(self)); return t;`,
   int↔ptr conversion — clang hard-errors at default settings, builds only
   under the driver's flags). File under a separate hunt; NOT the round-2
   blocker (s1 compiles yo-self/main.yo fine — the shape is corner-case).

Round 2 therefore returns to the direct lead: the s2 Guard Malloc stack
(freed AstExpr child read via `args.get(1)` in `evaluate_function_parameter`
during s2's PRELUDE eval). Next move: MallocStackLogging + Guard Malloc on
/tmp/s2l, and at the trap run `malloc_history <pid> <freed addr>` — the FREE
stack names the over-dropping site directly (the reader stack alone cannot).

### Round-2 BREAKTHROUGH: complete RC op history of the victim (2026-07-15 night)

Tooling that cracked it (reusable; scripts inline below): patch stage2l.c's
`__yo_incr_rc`/`__yo_decr_rc` to record a per-object ring of
`(op, __builtin_return_address(0))` pairs (direct-mapped 1M-entry table,
~270 MB BSS, near-zero overhead at -O0 since incr/decr are real calls), plus a
`__free_log` ring at the final-decr sites; build `-O0 -g` from the
`--allocator libc` emission; run under Guard Malloc in lldb; at the UAF trap
call `expr (void)__oplog_dump((void*)<fault addr>)`; resolve `ra` values with
`atos -o <bin>`. Patched build: /tmp/s2lp2 (from /tmp/stage2l_p2.c).

Victim = an identifier ATOM type-expr (args[1] of a `label : Type` param).
Full history (born rc=1, parent AST owns):

```
[0] + evaluate_function_parameter args.get(1) elem dup   (561605)  rc=2
[1] + extract_comptime_parameter_info get(0) dup         (282358)  rc=3
[2] + extract_comptime_parameter_info get(1) dup         (282541)  rc=4
[3] - extract early-return/scope drop                    (282558)  rc=3
[4] - extract early-return/scope drop                    (282563)  rc=2   [1-4 balanced]
[5] - `evaluated` scope drop in yo_id_246393             (313225)  rc=1   ← THE THEFT
[6] - pass-3 ct_info.type_expr tail drop                 (507885)  rc=0 → freed
[7] + (the UAF trap: pass-5 evaluate_function_parameter re-reads args[1])
```

The unmatched decr is [5]: `evaluated := evaluate_expression_raw(expr, …)`
followed by `evaluated`'s scope-end drop (yo_id_246393 =
`_get_expr_type`/`_eval_and_update_env`, evaluator/types/function.yo:464/511)
— but the eval-dispatch RETURN CHAIN contributed **no `+`** for this node
(no incr with an evaluator-return `ra` appears in the history). For an
identifier atom, evaluation returns the INPUT node (borrowed param) through:
`evaluate_identifier_and_operator` → `_evaluate_expression` (cond arm,
exprs/\_expr.yo:384+) → `_evaluate_expression_raw_wrapper` (returns local) →
fn-pointer dispatch `evaluate_expression_raw` (match-arm tail call). This is
the **borrowed-tail-return-dup class (commit 5a5d28d15) with a missed path**:
somewhere in that chain a borrowed-param return escapes without the +1 dup,
so every `evaluated := evaluate_expression_raw(...)` + scope-drop pair
over-drops the node by one. The same shape likely fires constantly; which
node DIES first depends on how many compensating dups surround it — this
victim had few.

NEXT SESSION: inspect the emitted C of `evaluate_identifier_and_operator`'s
return paths (and each hop up the chain) in /tmp/stage2l_p2.c for the missing
`__yo_incr_rc` before `return expr`-shaped tails; compare with a KNOWN-dup'd
sibling (e.g. a fn the 5a5d28d15 fix demonstrably covers); fix the missed
shape in yo-self codegen's return handling (return.yo deferred-dup /
borrowed-return detection — likely the fn-POINTER-dispatch tail or the
cond-arm tail is the uncovered shape); then gates (hmap=2, dd=0, clang-0,
s2 check ×3) + fixpoint chain.

### Round-2 continued (2026-07-15 late night): eval marks, C still bare — the loss is between

RVPROBE2 (begin.yo tail-ownership block, since removed): all 520 firings for
return-arg atoms named `expr` during the main.yo emit report `ty_ok=1 own=0`
→ the DUP branch (`set_expr_as_needs_to_call_dup`) is TAKEN at eval. A
value-gate flaw was found and fixed in `set_expr_as_needs_to_call_dup`
(evaluator/utils.yo): `has_concrete_value` now also requires
`!type_contains_rc_type(ei.ty)` — a concrete-but-NOT-inlinable value
(AstExprVal in def-time passes) previously declined the dup while codegen
still emitted the variable name (committed; correct in principle; all repros

- clang-0 stay green). BUT the emission still contains 404 bare
  `return expr;` sites (53 dup'd) and s2 still crashes rc=139 ×3 — the dup mark
  is being made and then LOST (or declined on another path):

Candidates for the NEXT probe round (in order):

1. Probe INSIDE set_expr_as_needs_to_call_dup: log for return-arg atoms named
   "expr" which exit is taken (concrete-value return / non-RC return /
   temp-consume return / dup-stored) + the expr id — confirm the mark is
   stored on the FINAL pass.
2. Probe generate_return (codegen/exprs/return.yo:518): log arg_has_dup per
   site — if false where eval stored, the table entry was OVERWRITTEN by a
   later eval pass whose tail-ownership did NOT re-mark (check whether the
   final def-time pass routes through a begin path that skips the
   tail-ownership block — e.g. control-flow-carrying arms).
3. Diff one site end-to-end: pick type_fns.yo:114's return(expr), log its
   ast_expr_id at eval-mark time and dump the table entry at codegen time.

Reusable tooling: RVPROBE pattern (begin.yo, removed after use), the oplog
patch (issues section above), Guard Malloc + lldb -k recipe.

### Round-2, probe cycle 3 (2026-07-15 night): the loss is in the DUP EMITTER

Correlated probes (DUPSTORE at set_expr_as_needs_to_call_dup's store; RETDUP
at generate_return's arg_has_dup; TAILDUP at generation.yo's body-tail gate)
during the main.yo emit: **every probed site has the mark and enters the dup
path** (RETDUP 335/335 has=1; TAILDUP 123/123 has=1; DUPSTORE 539). Yet a
40-line-window audit of the emission still shows **210 of 457** `return expr;`
sites with NO `__yo_incr_rc((void*)(expr))` anywhere nearby (247 are fine —
the first 4-line audit was a window artifact). Since the emitters call
`generate_deferred_dup_expressions(arg/last_expr)` on all these sites, the
suppression is INSIDE the dup emitter chain (codegen/exprs/drop_dup.yo:766+):
either (a) the undeclared-minted-temp gate fires because the EVALUATED
`___dup(expr)` call's `get_deferred_dup_target_atom_name` resolves to an
eval-minted RESULT temp that was never declared in C (rather than to the
source atom "expr"), or (b) `_call_generate_expr(dup_expr)` returns an empty
string on some path. NEXT PROBE (single 13-min cycle): in
generate_deferred_dup_expressions log, for each dup_expr, the target-atom
name, the gate verdict, and `code.len()` — during the main.yo emit, filtered
to targets containing "expr". Then fix: when the gate suppresses but the dup's
UNDERLYING source is a declared name / an inline-incr-able ref handle, emit
the dup against the source (mirroring TS, which always dups via the source
temp it declares); or make eval not mint an undeclared result temp for these.

Status: value-gate fix committed (78bc87464) and kept. Probes removed from
utils.yo / return.yo / generation.yo after each cycle. 210 missing dups =
~ the eval-dispatch under-count that kills AST children (round-2 UAF).

### Round-2 ROOT CAUSE FOUND + FIXED (2026-07-15, cycle 4): cond BEGIN-ARM final-expr dup omitted

The probe-cycle-3 conclusion ("210 dups suppressed inside
generate_deferred_dup_expressions") was WRONG — a 40-line-window audit
artifact. A C-comment probe (`/* DUPX len=… tgt=… */` emitted at every dup
site — much better than eprintln: lands exactly at the site, survives in the
.c, and dodges an evaluator "Frame level N has different number of values"
quirk that killed every eprintln-probe build) proved the dup emitter emits
ALL 5035 dups it is handed (0 empty, 1 legitimately gated). All 7
`return expr;` sites in evaluate_identifier_and_operator carry the incr; the
whole eval-dispatch chain (evaluate_identifier_and_operator →
\_evaluate_expression cond arm → \_evaluate_expression_raw_wrapper →
fn-pointer dispatch) transfers ownership correctly.

The REAL victim (fresh oplog on the current stage2, Guard Malloc +
`expr (void)__oplog_dump(ptr)` at the trap, atos-resolved):
`*(Array(T, N))` — the type expr of `comptime(self) : *(Array(T, N))` in
`__yo_comptime_array_index`'s extern signature (std/prelude.yo:310:52,
identified by reading the live parent expr's token row/col in lldb). NOT an
identifier atom — a `*` pointer-type FN CALL.

History: [0] + args.get(1) elem dup (evaluate_function_parameter) — matched
by [6] - \_evaluate_function_parameters tail drop; [1]-[4] balanced
(extract_comptime_parameter_info); [5] - `evaluated` scope drop in
\_eval_and_update_env — UNMATCHED → parent's ref stolen → next param pass
reads the freed node (the deterministic rc=139).

Root cause: `evaluate_raw_pointer_call` (evaluator/calls/pointer.yo) returns
the borrowed param `expr` as the tail of a cond BEGIN-BLOCK arm
(`is_type_value(...) => { …; expr }`). The evaluator marks the dup, but
codegen's `_emit_begin_arm` (codegen/exprs/cond.yo) emitted the final expr
with NO deferred-dup handling — `temp = expr;` bare — while `_emit_value_arm`
(non-begin arms) had the full port. TS cond.ts:293-365 has the dup block in
BOTH paths. Emitted C (pre-fix): `_file____User_temp_453581 = expr;` with
zero incr in the whole function.

Fix: ported the TS begin-arm final-expr deferred-dup block into
`_emit_begin_arm` (declare the eval temp unless inout-atom/self-named →
`generate_deferred_dup_expressions(final_expr)` → assign dup-result temp when
the dup call carries one, else assign the generated value). `if(c,a,b)`
lowers through the same cond emitter, so both are covered. Committed
8377998c1 + corpus test cond_begin_arm_borrowed_tail.yo. s2 crash MOVED past
prelude param synthesis into function-body eval → round 3.

### Round 3 (2026-07-15/16): borrowed FIELD return — two more missing-dup paths

Repro discovered via an rc()-assertion battery (/tmp/borrow_battery.yo, 7
borrowed-return shapes TS-vs-self): `return(p.inner)` and bare-tail
`(fn(p : Pair) -> Krate)(p.inner)` both emitted NO dup (TS rc 2/3, yo-self
1/1) — every borrowed-field-returning helper under-counts by one, the same
class as rounds 1-2 (the compiler source is full of them).

Hunt method (probe placement matters — the "Frame level N has different
number of values for different cases" executing-evaluator quirk kills
eprintln probes in begin.yo / property*access.yo / drop_dup.yo helpers, but
tolerates them in utils.yo, and C-comment probes via the emitter always
work): SETDUP exit-tagged probes in set_expr_as_needs_to_call_dup + ATTACH
own_req probes in attach_temp_variable_to_expr (both utils.yo, tok/row
tagged) + /* RETPROBE _/ + /_ DUPX GATED \_/ C-comment probes in codegen.

Two distinct root causes, both fixed:

1. EXPLICIT `return(p.inner)`: eval stored the dup mark (SETDUP stored,
   RETPROBE has_dup=1) but codegen's generate_return called
   generate_deferred_dup_expressions BEFORE emitting the arg temp's
   declaration — the dup emitter's undeclared-temp gate (drop_dup.yo:786+)
   silently suppressed the incr (`/* DUPX GATED tgt=temp */`). Fix: port of
   return.ts:556-598 — when the return arg carries BOTH variable_name and
   deferred dups, materialize `T argTemp = raw;` FIRST and register it in
   declared_c_var_names, then emit the dup. Same declared-name registration
   added to handle_func_call_deferred_dup (the implicit-return fn-call path).

2. BARE TAIL `(fn ...)(p.inner)`: the eval NEVER scheduled the dup —
   `wrap_body_in_begin` (expr.yo) narrowed the begin-wrap to bare-ATOM
   bodies only, so a bare field-access body skipped the begin-tail ownership
   pass entirely (probe: zero tail-block entries for the row). TS
   anonymous-function.ts:829 always routes bodies through
   evaluateBeginExpression. Fix: also wrap bare 2-arg `.` bodies (method
   calls are NOT 2-arg dots — untouched, preserving the io_async
   result-refine behavior that motivated the original narrowing). Plus: the
   begin-tail block now falls back to set_expr_as_needs_to_call_dup when the
   tail's recorded temp name is not visible in the live begin env (nrv==0 —
   snapshot-env threading can drop the registration; set_expr re-checks
   ownership against the recorded ei.env, so owning temps still consume).

Verified: battery 7/7 == TS; corpus test borrowed_field_return.yo ("2 3
done" both compilers); cond_begin_arm_borrowed_tail.yo still "2 3 3 done";
r4/r5/r6, dd tracked=0, hmap tracked=2 all green.

### Round 4 FIXED + Round 5 OPEN (2026-07-16): s2 `check` GREEN; `compile` heap corruption remains

Round 4 (committed 5f1af3622 + test 2da414512): the assignment save-old-value
temp was dropped on ESCAPE paths in addition to the local's scope drop
(`rhs = evaluate(rhs)` in evaluate_initialization_assignment; victim
`v :: variants.get(vi)` prelude:6608 comptime-fold). Fix:
`FunctionGenerationContext.current_assignment_save_temp` — set while
generating an assignment's RHS, checked in `_keep_pending_drop`. With it,
**`s2 check empty_main.yo` rc=0 ×3 — first fully-clean stage-2 run.**

Round 5 (OPEN): `s2 compile yo-self/main.yo` (the fixpoint input) still dies
— malloc freelist assert at -O2; under Guard Malloc the CYCLE-GC mark-gray
traversal reads a freed EvalValue still referenced by a live ExprInfo
(trap: `__yo_traverse___yo_t59` → `__yo_gc_mark_gray_visitor`, fault on a
freed `.value` Option payload). The final decr (freelog ra) is
evaluate_future_type's fn-end drop of the `elem_info.value` match-scrutinee
temp — but that site is BALANCED (dup at read + one drop per path; audited
in both stage2_p8.c and stage2_r4l_op.c) — the deficit is introduced
EARLIER on the same shared payload by some other site; the balanced drop
just happens to hit zero. The check-vs-compile difference is INPUT SIZE
(compile main.yo evaluates the whole compiler; check empty_main only the
prelude).

Tooling state (scratchpad/oplog_patch.py):

- freelog: append-only (freed ptr, dropper ra) ring at every RC-layer
  \_\_yo_free — collision-proof last-free attribution. WORKS.
- oplog (per-object op history): direct-mapped table gets clobbered under
  Guard Malloc even at 4M slots with murmur mixing; a traverse_fn identity
  filter (only log \_\_yo_t65) missed because specialized enum instantiations
  carry per-instantiation traverse symbols. Do NOT trust "1 op" dumps —
  they are collision resets.
- GC-off (YO_GC_THRESHOLD=0) + Guard Malloc OOM-kills on the main.yo
  compile; GC-off without gmalloc is the next best repro shape (direct
  reader trap instead of traversal trap, at the cost of address reuse).

NEXT (round 5): (a) rerun the freelog build WITHOUT Guard Malloc but with
YO_GC_THRESHOLD=0 and libc malloc: the first direct-read trap gives a real
reader bt, and \_\_freelog_find on the faulting address gives the last
dropper; (b) audit candidates: `ExprInfo.value` payload sharing across
expr_info_table_set overwrites (a fresh out_info REPLACING a table entry
whose old .value payload is still shared elsewhere — check the table-set
protocol vs TS), and the ctx save/restore field-swap protocol
(`old = ctx->expected_type; ctx->expected_type = X; ...; ctx->expected_type
= old;` — the restore/drop accounting); (c) probe rules learned: eprintln
probes build ONLY in utils.yo (inline `if(gate, eprintln((A + B)))`, no new
decls in match arms); a helper FN in utils.yo called from begin.yo works;
direct eprintln in begin.yo / property_access.yo / drop_dup.yo trips the
"Frame level N has different number of values" evaluator quirk; C-comment
probes via em.emit_string_line work anywhere in codegen; token row/col
tagging identifies AST nodes across eval passes (rows are 0-indexed).
