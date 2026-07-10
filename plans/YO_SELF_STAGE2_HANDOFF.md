# yo-self self-hosting — HANDOFF PLAN (fresh-agent entry point)

_Last updated 2026-07-10 (after the assert/panic repair + RC-protocol +
stage-2-clang-0 sessions; tree clean, all fixes committed on
`feat/bootstrap-codegen`; corpus now 111 files)._

**Goal:** make yo-self compile itself **correctly**:

1. ~~Stage-2 emit: 0 clang errors~~ — **DONE, deterministic** (re-verified
   2026-07-10 after regressing to 416 during the assert refactor; the four
   fixes are in issues/fixed/yo-self-stage2-clang-errors.md).
2. **← YOU ARE HERE: fix the stage-2 BINARY runtime.** The old
   "parsed 0 top-level exprs" frontier is SURPASSED (compound-literal RC +
   value-enum dup fixes): the stage-2 binary now parses argv, reads files,
   and runs its lexer/parser. TWO new stage-2-only divergences:
   - `s2 check <any file>` → "paren-less function and operator calls are not
     supported" at std/prelude.yo:20:0 (`export(Comptime);` right after
     `Comptime :: trait(id := "Comptime")`) — the stage-2 PARSER mis-parses
     a construct stage-1 accepts. NOTE: the error prints an EMPTY module
     path (" --> :20:0") — possibly a second, smaller string bug.
   - `s2 fmt --check <file>` → panics `"HashSet ctrl pointer is null"`.
     Both only manifest on the compiler's own code shapes — small workouts
     (HashSet/HashMap-of-String, argv echo) agree with TS. `fmt` is the
     PRELUDE-FREE parse probe (parses only the given file); prefer it for
     parser bisection.
3. Verify the **self-hosting fixpoint** (required, see below).
4. Tasks **#69** (`stage-2-binary test ./tests` passes) and **#70**
   (`test ./yo-self/tests` passes).

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
- **Bug #2c (parked)**: the same clean binary at `-O1` HANGS (infinite loop
  in the inlined driver) while `-O0` runs — likely UB-in-emitted-C exposed
  by optimization. Fix after parse-0; `-O0` is usable meanwhile.
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

   **Mini-fixpoint (fast signal, run first):** both binaries emit the same
   SMALL file; diff. Currently FAILS via the parse-0 cascade (stage-2 emits
   a skeleton).

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
