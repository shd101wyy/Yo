# yo-self stage-2 fixpoint — HANDOFF PLAN (remaining work)

**Goal:** drive the yo-self self-compile ("stage-2") clang errors to **0**, then make
the self-compiled `yo-self` binary's `test` subcommand pass `./tests` and
`./yo-self/tests` (tasks #69, #70).

**Current state: 27 stage-2 clang errors** (was 56; −29 total).

### Progress log

| Session    | Change                                                 | Δ            |
| ---------- | ------------------------------------------------------ | ------------ |
| Prior      | per-closure async result-type fix (`a675f54eb`)        | 56→44 (-12)  |
| 2026-07-06 | unwind double-return fix (`d0518c359`)                 | 44→42 (-2)   |
| 2026-07-06 | recur ref-param deref strip (`dd4473afc`)              | 42→39 (-3)   |
| 2026-07-07 | match arm frame-pop cleanup (`fabb2d9dd`)              | 39→35 (-4)   |
| 2026-07-08 | explicit (!=) in Eq(str)/Eq(String) (`9d2eb7d48`)      | 35→33 (-2\*) |
| 2026-07-08 | fieldless while-pop + loop scope markers (`395537d77`) | 33→27 (-6)   |

### Landed: Phase 4 match-arm frame-pop cleanup (−4)

`commit fabb2d9dd` — `yo-self/evaluator/exprs/match.yo`
Faithful port of TS `match.ts:485-493`. The yo-self match evaluator pushed
`match_arm_frame` per arm, evaluated the body, then popped from the LIVE env only.
The body's `ExprInfo.env` (a snapshot created inside `new_expr_info`) still carried
`match_arm_frame`. This leaked frame was later ingested via
`env.frames = bi.env.frames` (match.yo:2249), redirecting variable additions to the
wrong frame and misdirecting begin-block scope-end pop operations. The result: 9
loop-body variables' drops scheduled in the outer begin block instead of the loop
body, producing undeclared-identifier C errors.

Fix: after `env.pop_frame()` in all 4 arm branches (fieldless, wildcard/comptime,
literal, with-fields), also pop from `body_info.env` via `pop_env_frame`. For the
with-fields branch (which uses `while(env.frames.len() > base_frame_count)` to pop
multiple frames), apply the same while-loop to `body_info.env.frames`.

Validation: corpus 103/103 DIFF 0, undeclared identifiers 13→4 (−9), total 39→35 (−4).

### Landed: Phase 1 while-body frame-pop + C scope markers (−6)

`commit 395537d77` — `yo-self/evaluator/exprs/match.yo` + `yo-self/codegen/exprs/while_loop.yo`

**match.yo fix**: The fieldless arm (`_ => body`) used a single `env.pop_frame()`,
which pops the wrong frame when a leaked frame (e.g. unpopped begin frame from
the body's evaluate_begin_expression) is present. Changed to while-loop pop
`while(env.frames.len() > base_frame_count_fl)` (mirrors the with-fields
branch). Also changed `pop_env_frame(body_info_fl.env)` from single pop to
while-loop for symmetric robustness.

**while_loop.yo fix**: `generate_loop_body` emitted begin-block statements
flat without C scope markers. TS wraps them in `{ // begin block ... }`,
creating proper C scopes where local-variable drops clean up at the closing
`}`. Added matching scope markers to yo-self.

Net: undeclared 5→2 (−3, arg_expr + 2 temps fixed), total 33→27 (−6). The
remaining undeclared errors: `get_info` (closure capture codegen) + 1
remaining temp variable (likely from a different code path's frame leak).

### Landed: Phase 3 str→String overload fix (−2\*, merged with random-ID noise)

`commit 9d2eb7d48` — `std/string/string.yo`
The `(!=)` default body uses `Self.(==)(self, other)` which resolves to
`Eq(String).(==)` instead of `Eq(str).(==)` in yo-self's overload selection.
Added explicit `(!=)` methods in both `String, Eq(str)` and `str, Eq(String)`
impls, using the infix `==` operator (which dispatches correctly via the
infix path at function.yo:1315) instead of the dot-call `Self.(==)`.

Net: 33 errors (35 from prior fixpoint + 1 str→String fix − ~3 random-ID
noise). The count is approximate because random type IDs shift per
compilation. Corpus 103/103 DIFF 0.

### REVERTED: match arm classification fix (2026-07-08)

Attempted to re-classify `.Some(v) => body` from fieldless to with-fields (the
fieldless branch ignores destructured field values). Caused 101 SELF-FAIL on
corpus. Root cause analyzed: `ast_expr_is_fn_call_of` checks if the func*box is
an `Atom`, but `.Variant` patterns have func_box=`FnCall(Dot, ...)`. So the
fieldless check `ast_expr_is_fn_call_of(match_arm_expr, ".", Some(1))` is
ALWAYS false for `.Variant` patterns. Only `*`wildcard enters the fieldless
branch. All`.Variant`patterns go through`with_fields` (which already uses
while-loop frame restoration). Classification is correct as-is. DO NOT RETRY.

### REVERTED: empty struct \_dummy field (2026-07-08)

Attempted to add `uint8_t _dummy` to zero-field struct declarations (mirroring
the tuple codegen pattern) to fix "incomplete type void" errors. Inert (errors
unchanged). The `(void){}` literal comes from the capture struct VALUE
generation path, not the struct declaration. DO NOT RETRY without first tracing
the value generation path.

### REVERTED: while loop body deferred drops in non-begin branch (2026-07-08)

Attempted to add deferred drop emission in `generate_loop_body`'s non-begin
branch. Build succeeded but errors unchanged — the drops weren't on the
expr processed there. DO NOT RETRY without first confirming where the drops
are stored.

### NEW FINDING: while-body deferred drops are on begin expression, not original body (2026-07-08)

The while evaluator calls `evaluate_begin_expression(body_expr, ...)` which
stores `deferred_drop_expressions` on the BEGIN-wrapped expression's ExprInfo.
The codegen extracts `body_expr` from the while call's args — the ORIGINAL
expression, not the begin wrapper. The original expression's ExprInfo may not
have the deferred drops. The fix should ensure the while codegen reads the
deferred drops from the begin expression that wraps the body, or the evaluator
should propagate the drops to the original body_expr.

### NEW FINDING: `_schedule_scope_end_drops` collects from the last frame (2026-07-08)

Probes confirmed fieldless arm `env.pop_frame()` sees 5 frames (begin frame
NOT popped by the body eval). But the with-fields branch handles this correctly
via `while(env.frames.len() > base_frame_count_wf)`. The fieldless branch uses
a single `env.pop_frame()` which can pop the wrong frame when leaked frames
are present.

### Landed --- earlier fixes already committed

### Landed: Phase 4 per-closure async result-type fix (−12)

`commit a675f54eb` — `yo-self/codegen/exprs/async.yo`
Root cause: Multiple closures implementing the same `Future(T)` trait share
a single `lookup_some_resolved_concrete` key (the SomeType id). The first
closure's registration poisons all subsequent closures' struct result types.
Fix: composite key `output_some_id@@async_block_id` — unique per closure.

### Investigated: Phase 1 init-assignment skip in async closures

The `result := e.io.await(...)` assignment in `io.async((e) => { ... })`
produces NO C code. The init-assignment codegen skips it because
`_last_is_compile_time_only` returns true (the def-time evaluation marks
variables as compile-time-only, and the codegen reads this stale binding).
This was investigated in session 2026-07-04 cont.3. **Now superseded** by the
Phase 2 investigation (2026-07-07): the real root cause is `get_expr_info(future_arg)`
returning `None` for `IO_file.statx(...)` inside closure bodies, not FSM/sync-future
path issues. See Phase 2 below.

### Remaining error breakdown (27 total as of 2026-07-08):

| Count | Category               | Details                                                                               |
| ----- | ---------------------- | ------------------------------------------------------------------------------------- |
| 10    | expected expression    | Await poll-loop code vanishes — `io`→`IoExn` in single-effect closures                |
| 4+1   | passing incompatible   | Type identity: self-compiler re-registers types with different IDs                    |
| 2     | undeclared identifiers | `get_info` (closure capture), 1 temp (remaining branch leak)                          |
| 2     | incomplete type void   | Empty capture struct → `(void){}` — capture VALUE gen, not struct decl                |
| 2     | assigning from void\*  | Cascade from await/throw codegen                                                      |
| 2     | operand arithmetic     | Dyn dispatch not lowered to vtable calls                                              |
| 1     | member ref not pointer | `(*self)->_fd` on ref struct — atom deref + `->`                                      |
| 1     | conflicting types      | Async closure proto `void*` vs def concrete — `type_key` mismatch in pre-registration |
| 2     | ptr-to-int             | Cascade                                                                               |

**Previous session notes (2026-07-06) — now obsolete, superseded by Phase 2:**

- `plans/YO_SELF_STAGE2_FIXPOINT_ROADMAP.md` — full history + type-identity analysis.
- `issues/yo-self-stage2-leaked-locals-loop-body.md` — leaked-locals (fully pinned).
- `issues/yo-self-stage2-string-ne-str-specialization.md` — String==str (fixed + residual).

---

## 0. Ground rules (READ FIRST)

**Faithful-port discipline (non-negotiable):** For every bug — (1) confirm the
TypeScript compiler (`./yo-cli`) emits CLEAN C from the same input; (2) find the
yo-self DIVERGENCE from `src/`; (3) fix yo-self to match `src/`. If TS is also
wrong, fix TS first, then port. NO workarounds, NO stubs. `yo-self/` must stay a
1-to-1 port of `src/`.

**Editing `.yo` files does NOT need `bun run build`** (that only rebuilds the TS
compiler). Just re-run `./yo-cli compile yo-self/main.yo`.

**RC-safety:** the drop/dup families are RC-critical. A wrong drop point =
double-free or leak. The corpus diff-test is the double-free ORACLE (see §1).

---

## 1. The iteration loop + validation protocol (used EVERY phase)

```bash
# 1. Build the yo-self binary from current yo-self/ source (~5 min).
./yo-cli compile yo-self/main.yo -o /tmp/yo-self-bin &> /tmp/build.txt
grep -iE "Error:" /tmp/build.txt | tail   # must be empty; binary must exist

# 2. Emit stage-2 C (yo-self-bin compiling yo-self) (~1 min).
/tmp/yo-self-bin compile yo-self/main.yo --emit-c --skip-c-compiler -o /tmp/stage2 > /tmp/s2emit.txt 2>&1

# 3. TRUE error count — MUST use -ferror-limit=0 (clang's default 20 hides 2/3!).
clang -std=c11 -ferror-limit=0 -c /tmp/stage2.c -o /dev/null -I. 2>/tmp/s2.txt
grep -c "error:" /tmp/s2.txt                                  # the metric
grep "error:" /tmp/s2.txt | sed -E 's/.*error: //; s/'"'"'[^'"'"']*'"'"'/X/g; s/[0-9]+/N/g' | sort | uniq -c | sort -rn  # distribution
```

**Validation gates (run after EVERY code change, before committing):**

```bash
# Corpus diff-test — RC double-free ORACLE + TS-parity. MUST stay 103/103, DIFF 0.
YO_SELF_BIN=/tmp/yo-self-bin bash scripts/diff-test.sh tests/codegen-bootstrap/ --parallel 4
# std eval check — MUST stay 152/152.
/tmp/yo-self-bin check ./std
```

**If corpus DIFF > 0 or SELF-FAIL > 0, or std < 152 → REVERT immediately.** These
are non-negotiable. Only commit when: stage-2 count dropped, corpus 103/103 DIFF 0,
std 152/152.

**Minimal-repro workflow** (isolate a bug from the 56):

```bash
# Extract the failing construct into a tiny standalone .yo with main + export(main).
/tmp/yo-self-bin compile /tmp/repro.yo --emit-c --skip-c-compiler -o /tmp/r > /tmp/re.txt 2>&1
clang -std=c11 -ferror-limit=0 -c /tmp/r.c -o /dev/null -I. 2>&1 | grep "error:"
# ALWAYS also run the SAME repro through TS and confirm 0 errors:
./yo-cli compile /tmp/repro.yo --emit-c --skip-c-compiler -o /tmp/rts > /tmp/rtse.txt 2>&1
clang -std=c11 -ferror-limit=0 -c /tmp/rts.c -o /dev/null -I. 2>&1 | grep -c "error:"   # expect 0
```

**Probe/instrumentation technique** (proven this session — how to trace evaluator/
codegen decisions without a debugger):

- Add a module-level helper `_dbg :: (fn(cond : bool, tag : str) -> unit)(if(cond, eprintln(tag), ()));`
  (import `{ eprintln } :: import("std/fmt");`). **`str` implements `ToString`, so
  `eprintln(str)` needs no owned `String` temp** — this dodges the begin.yo
  "Frame level N has different number of values" frame-merge error that bites any
  probe creating an owned temp inside an unbalanced `if`-block.
- Guard with a distinctive constant (e.g. a specific func_id / var name) so output
  isn't drowned; grep + `sort | uniq -c`.
- To correlate a codegen emission with its SOURCE PATH, inject a distinctive C
  COMMENT (`em.emit_string_line(\`${indent}// [TAG]\`)`) and grep the emitted C —
  position-correlated, unlike eprintln.
- To isolate one function among many with a common local name, use a co-variable
  check (`_frame_has(frame, "i")`).
- ALWAYS `git checkout <file>` to revert probes before building the real fix / committing.

---

## Phase 1 — leaked-locals (4 errors remaining, was 13; DOWN 9 via Phase 4 match fix)

**FIXED (9):** `t`×2, `t_expr`, `frame`, `arg_expr` + 4 `_file____User_temp_*` — the
match-frame leak fix (`fabb2d9dd`) eliminated these by correctly popping
`match_arm_frame` from the body's ExprInfo.env, preventing loop-body variables from
leaking into the arm's begin-block scope-end drops.

**REMAINING (5, re-confirmed 2026-07-07 session 2):** `get_info` (69066) + `arg_expr`
(80975) + 3 temps (`_161724`, `_161837` @80976-77, `_188205` @206397).

**CORRECTION — these are NOT cond/if branch-frame leaks (that theory is WRONG):**

- `arg_expr` is in `yo_id_257875` (a struct-ctor arg-matching fn): it is
  `arg_expr := match(arg_exprs.get(i), .Some(v) => v, ...)` INSIDE a `while` loop,
  dropped (with `_161724`/`_161837`) at the FUNCTION scope-end (after the loop) via
  `generate_deferred_drop_expressions` → out of C block scope. This is the SAME
  WHILE-BODY leak class as `extract_future`'s `t` (see
  issues/yo-self-stage2-leaked-locals-loop-body.md), NOT a match/cond arm issue.
  The `fabb2d9dd` match fix cleared the match_arm_frame leaks (9) but NOT these
  while-body ones. CONFIRMED: TS `cond.ts:90` does NOT push a per-case frame or
  call `popEnvFrame` (`const caseEnv = env; // evaluateBeginExpression pushes its
own`), so a "cond popEnvFrame" fix would be UNFAITHFUL + a no-op. The real fix is
  the WHILE-BODY leak (while.yo env-threading, `env.frames = body_info.env.frames`
  at while.yo:490) — same as the pinned leaked-locals issue.
- `get_info` (69066) is DIFFERENT: it's a CLOSURE CAPTURE emitted as a bare
  identifier. The closure `closure_yo_id_277703(void* closure_context, ...)` reads
  `get_info` directly instead of `((CaptureStruct*)closure_context)->get_info`.
  Fix is in closure-capture codegen (route captured vars through the capture struct).

**Investigation findings from sessions 2026-07-06/07:**

The original 13 undeclared errors came from two root causes:

1. **Match frame leak (9 errors, FIXED):** See Phase 4 section above. The match evaluator's
   `match_arm_frame` leaked into the body's ExprInfo.env.
2. **Branch leaks (4 remaining):** Variables declared inside if/else or cond branches
   have their drops scheduled in the outer begin block's deferred_drop_expressions
   (different frame from the match arm). The same style of frame cleanup is needed
   for other evaluator paths.

**CODE-GEN APPROACH (attempted + REVERTED):**

- Removing the `is_temp_variable_name` gate from `drop_dup.yo:567` caused 6 corpus DIFFs
  because non-temp variables (params, struct fields) aren't tracked in
  `declared_c_var_names`.
- Adding scope tracking to `declared_c_var_names` was explored but not completed —
  too complex for the payoff.
- The evaluator-level fix (match.yo) is the correct approach — extend to other
  branching constructs.

**Remaining fix (2026-07-07 session 2 correction):** The 4 non-`get_info` errors are
WHILE-BODY leaks (a `x := match(iter.get(i), ...)` local in a `while`, dropped at the
enclosing/function scope-end out of C scope). Fix at the EVALUATOR: `evaluate_while`
(while.yo) must not let the loop-body frame's vars leak into the outer env via
`env.frames = body_info.env.frames` (line 490) — mirror the match.yo `fabb2d9dd` fix
(pop the leaked frame from `body_info.env` before ingesting). See the full pin in
issues/yo-self-stage2-leaked-locals-loop-body.md (the drop is emitted by
`generate_deferred_drop_expressions` / arm-scope-end; the var leaked there via the
env-threading). RC-SAFETY-CRITICAL — validate corpus DIFF 0 + ASan.

`get_info` is separate (closure-capture codegen — route through the capture struct).

**SHARP FINDING (2026-07-07 session 2, instrumented `_schedule_scope_end_drops`, reverted):**
Probed all 22 `arg_expr` locals scheduled for drop: 20 are fine (dropped in their own
frame), but **2 leak into the FUNCTION frame** (co-var `arg_exprs` param present) —
those are the errors (`yo_id_257875` = a struct-ctor arg-matcher). CRITICAL: both the
leaked AND the correct `arg_expr` have `Variable.frame_level=2, env.frames.len()=3` —
i.e. the leaked `arg_expr` **binds at the FUNCTION frame level (2), NOT the while-body
frame (3)**. So a "skip drops whose frame_level ≠ current frame" filter does NOT work
(leaked and correct are indistinguishable by level). The while-body frame is simply
NOT ACTIVE when `arg_expr := match(arg_exprs.get(i), .Some(v)=>v, ...)` binds.

ROOT (hypothesis, needs 1 more probe to confirm): the `match(...)` RHS threads its arm
body's env back via `env.frames = bi.env.frames` (match.yo:2249). For this Option
`.Some(v)` match the arm-body env is SHORTER than the pre-match env — the while-body
frame got popped during the match's arm-body eval (likely the `fabb2d9dd` match fix's
`pop_env_frame` / the with-fields `while(len > base_frame_count)` pop removing one frame
too many for this optimized-Option path) — so after the match, `env` has [0,1,2]
(while-body frame 3 gone), and `arg_expr` binds at level 2 (the function frame). NEXT:
instrument `add_variable_to_env` for `arg_expr` to print `env.frames.len()` at BIND
(expect 3, not 4), and instrument match.yo's `env.frames = bi.env.frames` (2249) +
the with-fields `base_frame_count_wf` to see if the arm-body env lost the while-body
frame. Then fix the match env-threading to PRESERVE the enclosing (while-body) frame
(pop only match_arm_frame, not the enclosing frame). RC-CRITICAL — the `fabb2d9dd` fix
that cleared 9 errors touches the same code, so re-validate corpus 103/103 + std 152/152

- that the 9 stay fixed + these 2 clear.

---

## Phase 2 — expected expression (10 errors, MAJORITY) + await dispatch

**Errors:** `expected expression` ×10 — the largest remaining category. C syntax
errors like `if ((() < ()))` (is_file/is_dir) and `return (() >= ())` (exists)
where BOTH comparison operands are empty strings.

**Discriminator (confirmed 2026-07-07 sess 3):** it is NOT statx-specific and NOT
naming — it is the **effect type**. `exists`/`is_file`/`is_dir` return
`Future(bool, Io)` (single effect Io) → closure param is `io : Io` → `io.await(...)`
(atom receiver). `canonical` (line 409) awaits the SAME `IO_file.statx(...)` via
`e.io.await(...)` (param `e : IoExn` bundle) and WORKS. So the failing shape is the
**atom-receiver `io.await` in a single-effect-Io io.async closure**; the working
shape is the nested `e.io.await` in a multi-effect bundle closure.

**TS is CLEAN for this exact input** (verified via `./yo-cli compile yo-self/main.yo
--emit-c`: 0 empty-operand patterns; yo-self emits 4). yo-self-bin (built by TS)
compiles std/fs fine. So this is a PURE yo-self divergence — do NOT touch TS.

**OLD THEORY REFUTED (2026-07-07 sess 3):** the "`get_expr_info(future_arg)` is
None → `generate_await` early-returns" story is WRONG. Ruled out by instrumentation
(all probes reverted after use):

- **FUTP probe** (helper.yo `check_if_function_parameter_matches_argument`, guarded
  `param_label`=="fut"): 70 io.await/spawn `fut` args, **ALL `actual == evaled`** —
  NO node replacement. The future-arg node id is stable through eval; the arg's
  ExprInfo IS stored under the id the codegen reads. So the expected-type-coercion /
  node-wrap hypothesis is dead (the committed `skip_expected_type` fix, `7c4191da8`,
  is still correct-and-faithful — it just does NOT fix this cascade).
- **AWP-FAIL probe** (await.yo `generate_await` None-return): the error-comment
  return string does NOT appear as emitted C → `generate_await`'s future-arg None
  path is NEVER hit for statx. So generate_await is not the failure point.
- **AWRES probe** (function.yo, all 3 `try_to_call` result sites 3354/3535/3603,
  guarded `is_io_await_call(expr)`): io.await results ARE computed, ALL `unknown=Y`
  (runtime), types = 37×i32, 10×unit (legit close/write), 9×struct, 5×bool, 5×File,…
  So the statx await's result value is a correct **runtime i32** (in the 37). io.await
  reaches these sites via the `.None` (no-compile-time-callee) branch, NOT the
  `.Some` branch — the io.await refinement at function.yo:3341 is effectively DEAD.
- **[TTERR] probe** (anonymous_function.yo `_trial_eval_anon_body` swallow handler
  printing `err.to_string()`): only 4 swallowed errors total, **none statx-related**.
  So the statx closure body does NOT throw at the `_trial_eval_anon_body` swallow.

**REFINED ROOT (precise pin):** For `exists` (simplest — no cond/Statx), the emitted
C is: `buf_size`/`buf` declared correctly, then the whole `result := io.await(statx,
io)` statement VANISHES (no `int32_t result`, no poll-loop) AND the final
`result >= i32(0)` emits `(() >= ())` (BOTH operands empty — even the `i32(0)`
literal → `""`). Empty operands mean those nodes have NO ExprInfo/resolution at
codegen. Since (a) the io.await result IS computed (AWRES), (b) `buf`/`buf_size`
(earlier statements) DO emit, but (c) `result >= i32(0)` (final statement) does NOT
→ the closure-body evaluation **stops right after the `result := io.await(...)`
binding**: statements before it get ExprInfo, statements at/after it do not. The
stop is a swallowed throw during the `result` init-assignment BINDING (after the RHS
io.await result is computed), atom-form-specific, and is caught at a swallow OTHER
than `_trial_eval_anon_body` (since [TTERR] there is silent for statx).

### DEFINITIVE ROOT (2026-07-07 sess 4 — probes; all reverted)

The single-effect-`Io` io.async closure's param **`io` resolves to type `IoExn`
(the bundle), not `Io`.** `IoExn` has `.io`/`.exn` fields but **no `.await`**, so the
callee `io.await` resolves to type **`unit`** → the call takes the `.None`
no-compile-time-callee branch (function.yo:3589) with a `unit` callee (no params, so
the statx `fut` arg is never processed → `fut=<no-info>`), the awaited **result type
collapses to `unit`**, `result : unit`, and `generate_atom` returns `""` for a
unit-typed atom (atom.yo:200) → `result >= i32(0)` emits `(() >= ())`. Confirmed by
probes: `[PD] io : IoExn` (×3 statx) vs `[PD] e : IoExn` (×27 bundle, correct);
`[NRES] callee=unit ret=unit fut=<no-info>` (×3) vs proper `fn(forall(T,E)…)->T`
(×45). The io.async `E`-binding (helper.yo:2608) DOES compute the right effect
(`[EB] eff0=Io` ×3, `eff0=IoExn` ×27) and `[EBA] already=N` (it binds), but the
binding is **not honored** by closure param-type resolution.

WHY the E-binding is ignored: closure param types resolve via
`evaluate_function_parameter_type_again` → `_resolve_some_types_deep` (types/
function.yo) → for the nested `E` SomeT, `get_value_of_some_type_from_env` →
`_do_chain_resolve` (types/env_lookup.yo:294). `_do_chain_resolve` FINDS the added
`"E"=Io` variable but only RETURNS the concrete when `_was_self_bound` OR
`_def_frame_confirms_binding` passes — `_def_frame_confirms_binding` looks up `"E"`
**at the E SomeT's DEFINITION frame**, but `add_variable_to_env` puts the binding at
the env's LAST frame, so the gate REJECTS it and resolution falls through to the
shared-global `lookup_some_resolved_concrete(E_id)` — which holds a PRIOR io.async
call's effect (`IoExn`), since the forall-`E` SomeType id is shared across all
io.async calls. TS has no such problem: it binds `E` as a per-call calleeEnv variable
(helper.ts:1348) and env-lookup honors it (no def-frame ownership gate).

**TWO FIXES ATTEMPTED + REVERTED (both INERT for statx — cascade unchanged at 10):**

1. **Mutate the existing forall-`E` placeholder's value to `TypeVal(Io)` in place**
   (so `_def_frame_confirms_binding` sees the concrete at the placeholder's frame).
   Variable IS `ref` (env.yo:58) so the mutation reached the env, but the placeholder
   is NOT at the E SomeT's def frame → gate still failed. Net −0 (perturbed random IDs
   → 31→35 noise). REVERTED.
2. **`register_some_resolved_concrete(ft.get(eb_i)_someT_id, io_e_conc)`** in the
   E-binding (override the global fallback per-call, using `ft`=forall_types from the
   Func meta, in scope at helper.yo:2244). INERT (stayed 31, statx unchanged) — likely
   `ft`'s forall-`E` SomeType id ≠ the `E` id inside the action param `Impl(Fn(e:E)→T)`
   that `_resolve_some_types_deep` actually looks up (so the register missed), OR the
   `IoExn` comes from an EARLIER synthesis pass (the yo-self analogue of TS
   helper.ts:1302 `synthesizeTypes`), not the `lookup_some_resolved_concrete` fallback.
   REVERTED.

**NEXT STEP (fresh session):** confirm the exact `E`→`IoExn` source before the next
fix — instrument `_do_chain_resolve` / `_resolve_some_types_deep` to print, for the
closure param `E` SomeT, (a) its id + def frame_level, (b) whether `_do_chain_resolve`
returns concrete or falls to `lookup_some_resolved_concrete`, (c) what
`lookup_some_resolved_concrete(E_id)` holds and WHO registered it. Also check the
yo-self synthesis pass equivalent of TS helper.ts:1302 (does it bind `E` to a stale
`IoExn` before the io.async E-binding?). The FAITHFUL fix is to make the per-call
`E` binding win over the shared-global fallback (either register the CORRECT E id —
the one resolution looks up — per call, OR bind `E` at its def frame so
`_def_frame_confirms_binding` accepts it, OR freshen the forall-`E` SomeType id per
io.async call like the RESULT-type freshening at function.yo:3335-3339). RC-safe
(pure typing), but async-sensitive — validate corpus 103/103 + std 152/152.

**GOTCHAS (cost real build cycles):** (1) importing `is_unknown_val`/`await_analysis`
into `initialization_assignment.yo` created a circular import ("Record field
to_string not found in source namespace type"). (2) **Nested backticks in a template
interpolation** — `` `...${if(x, `Y`, `N`)}...` `` — fail to compile with the same
"to_string not found in source namespace type" error; extract the inner `if`/`cond`
to a separate `uvs :=` statement first. (3) probes referencing a variable defined
LATER in the fn fail (no forward refs) — e.g. `mark_closure_for_codegen` (defined
after the param loop); use `is_creating_closure` (defined earlier, same value).

**FALLBACKS ATTEMPTED + REVERTED (older):** using `__yo_io_future_t*` as fallback
future type in generate_await → +12 errors (generic future type lacks
`__yo_resume_fn`/`state`/`result`). Do NOT retry.

**FALLBACKS ATTEMPTED + REVERTED (2026-07-07 sess 5) — DO NOT RETRY:**

1. **while.yo: `pop_env_frame(body_info.env)` before line 490.**
   Hypothesis: the while-body frame leaked into `body_info.env` and needed cleanup
   (mirroring the `fabb2d9dd` match fix). RESULT: 103→67 PASS, 31 DIFF, 5 SELF-FAIL
   (massive regression). WHY IT FAILS: `body_info.env` was snapshotted AFTER
   `pop_frame_nonmutating` (begin.yo:913 before new_expr_info at 917), so the begin
   frame is ALREADY removed. Popping again removes the function-scope frame, causing
   all variable lookups to resolve at wrong frame levels. DO NOT RETRY.

2. **env_lookup.yo: replace `_def_frame_confirms_binding` with full-env search.**
   Changed the gate from per-frame lookup (`_lookup_by_frame`) to full env scan
   (`get_variables_from_env`), so the `E=Io` binding in `io.async` (added at current
   top frame) is found regardless of the `E` SomeType's definition frame. RESULT:
   31→144 errors, 12 SELF-FAIL (massive regression). WHY IT FAILS: the gate exists to
   prevent false matches — removing it causes type resolution to accept stale/invalid
   bindings from unrelated frames, breaking all generic type resolution. The fix must
   be TARGETED to the specific `E` binding, not a broad gate removal. DO NOT RETRY.

---

### Phase 1 INVESTIGATION RESULTS (2026-07-06 & 2026-07-07)

**FIXED (2026-07-07, commit `fabb2d9dd`):** Match-frame leak cleanup eliminated 9 of 13
undeclared identifiers. The root cause was NOT in `_schedule_scope_end_drops` or
`add_variable_to_env` as previously hypothesized — it was in the match evaluator
(match.yo) failing to pop `match_arm_frame` from the body's ExprInfo.env after
evaluating each arm. This caused the body's recorded env to carry the leaked frame,
which was later ingested via `env.frames = bi.env.frames` (match.yo:2249).

**Remaining 4 undeclared:** `get_info` (closure capture not routed through capture
mechanism) + 3 branch-leaked temps. The closure capture issue is in
`closures.yo`/`capture.yo` — `get_info` is a closure-captured variable but the
codegen emits it as a bare identifier instead of through the capture struct.

### Phase 2 INVESTIGATION RESULTS (2026-07-07)

**Confirmed via AW-SYNC/AW-RET probes:** `is_io_await_call` dispatches 36 times
correctly. 3 of those 36 have `get_expr_info(future_arg) == None` — all for
`IO_file.statx(AT_FDCWD, cstr, ...)` calls inside closure bodies in
`std/fs/file.yo:exists`/`is_file`. The remaining 33 work correctly (emit
`// Synchronous await` poll-loop blocks).

**Fallback approaches tested + reverted:**

- Using `__yo_io_future_t*` as hardcoded fallback: REGRESSION from 35→47 (+12).
  The generic future type lacks `__yo_resume_fn`/`state`/`result` fields.
- Adding scope-aware drop tracking in codegen: DEAD END. Too many variable
  declaration paths don't go through `get_variable_type_string`.

**Old Phase 2 (conflicting types for closure_yo_id_6942):** Proto `void*` vs def
`__yo_t649*`. Both proto and def call `_async_override_return_type` but the
closure's return type `type_key` doesn't match the pre-registered async struct's
`type_key`. The `preregister_async_block_types` function correctly scans all
function bodies but the SomeType IDs assigned to the future type differ between
the `io.async` call and the closure's declared return type.

**Potential fix for conflicting types:** Add `ret_ct := get_type_string(ret, context)`
fallback in `_async_override_return_type` to use the already-registered type when
the async block isn't found in the body. This was attempted but the edit had a
syntax error chain (closing parens issue).

---

## Phase 3 — String==str residual: inner `Self.(==)` overload (~1 error)

**Errors:** `passing '__yo_str' to parameter of incompatible type '__yo_t2'` — the
specialized `(!=)` for `Eq(str)` calls `Self.(==)(lhs, rhs)` which resolves to
`Eq(String).(==)` instead of `Eq(str).(==)`.

**Investigation (2026-07-07):** Attempted to add explicit `(!=)` method in
`std/string/string.yo` for `impl(String, Eq(str))` and `impl(str, Eq(String))`.
The syntax requires commas between trait methods. Even with correct syntax,
`Self.(==)` inside the explicit body still resolves to the wrong overload in
yo-self. TS uses the `ioBuiltin` marker approach which yo-self lacks.

**POTENTIAL FIX:** The issue is in yo-self's overload resolution for `Self.(==)`
inside trait impl bodies. Fix `_select_matching_overload` in function.yo to
consider the `Rhs` type parameter of the `Eq` trait when selecting an overload.
Alternatively, change the default `(!=)` body evaluation to use the current impl
block's `Self.(==)` context (same impl → same `Rhs` type).

---

## Phase 4 — type-identity + syntax cascade (remaining ~12: incompat 5, incomplete-void 2, member-ref 4, operand-arithmetic 2, etc.)

**This is the deepest family** — do it LAST. Some of it likely CLEARS once Phases
2-3 land (the "expected expression" 10 + "assigning from void\*" 2 are SYNTAX
CASCADES downstream of the broken io.await codegen).

**Errors:** `passing incompatible type` ×5 (type identity: self-compiler re-registers
the same type with different IDs), `incomplete type void` ×2 (empty capture struct),
`member reference on size_t` ×3 (random, varies per compilation), `operand arithmetic`
×2 (dyn dispatch not lowered), `member ref not pointer` ×1 (`(*self)->_fd`),
`ptr-to-int` ×2 (cascade).

**Member-ref-not-pointer investigation (2026-07-07):** `(*self)->_fd` where `self` is
a `ref` struct. The atom codegen wraps `(*self)` for `is_ref` variables. The field
access uses `->` expecting a pointer, but gets a dereferenced value. Attempted:

1. Strip `(*...)` wrapper in `generate_field_access` for ref structs → use inner
   name + `->` — caused 82 errors (the `(*)` pattern is also used for double-pointer
   `(**self)` → `self->field` which breaks).
2. Check `is_star_deref` and use `.` instead of `->` — also 82 errors (same
   double-pointer issue).

**Faithful-port fix:** TS atom codegen does NOT wrap `(*self)` for ref struct
variables — it only does so for `isRef` (`inout`) params. Check if yo-self
incorrectly sets `is_ref` for ref struct self-params. Fix should be in the
evaluator's `is_ref` flag computation for `self` params of ref struct types.

---

## Phase 5 — Definition of done + `test` subcommand (tasks #69, #70)

Once stage-2 clang errors = 0:

1. Full stage-2 compile to a binary + run it:
   `/tmp/yo-self-bin compile yo-self/main.yo -o /tmp/stage2-bin && /tmp/stage2-bin --version`
   (or a trivial compile) — confirm the self-compiled binary WORKS, not just compiles.
2. **Task #69:** `/tmp/stage2-bin test ./tests --parallel 8` should pass what
   `./yo-cli test ./tests` passes.
3. **Task #70:** `/tmp/stage2-bin test ./yo-self/tests` likewise (note: eval trio +
   heavy files — see yo-self/README.md; the full dir is ~90 min).
4. Fixpoint: stage-2 binary compiling yo-self should itself produce a stage-3 that
   is byte-identical (or diff-clean) to stage-2.

---

## Quick reference — commit conventions

- Commit only validated changes (stage-2 down + corpus 103/103 DIFF 0 + std 152/152).
- End commit messages with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Run `./yo-cli fmt <file.yo>` on every `.yo` you touch before committing.
- Put new bug analyses in `issues/`, plan updates in `plans/`.
