# yo-self Stage-2 Handoff — #69 Campaign

_Last updated 2026-07-25. `git log` of this file has the full archaeology;
per-bug details live in `issues/*.md` — do not re-litigate fixed bugs._

## Status

- **#70 (`s2 test ./yo-self/tests`): DONE — 61/61.**
- **#69 (`s2 test ./tests`): 161/183 committed** (`4bf8cb418` +
  `2764b90cf` comptime_int forall fix — prelude GREEN, comptime
  regression caught by the r3 sweep and fixed the same day; full gates
  incl. STRICT_FIXPOINT; verification sweep at /tmp/sweep69_r6).
  LESSON now in THE METHOD: verification sweeps catch what the battery
  misses — never skip the post-commit sweep, and grow the battery with
  every near-miss (comptime.test is now permanent).
- **PERF (priority 1) is under way and measured** — `check ./std`
  87.35 s → 31.02 s (2.82x), stage2 emit ~55-65 → 46.8 min. See
  "1. PERFORMANCE FIRST" below for the numbers, the two dead ends not
  worth repeating, and the next lever.
- Recent commits (each fully gated incl. STRICT_FIXPOINT):
  `920c2876d` match-place dup elision (perf),
  `99ba71265` capture-split (arc GREEN), `7823007ba` rc layer 4
  (rc GREEN), `7fe90d289` witness resolution (iso GREEN), `0bca00991`
  tuple keys, `2319ecc…/2319c` array-wrapper order, `09cb5fd14` Gap-6
  attempt #8 (imm_list + imm_string GREEN).

## Definitions

- **s1** = TS-compiled yo-self binary:
  `./yo-cli compile yo-self/main.yo --release -o /tmp/s1` (~10 min).
- **stage2.c** = C that s1 emits for yo-self itself; **s2** = clang -O2
  of it. Emits take ~55-65 min EACH (see priority 1).
- **STRICT_FIXPOINT** = stage2.c ≡ stage3.c byte-identical (s2
  re-emitting yo-self).
- A test file "matches" when `<bin> test <file>` rc==0 with the same
  pass count as `./yo-cli test <file>`.

## Priority order (user directive 2026-07-24)

### 1. PERFORMANCE FIRST — cut self-compile from ~55 min to ~15 min

**In progress, measured.** Full detail:
`issues/yo-self-compile-performance-rc-string-eq.md` +
`plans/PERF_BORROW_ELISION.md`.

`check ./std` (evaluator-only proxy): **87.35 s → 31.02 s, 2.82x.**
stage2 emit: **~55-65 min → 46.8 min** (only ~1.3x — see the warning
below).

| step                                   | min user | delta  |
| -------------------------------------- | -------- | ------ |
| baseline                               | 87.35 s  | —      |
| `920c2876d` TS match-place dup elision | 79.90 s  | -8.5%  |
| yo-self port + 2 hot predicates        | 31.02 s  | -61.0% |

What actually mattered — all measured, none of it guessed:

- A `check ./std` performs **10.8e9 `__yo_decr_rc` + 9.2e9 `__yo_incr_rc`
  calls and 1.64e9 frees**. Sampled return-address attribution
  (`scratchpad/patch_rc_attrib.py`) put ~60% of decr traffic in three
  functions that all `match` on a FIELD.
- The dominant cost was **allocation, not refcounting**:
  `ast_expr_is_atom_of` / `ast_expr_is_fn_call_of` built a whole String
  (`== String.from(value)`) just to compare against a `str` — a
  malloc+free at ~2.9e9 calls. Two lines gave -61%.

**Dead ends — do not repeat:** an `always_inline` `__yo_decr_rc` fast
path is **-4.7% for +140% binary** (per-call overhead is NOT the lever);
a String `==` pointer fast path measured zero.

**NEXT LEVER (highest value):** 143 `== String.from(x)` + 15
`!= String.from(x)` sites remain, **concentrated in codegen** —
`codegen/exprs/inline_fns.yo` (46, a ~46-arm `cond` allocating per arm on
every inline-fn dispatch) and `codegen/exprs/generation.yo` (26).
Scanner-based rewriter ready and unit-tested:
`scratchpad/rewrite_string_from_cmp.py`; file list = 28 non-test files.

**MEASURE THE RIGHT THING.** `check ./std` is evaluator-only and does
NOT exercise codegen — that is exactly why the emit moved 1.3x while the
proxy moved 2.82x. Measure any codegen round with a REAL emit
(`<s1> compile yo-self/main.yo --release --emit-c --skip-c-compiler`),
not the check proxy. `scratchpad/perf_ab.sh <binA> <binB> 3` alternates
arms so machine drift hits both equally.

Then: `_attach_early_return_only_drop_to_returns` (13.9% / 1.5e9 calls)
walks the ENTIRE begin-block subtree once per early-return variable, and
nested blocks re-walk what inner ones already did — but it only acts on
`return`/`unwind` nodes, and `Expr.$` already carries a merged subtree
control-flow summary (`expr.ts:248`). An early exit when neither
`controlFlow.return` nor `.unwind` is set should prune most of it; stay
conservative where `$`/`controlFlow` is undefined.

Rules: a perf change must be behavior-identical (same test counts,
corpus PASS 140 / DIFF 0, FIXPOINT holds); run the FULL gate chain per
change (`scratchpad/gates_perf1.sh` is the current template).

### 2. Round 2' — imm/collections comptime-param spec model (6 files)

`imm_set, imm_map, imm_sorted_map, imm_sorted_set, imm_vec,
imm_threading`. A COMPLETE WIP diff exists:
`scratchpad/round2_param_model_wip.patch` (707 lines, `git apply`) —
the inline-arm spec-gate broadening (TS guards.ts:457) + the faithful
comptime-param parameter model (comptime args → cache key + sig
segments; runtime lists/spec types/call args runtime-only; direct
self-recursion forward-ref). It was reverted because two DEEPER bugs
block it (full diagnosis: "Round-2 outcome" entry at the end of
`issues/yo-self-gap6-ctor-memo-reconciliation-attempt7.md`):

1. **Pattern-era pointer-Self leak**: inside the newly-activated
   specialized bodies, `*(<pattern-era instance>)` unifies against
   `*(<concrete instance>)` and fails (check-mode repro shows
   `Expected: *(<struct_A>) / Actual: *(<struct_B>)`); the call result
   degenerates to unit. Fix FIRST (extend the attempt-#8
   receiver-instance adoption to pointer-wrapped Self in spec bodies).
2. **Silent-abort**: that failure kills the REST of the module-body
   eval with rc=0 and hollow `// Failed to transpile` C (vacuous
   passes). Make it loud before re-applying the patch.

Repros: `issues/repros/imm-map-unspecialized-comptime-helper.yo`
(+ /tmp/imm_map_probe_b.yo, /tmp/imm_set_probe.yo shapes in the ledger).

### 3. Remaining red families (~16 more files)

| Family                | Files                                                         | Diagnosis / pointer                                                                                                                                            |
| --------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| async-SM layer        | thread, worker                                                | post-capture-split: `sm->var_NNN` / void-variable C errors in async state-machine emission                                                                     |
| sync/\*               | atomic, channel, mutex, once, rwlock, waitgroup               | once = STORED-closure capture identity (field-held closure, not covered by the call-arg split); atomic = `__yo_new___yo_tN` ctor never emitted; rest untriaged |
| ordered collections   | ordered_map, btree_map, priority_queue                        | whole-body "Failed to transpile" + `dispose_fn` referencing never-emitted drop method (ref structs with HashMap/ArrayList fields)                              |
| closure identity tail | ref_closure_capture, closure_capture_rc_leak                  | closure return-type identity; spec names with `unknown` forall segments                                                                                        |
| singles               | cli/arg_parser, derive_clone_complex, impl_fn_field_rejection | each its own class; untriaged details in the g14 sweep logs (/tmp/sweep69_g14/\*.log)                                                                          |

Sub-class evidence for all of these: END of
`issues/yo-self-gap6-ctor-memo-reconciliation-attempt7.md`
("Residual-red classification" entry).

### 4. Step 3 finalization (after #69 or when instructed)

Fixpoint re-verify, move resolved `issues/*.md` to `issues/fixed/`,
update `yo-self/README.md`, mark `plans/BOOTSTRAPPING.md` historical.

## THE METHOD (non-negotiable — proven over ~35 fix rounds)

1. **Faithful port first.** Find the TS behavior (file:line), port that
   shape. When yo-self's model genuinely differs (value semantics vs TS
   object identity, mutable shared env vs persistent chains), document
   the divergence in a comment AND pick the semantically equivalent
   mechanism. Being broader OR narrower than TS both break self-compile.
2. **Full gate battery after EVERY yo-self change; revert on ANY
   regression.** Template: `scratchpad/gates_r3.sh` (repros → ~19-file
   battery → corpus diff-test → `check ./std` → stage2 emit+clang →
   stage3 emit → `cmp` FIXPOINT). Green baseline: corpus PASS 140 /
   DIFF 0, std 153/153, battery at its counts, FIXPOINT HOLDS.
3. **Gate hygiene — no hollow greens.** A yo-self binary can exit rc=0
   while the emitted C contains `// Failed to transpile <stmt>` for
   every statement (asserts never run; tests pass vacuously). Every
   repro gate must compare `grep -c "Failed to transpile\|Unknown
type:" <emitted.c>` against the TS emit of the same file (usually
   0). Harness: `scratchpad/probe_cf5.sh`.
   Same rule for the MEMORY-SAFETY gate: **AddressSanitizer does not
   work on this box** — `yo-cli` detects the broken runtime and silently
   skips instrumentation (`compiler-utils.ts:96`), so
   `--sanitize address` compiles, exits 0, and proves NOTHING (and
   grepping the log for "AddressSanitizer" just matches yo-cli's own
   skip warning). Use Guard Malloc instead:
   `scratchpad/guardmalloc_corpus.sh` — verified to actually FAIL on a
   planted use-after-free (SIGSEGV) and double free (SIGABRT).
   Prove a gate can fail before trusting it to pass.
4. **Probe before fixing.** `println` probes (files need
   `open(import("std/fmt"))`; helpers must be defined ABOVE first use —
   no forward refs). ~10-12 min per s1 rebuild — BATCH probes; strip
   ALL before gates. TS-side ground truth is cheap (console.error +
   `bun run build`).
5. **Batch shape matters.** `YO_KEEP_BATCH=1 <bin> test <file>` keeps
   `.yo_selftest_batch_N.yo` + `.bin.c`. Batches regenerate per run.
6. **Long jobs die on this box.** rc=133/137/138/139 with a ZERO-byte
   log = phantom kill — always retry before believing a crash. `nohup …
&`, keep artifacts in /tmp, resume from the last stage. Never run
   two `test` invocations over ./tests concurrently; never edit
   yo-self/\*.yo while a build/emission reads the tree; never swap a
   binary a sweep is running.
7. `./yo-cli compile` cannot take `*.test.yo` — extract a standalone
   repro with `main` + `export(main)`.

## BUILD / VERIFY COMMANDS

```bash
bun run build                                          # before any yo-cli work
./yo-cli compile yo-self/main.yo --release -o /tmp/s1  # s1 (~10 min)
/tmp/s1 compile yo-self/main.yo --release --emit-c --skip-c-compiler -o /tmp/stage2
clang -std=c11 -fno-strict-aliasing -fwrapv -w -O2 /tmp/stage2.c -o /tmp/s2
/tmp/s2 test ./tests/<file> --parallel 1               # the #69 definition
YO_SELF_BIN=/tmp/s1 scripts/diff-test.sh tests/codegen-bootstrap --release --parallel 4
YO_MAIN_STACK_MB=4096 <bin> …                          # deep-recursion checks
./yo-cli check yo-self/<file>.yo                       # fast type-check loop
./yo-cli fmt yo-self/<file>.yo                         # REQUIRED before commit
scratchpad/sweep69.sh                                  # full 183-file sweep
                                                       # (S1=<bin> OUT=<dir>, resumable)
```

Always `--release` (user directive). Save verbose output to files.

## HARD-WON INVARIANTS (violate these and you will re-live old sessions)

- **Per-call / per-closure type identity is THE recurring theme**
  (Gap-6). Do not weaken: `_freshen_io_builtin_callee`, call-scoped
  forall rebinds + lineage-identity gate (types/synthesizer.yo), the
  clfid spec-cache keying + per-spec SomeT rebuild (capture-split,
  calls/helper.yo), receiver-instance Self adoption (attempt #8,
  expr_info.yo helpers).
- **SomeT.resolved_concrete is a SHARED-LINEAGE cell** — per-call/-spec
  resolutions must rebuild a FRESH SomeT + cell (see the HAZARD note on
  the field), never write the shared id last-wins.
- **THE SHELL PATTERN:** any walker of struct fields / enum variants may
  receive a recursive-`Self` SHELL (empty lists) — call
  `resolve_enum_shell(resolve_struct_shell(ty))` first.
- **`Some(UnknownVal)` ≠ a value.** Every ported TS `if (expr.$.value)`
  gate needs an `is_unknown_val` guard.
- **Pointer arms:** type-shape dispatch without a `Pointer` case
  silently no-ops for pointer-receiver methods.
- **Chars vs bytes:** `String.len()` is CHARS; byte loops use
  `bytes_len()`/`byte_at()`.
- **Retroactive envs:** ExprInfo envs share mutable Frames — "was X
  bound here" must use the emitter's C block-scope stack, not env
  lookups.
- `runtime_arg_exprs_in_order` has a slot per runtime arg only on the
  try_to_call path; the inline arm now also filters comptime args —
  keep the two consistent.
- New consumers of the generic-impl registry must import via impl.yo's
  re-export (a direct import once duplicated
  `g_impl_registry_entry_lists` in the TS compile).
- Yo syntax: `:=` immutable (reassign needs `(x : T) = …`); no forward
  refs; no nested match patterns; single-expression `{ }` parses as a
  struct literal; `fn` defs are `name :: (fn(...) -> T)({ ... })`;
  standalone repros need `open(import("std/fmt"))` for println.
- fmt every touched .yo file; lint-staged reformats .md on commit.
- rc=139 at -O0 on deep recursion = stack exhaustion (use `--release`
  or `YO_MAIN_STACK_MB=4096`).

## KEY LOCATIONS

- `issues/yo-self-gap6-ctor-memo-reconciliation-attempt7.md` — THE
  campaign ledger: attempt-8 mechanism, capture-split rounds, round-2
  diagnosis + staged plan, residual-red classification. Read the last
  four sections FIRST.
- `issues/yo-self-compile-performance-rc-string-eq.md` — the perf
  lever list (priority 1).
- `issues/yo-self-comptime-int-forall-inference.md` — round 3 (landing).
- `scratchpad/round2_param_model_wip.patch` — round-2' WIP diff.
- `scratchpad/sweep69.sh`, `scratchpad/gates_r3.sh`,
  `scratchpad/probe_cf5.sh` — sweep runner / gate template / hollow-
  marker harness (session-local; rebuild from THE METHOD if lost).
- `tests/codegen-bootstrap/` — the 140-file differential corpus.
- `/tmp/sweep69_g14/` — the latest complete 183-file sweep results +
  per-file logs (red-family triage source).
- Auto-memory (`MEMORY.md` in the agent memory dir) indexes distilled
  lessons — recall before re-deriving anything.

## Open side issues (not #69 blockers)

- `issues/ts-early-return-nested-block-rc-drop.md` — TS compiler frees
  an RC container early-returned from a nested if-block; needs TS-level
  repro + fix + test.
- `issues/ts-constructor-result-drop-o0-crash.md` — TS-side -O0 crash
  (the historically accepted corpus DIFF; corpus is now 140/0 anyway).
- Task #9: broad anon-struct expected-type rule blocked by a stage-2
  miscompile (repro binaries under /tmp may be gone; the narrow rule is
  committed and green).
- `plans/FORALL_TO_GENERIC.md` — forall→generic keyword migration,
  waiting for a campaign resting point.
