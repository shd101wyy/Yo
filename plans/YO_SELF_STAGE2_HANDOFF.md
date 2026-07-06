# yo-self stage-2 fixpoint — HANDOFF PLAN (remaining work)

**Goal:** drive the yo-self self-compile ("stage-2") clang errors to **0**, then make
the self-compiled `yo-self` binary's `test` subcommand pass `./tests` and
`./yo-self/tests` (tasks #69, #70).

**Current state: 39 stage-2 clang errors** (was 56; −17 total).

### Progress log

| Session    | Change                                          | Δ           |
| ---------- | ----------------------------------------------- | ----------- |
| Prior      | per-closure async result-type fix (`a675f54eb`) | 56→44 (-12) |
| 2026-07-06 | unwind double-return fix (`d0518c359`)          | 44→42 (-2)  |
| 2026-07-06 | recur ref-param deref strip (`dd4473afc`)       | 42→39 (-3)  |

### Landed: Phase 4 per-closure result-type fix (−12)

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
Three attempted fixes (checking RHS runtime-ness, checking io.await, removing
the check entirely) were ALL neutral — the issue is deeper in the sync-future
generation pipeline. The await expression's codegen isn't called because
`generate_await` returns `""` when `in_async_state_machine` is set, and the
sync-future path generates await differently (through the state-machine
codegen). This is the "statx/async family" documented in the roadmap
(session 2026-07-04 cont.3).

### Remaining error breakdown (44 total):

**Session 2026-07-06 (cont.) — statx/async deep investigation:**

### GEN-AWAIT-MATCHED probe confirms dispatch fires for statx closure

36 `is_io_await_call` dispatch matches across the entire self-compile. The
statx closure's `e.io.await(...)` is dispatched to `generate_await`. But:

1. **No FSM skip**: `in_async_state_machine` is NOT set for the closure
   (`IO_ASYNC_FSM_ENABLED` is `false`; only 1 AWAIT-IN-FSM hit total, in
   self-compiled codegen, not in user code).

2. **No error path**: All 8 early-return error strings appear in self-compiled
   codegen only, none in user functions.

3. **Yet no poll-loop code**: After the `GEN-AWAIT-MATCHED` probe, the function
   body immediately continues with `bool _file____User_temp_6611;` (the cond
   result) — zero poll-loop/result-extraction code between them. The working
   awaits (e.g., line 33033) DO have the full `// Synchronous await ...` block.

4. **Hypothesis**: `generate_await` emits via `context.base.emitter`, but the
   emit output lands in a buffer that gets discarded/overwritten. The
   init-assignment codegen also uses `context.base.emitter` and its output
   appears correctly, so the emitter is the same — but `generate_await`'s
   templated strings might hit a codegen bug that silently skips them
   (e.g., `get_type_string(future_type, ...)` returning `void*` for the
   `__yo_io_future_t*` type, causing a formatting issue).

5. **Working awaits** all use `__yo_io_future_t*` (the concrete Io future type).
   The statx await uses `IO_file.statx(...)` which returns a Future whose
   `future_type_name` from `get_type_string(future_type, context.base)` likely
   resolves to a different string format.

**POTENTIAL FIX**: In `generate_await`, check the resolved `future_type_name`
and ensure it's a valid C type for the `__sync_future` variable declaration.
The `get_type_string` for the statx Future type may return an invalid/unusable
C type. Compare with TS: `glibc_stat.futureTypeCName` resolves through the
`typeRegistry.cName` which is always a valid short name.

Verbosity required due to extensive probing without finding the exact mechanism.

**Session 2026-07-06: Phase 1 extensively investigated; Phase 2 attempted.**
Error count unchanged at 56. See detailed findings below.

This doc is the actionable plan. Deep per-family analysis lives in:

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

## Phase 1 — leaked-locals (13 errors, FULLY PINNED, do this FIRST)

**Why first:** largest single family, completely root-caused (3 passes this
session), self-contained. Errors: `t`×2, `t_expr`, `get_info`, `frame`, `arg_expr`
(5 user vars) + 7 `_file____User_temp_*` (temps) — all "use of undeclared identifier".

**Root (see issue file for the full pin):** a loop-body owning local — e.g.
`t := match(required_trait_types.get(i), .Some(v)=>v, .None=>{i+=1; continue})` in
`extract_future_trait_from_type` (trait*checking.yo:1397) — is C-declared INSIDE
the `while {}` but its RC-drop is emitted at the ENCLOSING match-arm scope-end
(after the loop label, out of C block scope). CONFIRMED emitter (via injected
`// [SED-SCOPE-END]` tag): `generate_deferred_drop_expressions` (drop_dup.yo:542)
draining the ARM begin block's `deferred_drop_expressions` → so `t` (a while-body
local) is in the ARM frame's scope-end drops. **TS drops loop-body locals INSIDE
the loop, per-iteration** (verified in /tmp/yo-self-9.c ~149060,
`fn*...\_id_43\_\_\_drop(t)`after`i++`, before `}`).

**Two fix routes — do (A) first, it's correct + matches TS:**

### Route A (EVALUATOR — correct, drops `t` inside the loop like TS)

1. **Find which frame `t := match(...)` binds into.** Instrument `add_variable_to_env`
   (env.yo) OR `_schedule_scope_end_drops` (begin.yo:227) to print, for var name
   `"t"`, the frame level / whether `ctx.is_evaluating_loop_body` is set. Expected
   finding to confirm: `t` ends up in the ARM frame (co-var probe already showed
   `t`+`i` in one non-loop frame — a leak from the while-body frame up to the arm).
2. **Locate the leak in `evaluate_while` (while.yo:305-540).** The body is evaluated
   via `evaluate_begin_expression(body_expr, env, ...)` at line 310, which pushes a
   frame. After the body eval + control-flow handling, the outer `env.frames` /
   `out_info.env` must NOT carry the while-body frame's vars up to the arm. Check
   lines 347/354/366/470/490 (`env.frames = body_info.env.frames`) — one of these
   propagates the body frame. Compare against TS `evaluateWhile` in
   `src/evaluator/exprs/while.ts` for the exact env-threading (yo-self must match).
3. **Fix so `t` stays a while-body local** → the while-body begin block's
   `_schedule_scope_end_drops` schedules its drop → `generate_loop_body`
   (while_loop.yo:146-169) emits it INSIDE the loop. Note: the while-body begin
   block does NOT skip on control flow here — the skip (begin.yo:250-268) only
   checks DIRECT statements, and extract_future's return/continue are NESTED in
   matches, so the body reaches the var loop normally.
4. **Coordinate with control-flow exits** so nothing double-drops: `t` is moved on
   the `return .Some(t)` path (consumed, `consumed_at_token` set → e5 excludes it)
   and not-yet-bound on the `continue` path — so only the fall-through iteration
   end should drop it. Verify the continue/break path
   (`_emit_loop_body_drops_before_exit`, atom.yo:32) and the fall-through drop are
   mutually exclusive per-var (TS is the reference).

### Route B (CODEGEN — pragmatic fallback if A proves too deep; LEAKS `t`, diverges from TS)

- Make drop emission scope-EXIT aware. `declared_c_var_names` (codegen context) is
  FUNCTION-scoped (grown-only, never removed on block exit), so it can't tell that
  `t` (declared inside the now-closed loop `{}`) is out of scope. Snapshot
  `declared_c_var_names` on loop-body entry in `generate_while_loop`
  (while_loop.yo:186), compute the vars declared INSIDE the loop, and in
  `generate_deferred_drop_expressions` (drop_dup.yo:542) skip a drop whose target
  is a loop-only var (extend the existing `undeclared_temp` skip — currently
  temps-only — to these). Safe (no double-free) but leaks `t`. Only if A is blocked.

**Validate:** stage-2 (expect −8 to −13; the 7 temps likely clear too), corpus
103/103 DIFF 0, std 152/152, + an ASan run on a corpus binary
(`./yo-cli compile <corpus>.yo --release --sanitize address --allocator libc -o t && ./t`).

---

## Phase 2 — async state-machine struct return type (~2-4 errors)

**Errors:** `conflicting types for 'closure_yo_id_6942'` (proto emitted `void*`,
definition `__yo_t413*`) + `member reference type '__yo_t405' is not a pointer`
(a state-machine access `sm->field` on a value/void\*) + likely some of the
incompat/int-conv in Phase 4.

**Root (see roadmap "MEMBER-REF" entries):** an async fn / closure returns `void*`
instead of its concrete Future state-machine (SM) struct, because the SM struct is
registered under the io.async BLOCK's future SomeT id, not the FUNCTION-return
SomeT id, so `get_type_string(future_type)` → `void*`. The forward declaration and
the definition then disagree (`void*` vs `__yo_t413*`) = conflicting types.

**Steps:**

1. Minimal repro: a fn returning a Future (an `io.async` closure whose result is
   awaited), self-compiled. Confirm TS emits it clean.
2. Compare the async SM-struct type registration in yo-self
   `src/codegen/exprs/async.yo` (search `register_some_resolved_concrete`,
   `type_key(future...)`, SM-struct emission ~2064) vs TS `src/codegen/exprs/async.ts`.
   Ensure the SM struct is registered under the async FUNCTION's return-type SomeT
   id (and/or the forward-decl uses the same resolved return type as the definition).
3. The forward declaration (declarations.yo `generate_function_prototype` +
   `compute_async_return_override` ~490) and `generate_function` must compute the
   SAME override return type. Verify `find_returned_async_block` resolves the SM
   struct at BOTH sites.

**Validate** as §1. Phase-5 async feature area; check the roadmap's async notes.

---

### Phase 1 INVESTIGATION RESULTS (2026-07-06)

Extensive probing confirmed the root cause at a DEEP evaluator level:

1. **Codegen probe (LB-DROPS-IN/SED):** The while-loop body's `deferred_drop_expressions` is `<none>` — the evaluator's `_schedule_scope_end_drops` returns `None` for the body's begin block. The ARM's begin block drops `t` after the loop (out of C scope).

2. **EDROP-VAR probe:** The Variable for `t` has `is_owning_the_rc_value = true` but `is_reference_struct_type(v.ty) || is_reference_enum_type(v.ty)` returns `false`. The Variable stores the type with `is_reference_semantics = false` even though the C type `__yo_t6*` IS a ref struct. This prevents e1 from passing → `to_drop` is empty → `_schedule_scope_end_drops` returns `None`.

3. **Attempted fixes and results:**

   - Changing e1 to use `is_rc_type()` instead: no change (error count ~60, neutral)
   - Changing e1 to use `type_contains_rc_type()`: **REGRESSED to 140 errors** (matches container types like ArrayList, causing double-frees)
   - Route B codegen fix: requires `HashSet.clone()` which doesn't exist in yo-self; using `unsafe(ptr.*)` requires `pragma(Pragma.AllowUnsafe)` but the fix became too complex

4. **CONCLUSION:** The root cause is deeper than `_schedule_scope_end_drops` — the evaluator stores variable types with `is_reference_semantics = false` for types that ARE reference types in the codegen. This is likely a type-copy issue during `add_variable_to_env` or `evaluate_init_assignment`. A dedicated session is needed to trace why the Variable's type loses its reference-semantics flag.

### Phase 2 INVESTIGATION RESULTS (2026-07-06)

The `conflicting types for 'closure_yo_id_6942'` error (proto `void*` vs def `__yo_t401*`):

1. The pre-pass `_preregister_async_return_overrides` runs before prototypes but `_async_override_return_type` returns `None` for closures because `find_returned_async_block` can't find the `io.async` block inside the closure body at pre-pass time (body ExprInfo not yet available).

2. **Attempted fixes and results:**

   - Added body ExprInfo type fallback in `generate_function_declaration`: NEUTRAL (ExprInfo not available at proto time)
   - Added direct registration in pre-pass: **REGRESSED** (introduced 2 new clang errors in the yo-self binary itself)
   - The fix needs the pre-pass or prototype phase to have access to the closure's body type, which requires the body ExprInfo to be available earlier.

3. **POTENTIAL FIX:** Extend the async pre-registration walk (`preregister_async_blocks_in_expr`) to also handle closure bodies by calling `_set_async_sm_struct_name` on any `io.async(...)` found inside closure bodies. Or clone the `find_returned_async_block` logic to work without ExprInfo (purely AST-based).

---

## Phase 3 — String==str residual: inner `Self.(==)` overload (~1-3 errors)

**Errors:** some of the "passing '**yo_t433' ... incompatible type '**yo_t433 \*';
take the address with &" and/or "passing incompatible type" — the specialized
`!=` body's `Self.(==)(lhs, rhs)` resolving to the wrong overload.

**Root (see String==str issue file):** this session fixed the outer `!=`
specialization. The residual: inside the specialized `!=` body,
`not(Self.(==)(lhs:String, rhs:str))` — the `Self.(==)` DOT-call picks the
`Eq(String).==` (String,String) overload instead of the `(String,str)` `eq_str`
overload that the INFIX `==` correctly resolves. The infix path
(function.yo:1328, `is_infix_operator_call=true`) surfaces the str overload; the
dot-call path does not.

**Steps:**

1. Repro: `check :: (fn(s : String) -> bool)(s != "void"); ...` self-compiled →
   inspect the specialized `!=` body `fn_yo_id_2230_rtparam0_..._ret_bool`. TS emits
   `!=` → `id_47035` whose body calls the `(String,str)` `==` (`id_282`).
2. Make the specialized body's `Self.(==)(lhs, rhs)` (a dot-method-call) do the same
   arg-based overload selection the infix `==` does — i.e. surface + select the
   `(String, str)` overload (`eq_str`, imm/string.yo:650). Look at
   `_try_find_receiver_method` + `_select_matching_overload` (function.yo:182, 490)
   and how the infix path (function.yo:1328) passes `is_infix_operator_call=true`
   to `get_receiver_methods_by_name_from_env`; the dot-call passes `false`.
3. NOTE the "take the address with &" variant suggests a self-by-pointer mismatch
   (`eq_str`/`==` may expect `self` by value but the call passes a `*Self`, or vice
   versa) — check the receiver arg lowering for the specialized method call.

**Validate** as §1. Low count; may be deferrable if the type-identity family (Phase 4)
subsumes it.

---

## Phase 4 — type-identity + syntax cascade (remaining ~24: assigning/int-conv 16, expected-expression 12, misc)

**This is the deepest family** (roadmap: "~9 approaches exhausted"). Do it LAST —
some of it likely CLEARS once Phases 1-3 land (the "expected expression" 12 are
SYNTAX CASCADES downstream of malformed functions produced by the incompat/skip
breakage; count them AFTER each earlier phase).

**Errors:** `assigning to '__yo_t401 *' from 'bool'` / `from '__yo_t405 *'`
(int-conversion + incompatible-pointer), `expected expression` ×12 (cascade),
`variable has incomplete type`, `operand ... where arithmetic or pointer required`.

**Root (roadmap "INCOMPAT" entries):** generic-instantiation type identity — a
generic struct/enum's `id` (and method-registry key) omits type arguments, so
different instantiations (`Iter(usize)` vs `Iter(String)`) collide onto one
specialized function whose baked return/field type mismatches the call site. The
prior session's `type_arguments`-in-exact-compat fix (commit `9e4077300`) cut this
a lot; the residual is same-base-id generic-ENUM instantiations + the
`with_capacity`/`Self`-return specialization collapse (impl-level `K,V` not in the
method's sig).

**Steps:**

1. RE-MEASURE after Phases 1-3 — the count + distribution will have shifted; several
   "expected expression" cascades should be gone. Re-triage.
2. For each remaining incompat: read the emitted C at the error line, identify the
   two mismatched types (`__yo_t401` vs `__yo_t405`), and trace which specialized
   function baked the wrong type. Minimal-repro it; confirm TS clean.
3. The faithful fix is threading impl-block/`Self` type params (`K,V`) into the
   method's specialization signature so instantiations don't collapse — see the
   roadmap's detailed "ENUM-INCOMPAT 44" + "with_capacity impl-forall-not-in-sig"
   analysis and memory `yo-self-parametric-trait-impl-self-subst`. This is
   multi-site and regression-prone; validate + revert-on-regress each attempt.
   Do NOT append `self_type` to `runtime_param_tys` (documented +2634-error regression).

**Validate** as §1 after every attempt (this family has a long history of
attempts that made things WORSE — the corpus/std gates catch them).

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
