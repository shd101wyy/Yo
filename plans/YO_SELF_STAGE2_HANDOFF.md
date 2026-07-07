# yo-self stage-2 fixpoint — HANDOFF PLAN (remaining work)

**Goal:** drive the yo-self self-compile ("stage-2") clang errors to **0**, then make
the self-compiled `yo-self` binary's `test` subcommand pass `./tests` and
`./yo-self/tests` (tasks #69, #70).

**Current state: 35 stage-2 clang errors** (was 56; −21 total).

### Progress log

| Session    | Change                                          | Δ           |
| ---------- | ----------------------------------------------- | ----------- |
| Prior      | per-closure async result-type fix (`a675f54eb`) | 56→44 (-12) |
| 2026-07-06 | unwind double-return fix (`d0518c359`)          | 44→42 (-2)  |
| 2026-07-06 | recur ref-param deref strip (`dd4473afc`)       | 42→39 (-3)  |
| 2026-07-07 | match arm frame-pop cleanup (`fabb2d9dd`)       | 39→35 (-4)  |

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

### Remaining error breakdown (35 total as of 2026-07-07):

| Count | Category               | Details                                                                                    |
| ----- | ---------------------- | ------------------------------------------------------------------------------------------ |
| 10    | expected expression    | Await poll-loop code vanishes — `IO_file.statx(...)` inside closure bodies has no ExprInfo |
| 4     | undeclared identifiers | `get_info` (closure capture), 3 temps (branch-leaked, not fixed by match fix)              |
| 5     | passing incompatible   | Type identity: self-compiler re-registers types with different IDs                         |
| 3+    | member ref on size_t   | Random: varies per compilation (different random IDs)                                      |
| 2     | incomplete type void   | Empty capture struct → `(void){}` — `get_type_c_name` returns None                         |
| 2     | assigning from void\*  | Cascade from await/throw codegen                                                           |
| 2     | operand arithmetic     | Dyn dispatch not lowered to vtable calls                                                   |
| 1     | str→String             | `Eq(str).(!=)` default `Self.(==)` resolves to `Eq(String).(==)` instead of `Eq(str).(==)` |
| 1     | member ref not pointer | `(*self)->_fd` on ref struct — atom deref + `->`                                           |
| 1     | conflicting types      | Async closure proto `void*` vs def concrete — `type_key` mismatch in pre-registration      |
| 2     | ptr-to-int             | Cascade                                                                                    |

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

---

## Phase 2 — expected expression (10 errors, MAJORITY) + await dispatch

**Errors:** `expected expression` ×10 — the largest remaining category. These are
C syntax errors like `if ((() < ()))` and `return (() >= ())` where comparison
operands are empty strings.

**Root (confirmed via AW-SYNC/AW-RET probes 2026-07-07):** `generate_await` is
correctly dispatched (`is_io_await_call` matches), but `get_expr_info(future_arg)`
returns `None` for 3 `io.await` calls inside closure bodies (specifically
`IO_file.statx(AT_FDCWD, cstr, ...)` in `std/fs/file.yo:exists`/`is_file`).

The 3 misses cause `generate_await` to return early (`"// Error: await argument
must be a Future type"`), emitting no poll-loop code. The calling begin block then
processes the `result := io.await(...)` init-assignment with an empty RHS, and the
downstream `result >= i32(0)` comparison emits `(() >= ())` because the await
result variable is never assigned → empty operand.

**36 total `is_io_await_call` dispatches work correctly** (emit proper poll-loop
with `// Synchronous await` block). Only 3 fail.

**Why ExprInfo is missing:** The `IO_file.statx(...)` expression inside the closure
body has its ExprInfo stored during def-time body evaluation
(`_trial_eval_anon_body` → `evaluate_expression_raw`), but at codegen time,
`context.base.get_expr_info(future_arg)` looks up by `ast_expr_id(future_arg)` and
gets `None`. This is likely an AST-node-ID mismatch: the evaluator stores ExprInfo
under a specialized/cloned node's ID, but the codegen reads the original AST's ID.

**Key TS divergence:** TS stores `expr.$` (ExprInfo) in-band on EVERY AST node.
yo-self stores ExprInfo in a separate `expr_info_table` keyed by expression ID.
This indirection means IDs must match between eval-time and codegen-time — any
cloning or specialization breaks the ID link.

**Faithful-port fix candidates:**

1. Add ExprInfo as an in-band field on `AstExpr` (like TS `expr.$`) — major
   refactor, eliminates ID-mismatch root cause forever.
2. In `generate_await`, when `get_expr_info(future_arg)` returns None, try to get
   the future type from the `io.await` call's own ExprInfo (which IS available —
   `expr_ei` at line 375 succeeds). The await call's result type can be used to
   reconstruct the future type.
3. Fix the evaluator to ensure ExprInfo is stored under the SAME ID the codegen
   reads — trace the `IO_file.statx(...)` node's ID through eval→codegen.

**FALLBACKS ATTEMPTED + REVERTED:**

- Using `__yo_io_future_t*` as fallback future type caused 12 NEW errors (47 total)
  because the generic future type doesn't have `__yo_resume_fn`/`state`/`result`
  fields that the poll-loop codegen accesses.

**Next step:** Option 1 (in-band ExprInfo) is the cleanest faithful port but
requires modifying `AstExpr`, the evaluator, and codegen. Option 2 is more
targeted. Start with option 2.

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
