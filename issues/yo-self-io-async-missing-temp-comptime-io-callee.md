# yo-self: io.async FSM round 3 — the four stacked gaps behind the sys/timer flag-on failure

**Status:** all four fixed; sys/timer PASSES flag-on (async_await 116/116, cycle 16/16,
walker at flag-off parity). Flag stays OFF: sys/bufio + fs/file still break flag-on
(see "Remaining" at the bottom).
**Found:** 2026-07-22, io.async FSM port round 3 (sys/timer batch, flag-on trial)
**Affects:** mostly `IO_ASYNC_FSM_ENABLED` flag-on (sync path masks gap 1 — see below);
gaps 1 and 4 are evaluator-side and live flag-off (gated by the full battery).

Peeling the sys/timer flag-on failure exposed four independent gaps, each hidden
behind the previous one. Gap 1 below is the original typedef-mismatch analysis;
gaps 2-4 follow it.

## Symptom (flag-on)

Compiling `tests/sys/timer.test.yo` through the selftest batch runner:

```
error: unknown type name 'async_block_yo_id_6035_state_t'
  640 | void async_block_yo_id_6035_resume(async_block_yo_id_6035_state_t* sm);
...
 4619 |         async_block_yo_id_6035_state_t* async_result = __yo_new_async_block_yo_id_6035();
 4620 |         async_block_yo_id_6035_state_t* task1 = async_result;
```

Every use of the SM struct errors: the `typedef struct X_struct X;` forward
declaration for that name is never emitted.

## Root cause

TS attaches a temp variable name to EVERY runtime call result
(`attachTempVariableToExpr(expr, true, ...)`, function.ts:2263). Both
`preRegisterAsyncBlocksInExpr` (async.ts:1686/1722) and `generateAsyncBlock`
(async.ts:97) derive the async-block id as
`expr.$?.variableName || <fallback>` — the fallback never fires in TS because
the temp is always present, so the typedef emitter and the body emitter always
agree on the name.

yo-self's `evaluate_function_call` has THREE arms that finish an io.async call:

| arm                                      | shape                               | attaches temp?   |
| ---------------------------------------- | ----------------------------------- | ---------------- |
| method arm (`out_m`, function.yo:~4104)  | receiver method                     | YES              |
| valueless-callee arm (`out_none`, ~4242) | `io : Io` runtime param             | YES              |
| UnknownVal-callee arm (`out_rt`, ~3898)  | callee value comptime-known/unknown | **NO (the bug)** |

The selftest batch runner synthesizes `main` with `io :: __yo_builtin_io`
(yo-self/main.yo:1441) — a comptime binding — so `io.async(...)` lands in the
UnknownVal-callee arm and reaches codegen with `variable_name = None`. Then:

- `preregister_async_blocks_in_expr` mints `async_block_<random>` /
  `io_async_block_<random>` (two independent random ids for its two blocks),
- `generate_async_block` mints a THIRD independent `async_block_<random>`,

so the typedef exists only under names nobody references, and the referenced
name (`async_block_yo_id_6035_state_t`) has no typedef.

## Why the sync path (flag-off) never hit this

`generate_io_async_sync_call` reads the struct name back from
`ei.async_state_machine_struct_name` (stored by preregistration) instead of
re-deriving it from `variable_name`, so preregister and the body emitter agree
even when the name is a random fallback.

## Repro

`issues/repros/io-async-comptime-io-missing-temp.yo` — the batch-runner shape
(`io :: __yo_builtin_io` + match/cond nesting). Flag-off, emitted C shows the
mismatched fallback names (grep `io_async_block_yo\|async_block_yo`); with an
`io : Io` main param instead, all SM names are `_file____User_temp_N_*` (temp
attached, valueless-callee arm).

## Fix (gap 1)

Add the same `attach_temp_variable_to_expr(expr, true, ctx)` before
`return(expr)` in the UnknownVal-callee arm (function.yo:~3902), mirroring TS
function.ts:2263 and the two sibling arms.

---

## Gap 2: closure-param slots labeled from the DECLARED signature, not the closure literal

After gap 1, the batch compiled but crashed: the resume body emitted a bare `io`
(`yo_id_...((__yo_t16)(io))`) — undeclared inside the resume function. The SM
struct's closure-param slot existed but was commented `// e`: slot collection
read the arg ExprInfo's TYPE (`cei.ty`), which is the Io record's DECLARED
`Fn(e : E) -> T` signature, so the slot's `param_name` was `e` while the body's
atoms say `io` (`(io : Io) => ...`). atom.yo's name-based slot resolution
(`sm->__yo_param_0` via same-name alias) therefore missed. TS reads
`closureFnValue.type.parameters` — the closure literal's OWN labels (async.ts:211).

**Fix:** the closure FuncVal lives in destructively-moved Option fields already
consumed by slot-collection time, so `io_async_await_analysis` now records
expr→func_id in `g_io_async_closure_fid_by_expr` (function_value.yo) on first
extraction (and falls back to it when the FuncVal is consumed — making the
analysis read idempotent); slot collection resolves labels via
`get_func_type(fid)`.

## Gap 3: FSM constructor takes no capture — outer variables read NULL

Next crash: `sm->var_<id>-><field>` segfaulted — the captured `value` Box sat
under "Local variables" with nothing initializing it, and the constructor took
no arguments. The capture struct type + its deferred dups live on the CLOSURE
ARG's ExprInfo; TS propagates both to the CALL expr in the evaluator
(`expr.$.captureType = closureArg.$?.captureType`, function.ts:2194-2195,
clearing the arg's dups) and re-kinds analysis captured variables that live in
the capture struct as OUTER (2205-2218) so they resolve as
`sm->__capture.<name>`.

**Fix:** `generate_async_block` resolves `fsm_capture_type` / `fsm_capture_dups`
from the closure arg (clearing the arg's dups, TS 2198-2200) and re-kinds
capture-field-resident captured variables to Outer before recording the
deferred block.

## Gap 4: await results never copied out of the future (`result=0`)

Timer then ran but `io.await(sleep(50), io)` yielded 0: the resume's "Extract
result from await N" block had no assignment — `target_variable_id` was None.
`extract_target_variable_id` (suspension_analysis.yo) resolved the `:=` LHS
name through the LHS ATOM's recorded env, which in yo-self PREDATES the binding
and only sees it via retroactive shared-Frame mutation — broken across
match/cond arm frames (the batch shape). Same root cause as round 2's
`collect_variable_refs_in_expr` binding-target fix.

**Fix:** resolve through the `:=` node's OWN post-binding env first (also the
TS-correct answer under shadowing), keeping the atom env as fallback. NOTE:
this helper is shared with effect_analysis.yo, so the change is live flag-off.

## Round 4 (same campaign, next flag-on layer — all C-compile errors cleared)

Continuing flag-on, fs/file + sys/bufio moved from C-compile failures to
behavioral failures via five more fixes:

1. **SM tail/early `return(x)` emitted NOTHING** (return.yo:679/722 were
   Phase-5 stubs returning `""`): the machine never stored `sm->result`, never
   set state -1, never spawned the continuation (fs/file read_string's empty
   final state). Ported TS return.ts:653-683 + 740-756 (completion via
   emit_async_future_completion; unit-early-return completes with a zeroed
   result). The SM return temp is typed from the ARG's resolved type — the
   return expr's own recorded type is the FUTURE, whose C name is the SM
   struct pointer.
2. **Async-block result type resolved to the future itself** for
   `return(x)`-tailed bodies (the body-ExprInfo fallback blindly took the
   body's type): generate_async_block now consults
   `get_func_type(lookup_io_async_closure_fid(...)).result` first (TS walks
   closureFnValue's return type) and guards both fallbacks with
   `type_implements_future`.
3. **Await-target SM fields dropped by segment counting** (fs/file `content`):
   later eval passes re-stamp ExprInfos with fresh variable ids (or record
   envs that miss the name), so codegen-side refs resolved to ids the
   suspension analysis never saw — the captured id counted 1 segment and its
   field was filtered out. `collect_variable_refs_in_expr` now ALSO counts the
   same-name captured id (name-unification map built from
   analysis.captured_variables), unconditionally for identifier atoms and `:=`
   targets.
4. **Suspension analysis misses `:=` binding targets** (suspension_analysis.yo):
   the Atom walk resolves through the LHS atom's pre-binding env; added a `:=`
   case resolving through the node's own env (factored the capture cascade
   into `_capture_env_variable`). Live flag-off (shared with effect analysis).
5. **Bare eval-temp statements in SM bodies** (`_file____User_temp_N;`
   undeclared — the bufio 11-error class): statements that emit their own C
   lines return only their eval temp name; `generate_loop_body` (while_loop.yo)
   and match.yo's arm-statement loop + unassigned-final fallthrough lacked the
   `is_temp_variable_name` skip that generate_state_segment_code already has.

Flag-on status after round 4: **zero C-compile errors** across the battery;
sys/timer 1/1, async_await 116/116 (pre-round-4), fs/file 2/13 behavioral,
sys/bufio 3/22 behavioral ("unexpected error: file or directory not found" —
consistent with the PHASE3_CAPTURE_PENDING `.io = 0` capture hole feeding NULL
io records into std-internal SMs).

## Remaining (flag-on) before the real flip

- **sys/bufio:** 11 C errors — bare `_file____User_temp_N;` statements
  referencing undeclared temps (evidence: /tmp/fsmon_bufio_batch.c,
  /tmp/fsmon_bufio_errors.txt).
- **fs/file:** `sm->var_<id> = sm->await_future_1->result;` where the target
  has NO SM struct field — a single-segment await target is excluded from the
  cross-boundary set but the extraction writes an SM field unconditionally
  (evidence: /tmp/fsmon_fsfile_batch.c). Also visible in the same batch: the
  FSM constructor call for std/fs/file's `read_file` emits
  `.io = /* PHASE3_CAPTURE_PENDING */ 0` — the capture-literal builder has no
  deferred dup for the `io` field and yo-self capture-struct fields don't
  carry per-field capture expressions (TS builds these from the capture
  field's recorded expr, async.ts:330-335). The FSM path for io.async INSIDE
  std functions (named fns returning futures) needs that Phase-3 capture
  machinery.
- fs/walker's 5 failures reproduce identically flag-off — a separate
  pre-existing behavioral bug (`unexpected exception` from the walk exn
  wiring), tracked as its own campaign item.

## Round 5 (fixes applied, gating in flight)

**Fix 1 — capture fallback (sound; the earlier rc=138 was a transient machine
kill, not the fallback):** `_build_async_capture_struct_literal`'s
PHASE3_CAPTURE_PENDING `0` replaced with a by-name call-site variable read
(`get_variable_name_for_codegen(label, call-site env)` — the TS async.ts:330-335
equivalent; whole-struct dup balances RC).

**Fix 2 — the REAL hang: bare-cond-await closures got EMPTY resumes.**
`File.close`'s SM (`(e) => cond(...)` — a single NON-begin body,
std/fs/file.yo:202) emitted `switch (sm->state) { }` — zero segments — so the
machine never completed and every awaiting parent hung. Root cause: the
early `return(segments)` from inside `split_body_at_suspension_points`'s
non-begin if-block frees the returned list (a TS-compiler drop bug on the
nested-block escape path — callers read len 0, later reads garbage; see
issues/ts-early-return-nested-block-rc-drop.md). Workaround: restructured to
if/else with the begin path in `_split_begin_body_into` — single tail return.
Repro: `issues/repros/io-async-bare-cond-await-empty-resume.yo` (25 lines,
was segments=0 + rc=124 hang; now runs correctly).

**Flag-on battery after both fixes:** fs/file **13/13** (was 2), sys/bufio
**21/22** (was 3), sys/timer 1/1, async_await 116/116, cycle 16/16, basic
33/33, signal 1/1, walker 1/6 (unchanged — its 5 failures reproduce
identically flag-off; separate pre-existing walk-exn bug).

**Remaining flip blockers:**

1. sys/bufio "BufReader read partial then remaining" — the buffered-read
   closure (io.await inside cond branches, buffer state through
   `sm->__capture.self`) misbehaves flag-on. Round-6 target.
2. fs/walker's 5 pre-existing behavioral failures (flag-independent) — decide
   whether they gate the flip (they should not: identical flag-off).
