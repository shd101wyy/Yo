# yo-self self-hosting — HANDOFF PLAN (fresh-agent entry point)

_Last updated 2026-07-10 (after the assert/panic repair + RC-protocol +
stage-2-clang-0 sessions; tree clean, all fixes committed on
`feat/bootstrap-codegen`; corpus now 111 files)._

**Goal:** make yo-self compile itself **correctly**:

1. ~~Stage-2 emit: 0 clang errors~~ — **DONE, deterministic** (re-verified
   2026-07-10 after regressing to 416 during the assert refactor; the four
   fixes are in issues/fixed/yo-self-stage2-clang-errors.md).
2. ~~Fix the stage-2 BINARY runtime (parser + fmt divergences)~~ — **DONE
   2026-07-11.** Both named divergences were ONE bug class: token-String
   use-after-free from `ArrayList(ref-struct).get()` emitting no element
   dup (the "paren-less" error, the empty module path, AND the fmt
   HashSet-null panic were all downstream corruption). Fixed by the
   4-layer RC chain (commit 6e2313264) + unwind coverage / borrowed-tail
   return dup (5a5d28d15); `fmt --check` and sandbox/real-prelude checks
   now match stage-1 (rc=0). Frontend fidelity audit also landed
   (66326af85 — 8 lexer/parser divergences incl. the `:=` operator-guard
   workarounds).
   **← YOU ARE HERE: one residual stage-2 UAF blocks the full
   self-compile** — `expr_info_table_get` returns a freed ExprInfo during
   `evaluate_initialization_assignment` on any nontrivial module
   (5-second repro + guard-malloc pin + verified-clean components in
   issues/yo-self-stage2-unwind-check-coverage.md).
   The residual UAF (`evaluated_callee` double-drop) was fixed 2026-07-12
   (commits 6b5c0ceb0, 4b3fc4043 — `set_expr_as_needs_to_call_dup` env store
   - `___dup(evaluated_callee)`). Corpus diff-test PASS / DIFF 0, `check ./std`
     clean.
3. Verify the **self-hosting fixpoint** (required, see below).
   **← YOU ARE HERE (2026-07-13): NOT a hardware limit — the self-compiled
   binary LEAKS ~60GB compiling `main.yo`.** Prior "needs a 32GB box" (task
   #21) is a MIS-DIAGNOSIS: the control binary s1 (TS-compiled yo-self) does
   the identical compile in 76s / 9.2GB peak and COMPLETES; s2 (self-compiled)
   balloons to 56-73GB (compressed — RSS lies, watch `top -stats mem,cmprs`)
   and is jetsam-killed (rc=137). It is an **eval-phase RC leak**, dominated by
   callee-environment Variables (`new_variable`, 2.7M+ live at 15s) never
   dropped on the `__yo_effect_escaped` throw-propagation paths that fire
   millions of times during def-time trial-eval. This is a yo-self codegen
   drop-emission divergence from TS (which reclaims the dead state via its
   tracing GC). Full root + repro + fix direction:
   **`issues/yo-self-fixpoint-eval-phase-leak.md`**. Fixing this leak (not more
   RAM) unblocks item 3 and item 4.

   **STATE (2026-07-13, LATEST) — leak ROOT-CAUSED + FIXED (TS fully, yo-self
   partially); the earlier "node-attached ExprInfo ~750-site" plan below is
   SUPERSEDED.** The real bug was NOT the never-pruned table per se — it was the
   `declaredCVarNames` drop-skip gate (commit 68f5cb49c) skipping ~88,000 live-RC
   temp drops: `declaredCVarNames` was grown only via `getVariableTypeString`, but
   ~30 result/argument temp-declaration paths build the declaration via
   `getTypeString` → untracked → the gate wrongly skipped their drops → the 6x
   leak (invisible to corpus — a leak, not a double-free, leaves output unchanged).
   FIX = centralize declaration tracking in the Emitter (record every codegen temp
   DECLARED in an emitted code line, in C-emission order):

   - **TS codegen — FULLY FIXED (commit 0b9928b95):** s1's `main.yo` emission
     **56G → 9.2G and COMPLETES** (produces stage2.c). temp-drops 20021 → 107960
     of 108281 (the 321 remaining = the one genuine phantom). corpus PASS 118/DIFF 0.
   - **yo-self codegen — PARTIAL (commit 2e329eeee):** ported the Emitter capture
     (manual parse, no regex). s2 (built from yo-self-codegen-emitted stage2.c)
     **56G → 26G**, builds, s2 RUNS, corpus PASS 118/DIFF 0.
   - **Fixpoint chain run:** s1→stage2.c @9G ✓ → build s2 ✓ → s2→stage3.c reaches a
     26G plateau but OOM-kills on this **16GB** box → `diff` not produced HERE.
     **RUNNABLE NOW on a 32GB box** with these commits (26G < 32GB).
   - **Residual (26G→9G on 16GB):** temps declared UNINITIALIZED then branch-assigned;
     their valid post-init drops are still skipped (init-decl-only recording misses
     them). Three recording-broadening shortcuts were tried + reverted (blind→clang
     errors; uninit-`;`-decl→s2 startup crash; init-assignment→s2 startup crash) —
     a flat `declared_c_var_names` set cannot model cross-branch init state.
     TRUE FIX = strengthen yo-self's pre-init-drop guard
     (`_variable_initialized_after_cleanup_point`/`initialized_at_token`, return.yo)
     to TS parity (per-branch init tracking); a separate control-flow-correctness
     effort that must be validated with the full s1→s2→stage3 chain (corpus cannot
     catch the crash). Full analysis: `issues/yo-self-fixpoint-eval-phase-leak.md`.

   ***

   **(SUPERSEDED — historical) root cause was the unported M3 milestone; codegen half
   LANDED, evaluator half is an architecture task:**

   - The leak = yo-self's `_schedule_scope_end_drops` (begin.yo) big-hammer
     SKIPS scope-end drops for every control-flow-bearing block (`skip_block`),
     so `callee_env` + per-call env Variables are never dropped. TS has the M3
     early-return-drop machinery (begin.ts:2064-2140) and does not leak.
   - **DONE + committed (`68f5cb49c`):** the TS-codegen `declaredCVarNames`
     drop-emission gate — removing `skip_block` otherwise trips a latent
     undeclared-C-temp cascade (20 clang errors); with the gate, s1 builds M3
     with **0 errors**. Gate alone is regression-free (s1 clean, `check ./std`
     153/153, corpus PASS 118 / DIFF 0 / SELF-FAIL 0).
   - **BLOCKER (do NOT just re-apply `skip_block` removal):** M3 as a faithful
     port explodes s1's _compile-time_ memory to 56GB (rc=137) — it eagerly
     builds+pins a `___drop` AST node per owning-RC local per block per
     specialization on ExprInfo (via `generate_expr_from_code`), and the
     compiler's giant control-flow fns × specializations make it unbounded.
     RULED OUT (commit `8bac1ddbf`): aggressive GC (`YO_GC_THRESHOLD=64`, nodes
     are pinned not cyclic) and direct AST-build (cost is node COUNT).
   - **ROOT CAUSE PINNED (2026-07-13):** the leak is NOT drop-node-specific — it is
     the never-pruned global `expr_info_table` (`expr_info.yo:456`,
     `HashMap<ExprId,ExprInfo>`), where every `ExprInfo` holds an `env` snapshot
     (`expr_info.yo:317,410`). TS stores this on the node (`expr.$`,
     `src/expr.ts:495,510`), so V8 GC reclaims a specialization's `$` (incl its `env`)
     once its cloned AST is unreachable → bounded. yo-self keeps every entry forever →
     ~60GB compiling main.yo; removing `skip_block` (M3) adds an env-carrying `___drop`
     node per owning-RC local per (ubiquitous) control-flow block → +56GB. See the full
     analysis in `issues/yo-self-fixpoint-eval-phase-leak.md`.
   - **ALL cheap shortcuts RULED OUT (each committed as evidence this session):**
     null-`env`-post-eval (codegen READS `info.env` — 216 TS / 73 yo-self sites, incl
     `get_variables_from_env`); per-specialization table pruning (no safe reclaim
     boundary — specialization is interleaved/lazy and each body is re-walked by
     multiple later codegen passes, frames shared across functions); `is_executing`
     mode-gate (corpus **DIFF 6** — drops are needed in non-executing mode too).
   - **THE FIX (task #21) — node-attached ExprInfo, faithful 1:1 with TS `expr.$`:**
     add `info : ref(Option(ExprInfo))` to `AstExpr.Atom`/`FnCall` (`expr.yo:283-284`);
     rewrite the ~635 `expr_info_table_get/set` call sites (all have the node in scope —
     627 inline `ast_expr_id(node)`, 8 via node-in-scope id locals) to read/write
     `node.info.*`; init the cell in the ~119 `AstExpr` constructors + parser + the
     `Clone` impl (shares the cell = today's same-id semantics) + `clone_expr_fresh_ids`
     (fresh `ref(None)` = TS `$: undefined`) + `make_err_expr`. Then a dropped
     specialized body reclaims its nodes' ExprInfos+env snapshots = TS GC → bounded.
     Must land **atomically** (cannot stage green: a node written via table but read via
     cell returns `None` → breakage). After it lands: re-apply `skip_block` removal on
     the landed `declaredCVarNames` gate (`68f5cb49c`), validate corpus+std, rebuild s2,
     confirm `s2 emit main.yo` footprint bounded (~≤10GB), then run the fixpoint. This is
     a ~750-site mechanical-but-atomic refactor scoped for a dedicated multi-hour
     effort — it is NOT bounded-turn-safe (cannot be landed AND fully validated within a
     single turn without risking the verified-green compiler).

4. Tasks **#69** (`stage-2-binary test ./tests` passes) and **#70**
   (`test ./yo-self/tests` passes) — gated on item 3's leak fix.

**Faithful-port discipline (non-negotiable):** for every bug — (1) confirm the
TypeScript compiler (`./yo-cli`) behaves correctly on the same input; (2) find
the yo-self DIVERGENCE from `src/`; (3) fix yo-self to match `src/`. If TS is
also wrong, fix TS first, then port. NO workarounds, NO stubs.

---

## PREVIOUS ENTRY POINT (SURPASSED 2026-07-10 — kept for the repro recipe)

```bash
# Reproduce in ~10 min from a clean tree:
./yo-cli compile yo-self/main.yo -o /tmp/s1                       # stage-1 (~5 min)
/tmp/s1 compile yo-self/main.yo --emit-c --skip-c-compiler -o /tmp/stage2   # (~3 min)
clang -std=c11 -ferror-limit=0 -c /tmp/stage2.c -o /dev/null -I.  # expect 0 errors
clang -std=c11 -w -O0 /tmp/stage2.c -o /tmp/s2                    # stage-2 binary
YO_MAIN_STACK_MB=16384 /tmp/s2 check tests/codegen-bootstrap/template_multibyte.yo
# → prints "parsed 0 top-level exprs" for EVERY file (prelude AND user files)
```

**Everything else cascades from parse-0**: empty codegen types table (~2
structs instead of dozens), NO user functions emitted (its "successful"
compiles produce a runtime-only skeleton — `clang` on its output fails with
undefined `_main`), wrong `needs_cycle_gc` verdict (Lightweight vs cycle-GC
preamble), vacuous "evaluator OK". The stage-2 binary's LEXER or PARSER
yields zero expressions from valid source. 4 rounds of C-diffing proved the
downstream analysis functions (`compute_needs_cycle_gc`,
`can_type_form_rc_cycle`, `buffer_element_type`, `_type_refs_back_to_cyclic`)
are compiled FAITHFULLY — they run on missing data.

### Debug strategy (in order)

1. Find where `"parsed N top-level exprs"` is printed (main.yo check path)
   and what feeds N. Determine WHICH stage fails: file-read (empty String?),
   lexer (0 tokens?), or parser (tokens in, 0 exprs out).
2. **Instrumentation caveat**: eprintln/probe code added near the codegen
   analysis region CRASHED every instrumented stage-2 build (139/138) while
   probe-less builds ran — the binary is fragile to source perturbation.
   Probes in the LEXER/PARSER region are untested and may be fine; if they
   also crash, use **lldb breakpoints on the stage-2 binary directly**
   (function names findable in `/tmp/stage2.c` by grepping distinctive
   string constants, e.g. `"unterminated template string"` → the lexer fn)
   and inspect counts in the debugger WITHOUT rebuilding.
3. The corpus programs (107 tests) emitted by stage-1 all run correctly —
   so the miscompiled construct is something the COMPILER binary uses that
   small programs don't: candidates = module-level mutable globals, the
   file-read path (`read file → String`), very large functions, cross-module
   global maps. A cheap test: point `/tmp/s2` at a NONEXISTENT file — does
   the error path differ from a real file (i.e. is the read returning
   empty)?
4. Once parse-0 is fixed, re-run the mini-fixpoint (below), then the chain.

### Known stage-2-binary environment facts

- `-O0` binaries need `YO_MAIN_STACK_MB=16384` for compile paths (8192
  suffices for `check`); rc 138/139 with an empty log = stack, not logic.
- ~~Bug #2c (`-O1` hang)~~ — SUPERSEDED 2026-07-11: stage-2 binaries are
  now built at `-O2` (clang -std=c11 -w -O2) and run correctly (sandbox,
  real-prelude check, fmt). No hang observed at -O2.
- `sample <pid> 5` on a hung process names the looping fn in one shot
  (worked twice this session). Bad-address values decode as ASCII — e.g.
  `0x2e6c746e63663c20` = `" <fcntl."` = string bytes dereferenced as a
  pointer.

---

## Fixpoint requirement (BEFORE tasks #69/#70 — user requirement)

1. **Stage-2 ≡ Stage-3 (required).** Build the stage-2 binary from stage-2 C,
   have IT emit yo-self again, require byte-identical:

   ```bash
   clang -std=c11 -w -O0 /tmp/stage2.c -o /tmp/s2
   YO_MAIN_STACK_MB=16384 /tmp/s2 compile yo-self/main.yo --emit-c --skip-c-compiler -o /tmp/stage3
   diff /tmp/stage2.c /tmp/stage3.c && echo FIXPOINT-OK
   ```

   Prereq (emission determinism) is DONE — stage-1-emitted stage-2 C is
   byte-identical across runs.

   **STATUS 2026-07-13:** Items 1 & 2 CONFIRMED (stage2.c clang-compiles 0
   errors; UAF fixed). The M3 drop-fix is committed green (corpus 118/0/0);
   it cut the s2 leak 56-73GB→~26GB. **Mini-fixpoint now PASSES** — s1 and s2
   emit BYTE-IDENTICAL C (after `_temp_[0-9]+`/`yo_id_[0-9]+` normalization,
   the only difference being temp-ID numbering) for `empty_main`,
   `fn_body_arith`, `extern_c_puts` (parse-0 cascade is long gone). So the
   yo-self codegen IS a deterministic fixpoint on real inputs.

   **The full-main.yo byte-exact diff (line 202-205) is BLOCKED by perf**, not
   correctness: s2 emits main.yo at ~26GB and the full-heap cycle GC goes
   near-quadratic over that tracked set, so the emit does not complete in a
   reasonable time on a 16GB box (>58min, no completion). `YO_GC_THRESHOLD=0`
   runs fast (~226s) but OOMs at 98GB (the extra heap is reclaimable cyclic
   garbage); `YO_GC_FULL_PCT=130` bounds memory but is slower still. The fix is
   to reduce s2's tracked set to ≈ s1's 10GB by closing the drop-SCHEDULING gap
   (yo-self emits ~7x fewer owned-local drops than TS → cycles survive to the
   GC). See issues/yo-self-fixpoint-eval-phase-leak.md and (BLOCKER, fix first)
   issues/yo-self-gc-traverse-value-struct-field.md.

2. **Stage-1 ≡ Stage-2 (aspirational port-fidelity metric).** Track
   `diff stage1.c stage2.c | wc -l` and drive it down; do NOT block #69/#70
   on byte-equality here — corpus diff-test + level 1 are the correctness
   gates.

---

## Iteration loop + validation gates (EVERY change)

```bash
# Stage-1 rebuild after any yo-self/*.yo edit — ALWAYS -O2 (user directive
# 2026-07-10: -O2 everywhere; kills the -O0 stack-exhaustion class and runs
# the evaluator ~4-10x faster; clang takes a few extra minutes):
./yo-cli compile yo-self/main.yo --release -o /tmp/yo-self-bin &> /tmp/build.txt
tail -1 /tmp/build.txt    # must be "Successfully compiled ..."

# Gates (non-negotiable; REVERT on any regression):
YO_SELF_BIN=/tmp/yo-self-bin bash scripts/diff-test.sh tests/codegen-bootstrap/ --parallel 4
#   → must be 107/107, DIFF 0 (this is also the RC double-free/leak oracle)
/tmp/yo-self-bin check ./std          # → must be 152/152

# Stage-2 chain when relevant (~5 min):
/tmp/yo-self-bin compile yo-self/main.yo --emit-c --skip-c-compiler -o /tmp/stage2
clang -std=c11 -ferror-limit=0 -c /tmp/stage2.c -o /dev/null -I. 2>&1 | grep -c "error:"  # expect 0
```

- Run TWO stage-2 emits and `diff` when touching type identity — emission
  must STAY byte-identical.
- Never run clang on a stage-2 .c while another emit writes it.
- `./yo-cli fmt <file.yo>` on every touched file before committing; never
  put probe edits in the same Bash command as `git commit` (lint-staged
  stash clobbers them).
- Commit convention: `Co-Authored-By:` line naming the agent, message
  citing the gates run.

## Debugging lessons that will save you rounds

- **GROUND TRUTH = the emitted .c file.** eprintln `${}` probes in either
  binary render through the very string machinery under test and can lie;
  prefer emitting C comments via `context.emitter.emit_declaration_string_line`
  or byte dumps (decimal `byte_at` loops).
- **`String.len()` counts CHARACTERS** (std skips UTF-8 continuation
  bytes); `as_bytes().len()` and builtin `str.len` count BYTES;
  `substring()` is CHAR-indexed; `byte_at()` is BYTE-indexed. Byte loops
  bounded by `String.len()` silently corrupt multibyte content (this root
  caused runtime bug #1). A same-class audit remains OPEN in: formatter.yo,
  token.yo, codegen/utils/index.yo, codegen/exprs/{match,init_assignment,cond}.yo.
- Yo probe gotchas: probes with locals inside match arms can trip "Frame
  level N has different number of values"; keep probes single-expression.
  Module-level globals can't be reassigned cross-module — use setter fns.
  `export` needs the call form: `export main;` fails to parse — write
  `export(main);`.
- Extracting a fn from a 15-50MB .c: find the DEFINITION line
  (`grep -n 'static.*<name>(' file`, take the one ending `) {`), then
  brace-match with a **string-literal-aware** scanner (naive matching
  breaks on braces inside strings).
- Minimal repros in `src/tests/fixme.yo` (scratch, no restore needed) give
  seconds-fast loops vs ~10-min stage-2 rounds. TS-side probes (edit
  `src/`, `bun run build`, seconds) beat yo-self probe builds for
  which-mechanism questions.

---

## Resolved this session (do NOT re-litigate; git log has full details)

| Fix                                                                                                            | Commit theme                                       |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `(*self)->` member-ref: exact-binding `is_ref` + removed env-wide spec marking                                 | fix(yo-self): io.async closure self-capture family |
| io.async closure FTT: Step-10 adopt-expected-return + Step-6b `T` pre-bind                                     | same commit                                        |
| argv if-arm Index FTT: begin-block single-expr clobber carries index-trait ExprInfo fields                     | fix(yo-self): carry index-trait ExprInfo…          |
| undeclared `get_info`: FuncVal-valued args bind runtime (capturable), not comptime                             | fix(yo-self): FuncVal-valued args…                 |
| …plus capture-in-capture struct emission order + box-of-closure collection carve-out                           | fix(yo-self): closure-valued capture…              |
| undeclared RC-temps: undeclared-minted-temp gate at all THREE deferred-drop emitters                           | fix(yo-self): gate undeclared minted-temp…         |
| flaky GC-tracer cluster: type_key depth-cap removal + poison-slot structural keys + trace registry by type_key | fix(yo-self): instantiation-precise type identity  |
| poison sentinel ("!AMBIG") leaking via cycle guard (3310 C-identity collisions)                                | fix(yo-self): poison sentinel must not leak        |
| **Runtime bug #1**: multibyte template corruption — byte loops bounded by char-counting `String.len()`         | fix(yo-self): byte-counted bounds…                 |
| 35 latent `substring(1, len()-1)` unquote sites → byte-exact `str_lit_unquote_bytes` (utils.yo)                | fix(yo-self): byte-exact StrLit unquote…           |

New corpus tests: `tests/codegen-bootstrap/template_multibyte.yo`,
`if_arm_index_call.yo`, `closure_param_capture.yo`, `dyn_fn_field.yo`
(corpus now 107).

Related issue docs: `issues/fixed/yo-self-close-self-capture.md`,
`issues/fixed/yo-self-closure-capture-followons.md`,
`issues/fixed/yo-self-dyn-fn-field.md`.

---

## Evaluator performance parity (user requirement, 2026-07-10)

`check ./yo-self` must be in the same league as TS. Measured (Mac mini M4):

| run                                                                 | time                          |
| ------------------------------------------------------------------- | ----------------------------- |
| TS `./yo-cli check ./yo-self` (303 files, one shared ModuleManager) | 78 s                          |
| yo-self -O2, `check yo-self/tests/expr_traversal.test.yo` ALONE     | 26.7 s                        |
| TS, same single file alone                                          | 20.4 s                        |
| yo-self -O2, `check ./yo-self` cumulative                           | RUNAWAY at file 167 (>36 min) |

Single-file parity is already fine (~1.3x). The blocker is CUMULATIVE
directory checks: after ~166 files of accumulated GLOBAL registry state the
same file's own top-level eval recurses unboundedly
(evaluate_recur → create_specialized_function_inline → begin, stack depth
1421+ and growing; `sample <pid>` confirms). PRE-EXISTING — the pre-fix
binary shows identical single-file times, and the -O0 gate crash at file
167 (rc=139, 4 GiB stack) is the same phenomenon. NOT caused by the
2026-07-10 RC/frontend fixes. Prime suspects: per-name registry growth
(get_type_trait_methods_by_name candidate lists accumulate across files →
overload trial-matching explosion), NOT the module cache (demand loader
caches across files like TS).

## Definition of done (tasks #69, #70)

Once the stage-2 binary works and the fixpoint holds:

1. **#69:** `/tmp/s2 test ./tests --parallel 8` passes what
   `./yo-cli test ./tests` passes (~30 min under TS; the -O0 stage-2 binary
   is ~10× slower — consider building stage-2 at `-O1`/`-O2` once bug #2c is
   fixed, or run a representative subset first, e.g.
   `test tests/algebraic_effects.test.yo --parallel 1`).
2. **#70:** `/tmp/s2 test ./yo-self/tests` likewise (eval_basics/eval_tail_1/
   eval_tail_2 exceed the runner's 1800s limit — known-heavy, validate those
   via check + sweeps per `yo-self/README.md`).

---

## Key artifacts from the last session (in /tmp, regenerate if gone)

| Path                     | What                                                       |
| ------------------------ | ---------------------------------------------------------- |
| `/tmp/stage1-ref.c`      | TS-emitted reference C of yo-self (52MB)                   |
| `/tmp/stage2Q1.c`        | clean stage-2 C (probe-less, sentinel-fixed)               |
| `/tmp/s2g-out.c`         | the SKELETON emit the stage-2 binary produced (1342 lines) |
| `/tmp/s1j.c`             | stage-1's emit of the same small file (2499 lines)         |
| `/tmp/fn-s1.c`,`fn-s2.c` | extracted compute_needs_cycle_gc bodies (both faithful)    |

## Key code locations

| File                                      | Purpose                                                  |
| ----------------------------------------- | -------------------------------------------------------- |
| `yo-self/main.yo` (check path)            | prints "parsed N top-level exprs" — the parse-0 entry    |
| `yo-self/lexer.yo`                        | template scan :316-425; token creation :424              |
| `yo-self/parser.yo`                       | parse_template_string :325                               |
| `yo-self/types/type_key.yo`               | identity: cfid keys, poison slot, cycle guard            |
| `yo-self/types/utils.yo`                  | can_type_form_rc_cycle :737, str_lit_unquote_bytes       |
| `yo-self/codegen/codegen_c.yo`            | compute_needs_cycle_gc :76, run pipeline                 |
| `yo-self/codegen/exprs/comptime_value.yo` | \_strip_str_delims / \_c_string_literal (byte-len fixed) |
| `yo-self/codegen/functions/collection.yo` | function/type collection, trace specialization           |
| `src/` mirrors                            | the TS reference for every file above                    |

Memory notes for future sessions: `yo-self-stage2-endgame`,
`yo-string-len-chars-vs-bytes` (in the agent memory directory).
