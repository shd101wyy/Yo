# yo-self Stage-2 Handoff — #69 Campaign

_Last updated 2026-07-26. `git log` of this file has the full archaeology;
per-bug details live in `issues/*.md` — do not re-litigate fixed bugs._

## READ THIS FIRST (2026-07-26) — the #69 count was overstated by 33 files

`165/183` counted **33 files that report "N passed" while running NOTHING**.
Proven end-to-end: appending `test("probe", { assert(false, "must fail"); })`
to a copy of `tests/basic.test.yo` gives TS "33 passed / 1 failed" and yo-self
"**34 passed**". yo-self emits the whole batch `main` as one
`// Failed to transpile match((__yo_batch_env.env).get("YO_TEST_INDEX"), …)`
comment, so the binary runs nothing, exits 0, and the harness scores every test
a pass. Control: the same probe on `rc` (main NOT hollow) correctly reports
1 failed. Full write-up + reproducer: `issues/yo-self-hollow-test-batch-main.md`.

**Honest baseline, full 183-file sweep on HEAD (`e6536402e`), 2026-07-26:**

| verdict    | files   | meaning                                  |
| ---------- | ------- | ---------------------------------------- |
| **GREEN**  | **131** | exits 0 AND the batch `main` really runs |
| **HOLLOW** | **33**  | reports "N passed" with an empty `main`  |
| **RED**    | **19**  | ordinary failure                         |

So **52 of 183 are failing**, not 18. The 33 hollow files hide ~950 reported
assertions (string/string 251, async_await 116, algebraic_effects 72,
collections/linked_list 69, option_result_combinators 54, index 48, imm_vec 47,
…). Harness: `scratchpad/hollow_sweep69.sh` (resumable; scores GREEN only when
rc==0 AND main is not a comment). **Re-run it before quoting any number, and
never quote a pass count without it.**

Why every existing gate missed this: GATE 1 checks battery PASS COUNTS and a
vacuous pass counts; GATE 2's corpus is standalone `compile` inputs, never
generated test batches; the stage2/stage3 marker gate only covers the
self-compile. A per-test hollow gate is now mandatory.

### Why one bad expression kills a whole file

The generated batch `main` has exactly ONE statement — the `match` on
`YO_TEST_INDEX` containing every test. So ANY evaluation failure in ANY test
body loses that statement's `ExprInfo`, and codegen replaces the whole dispatch
with a comment. Fixing one evaluator failure can therefore flip an entire file;
equally, a file stays hollow until its LAST failure is fixed.

### Ranked causes of the 33 hollow files (measured, not guessed)

Captured with a diagnostic s1 that prints every error swallowed by
`_evaluate_expression_wrapper` (`_expr.yo:1018`) and the two def-time trial
handlers. 16 messages appear in all 33 files (prelude-evaluation noise — ignore
them); these are the DISCRIMINATING ones:

| files | error                                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------- |
| **8** | `Incompatible types:` — the closure-forall family (see below)                                                                   |
| **7** | `Expected compile error, but the expression was evaluated successfully:`                                                        |
| **3** | `Expected a label for function parameter, got requires(y != i32(0))`                                                            |
| 2     | `Expected enum type or primitive type for match expression, got unit`                                                           |
| 2     | `Cannot unify incompatible types: "usize" and "Type"`                                                                           |
| 2     | `Failed to evaluate right-hand side of assignment: (reversed._head)`                                                            |
| 2     | `Type mismatch for type member "_f":`                                                                                           |
| 1 ea. | 17 more singles (asm not implemented, `_` array length, `for(inout(x))`, `unwind` outside fn, `Variable "printf" not found`, …) |

- **`Incompatible types:` (8)** — algebraic_effects, async_await, closure,
  gadts, imm_list, imm_vec, string/string, sys/file.
- **`Expected compile error …` (7)** — atomic_object, basic, impl,
  inherent_first_resolution, module_struct_unification, operator_grouping,
  prelude. These tests use `comptime_expect_error`; yo-self is MORE PERMISSIVE
  than TS there, so the expectation fails and takes the file with it.
- **`requires(...)` param label (3)** — spec/contracts_phase0,
  spec/pragma_no_contracts, spec/pragma_verify: contract clauses are not
  parsed.

Every one of the 33 has at least one discriminating cause captured (0 files
unexplained), so this table is a complete work-list.

## Status

### 2026-07-26 session — 3 fixes landed, 0 flips, 1 metric corrected

All three cleared the full gate battery INCLUDING STRICT_FIXPOINT
(battery 19/19, corpus PASS 140 / DIFF 0, `check ./std` 153/153, stage2
hollow=6 baseline, clang, stage3):

| commit      | change                                                                 |
| ----------- | ---------------------------------------------------------------------- |
| `a5457bad1` | drop scope locals in REVERSE declaration order (TS `env.ts:2265`)      |
| `95b17cc95` | visited-id guard on `type_to_string` — **all 6 cluster-A stalls gone** |
| `e6536402e` | `UnknownValue.isRuntimeOnly` port (comptime params, TS `value.ts:163`) |

`95b17cc95` is the big one operationally: `imm_vec`, `imm_sorted_map`,
`imm_sorted_set`, `imm_threading`, `btree_map`, `priority_queue` went from
1800 s timeouts to **3-5 seconds each**. Measured cause: 100% of samples in ONE
`_impl_type_captures_sig → value_to_signature_string → _tts` render at 6.8 GB
RSS. A probe on TS's `typeToString` over the same file peaks at **44
characters** — TS never renders those types because `_impl_type_captures_sig`
has no TS counterpart (impl.ts:1551 embeds substitutions in the funcId).
NOTE these six are still not green: five are ordinary reds now, `imm_vec` is
hollow.

Useful ops fact discovered: **an s1 build is ~2 minutes**, not 10 —
`./yo-cli compile yo-self/main.yo --release -o /tmp/x_s1`. The ~40 min cost is
stage2/stage3 ONLY. Iterating on evaluator changes is therefore cheap; build a
scratch copy (`cp -R yo-self /tmp/yoself-x`), instrument it, and compile that —
this also keeps the real tree untouched while a gate run is reading it.

### DEAD ENDS from 2026-07-26 — measured, do not repeat

1. **`synthesizeTypes` on the closure return in `closure_type.yo`**
   (TS closure-type.ts:186-196, a real missing port): implemented, **zero
   effect** — instrumentation shows
   `try_to_implement_closure_by_fn_module_type` is NEVER called for a closure
   passed as a call ARGUMENT. That path is `values/anonymous_function.yo`.
2. **Stamping the SomeType return from the body type in the `=>` lambda path**
   (faithful port of TS anonymous-function.ts:963-988, using yo-self's shared
   `resolved_concrete` cell): it FIRES (`ret=U : (Send) rid=1975 body=i32`) and
   Step 6 in helper.yo then sees `eid=1975/rc=1 gid=1975/rc=1` — same SomeT,
   resolution present — and the repro is UNCHANGED. Whatever consumes `U`
   inside `map`'s body does not read that channel.
3. **Widening the expected-type clear at `anonymous_function.yo:1243`** beyond
   io.async closures (so the body types concretely instead of coercing to the
   forall var): needed to make (2) fire at all, not sufficient alone.
4. **Narrowing the unknown-arg CTFE gate** (`comptime_fn.yo:565-585`) to
   non-type returns. TS has NO such gate — `evaluateComptimeFunctionCall` only
   short-circuits for `isAnalyzingCtfeCapability` (comptime-fn.ts:58-70) — so
   this IS a faithfulness gap. It clears the standalone repro (markers 2 → 0,
   the `map` call really emitted) but on the battery it changes nothing for the
   8 hollow files and **regresses `imm_list` to rc=139 (SIGSEGV)**. Not landed.

Also refuted: the trial-eval unwind is NOT escaping its helper
(`__DBG_TRIAL before → after out=0` prints prove containment), so
`_trial_eval_fn_body` is not corrupting the caller by unwinding too far.

### NEW 2026-07-26 — a soundness hole found while doing (1): arg types unchecked

`f :: (fn(x : i32) -> i32)(x); f(true)` — TS rejects ("Cannot unify
incompatible types: Expected i32, Given bool"); **yo-self accepts it and emits
`yo_id_NNNN((int32_t)(true))`**. Measured: `are_types_compatible(i32, bool)` is
correctly `false`, and instrumenting Step 8 of `check_and_add_argument` while
compiling the reproducer prints 25 distinct param/arg pairs — every one equal —
and NEVER an `i32/bool` pair. So this call path does not run the per-argument
check at all. TS funnels every call through `tryToCallFunctionWithArguments`;
whichever yo-self path bypasses it is the divergence. Full write-up +
reproducer: `issues/yo-self-arg-type-check-bypassed.md`,
`issues/repros/arg-type-check-bypassed.yo`. This is probably why several
`comptime_expect_error` tests fail, and it means a "green" file can contain
silently mistyped calls that C casts into place — fix it before trusting the
green count further.

### Batched workflow (adopted 2026-07-26 on the user's instruction)

One landing used to cost ~75 min of gates while diagnosis costs minutes, so
ports are now batched:

- **TIER 1 — `scratchpad/gates_fast.sh` (~12 min)**: repros, the 20-file battery
  WITH per-file hollow detection, corpus diff-test, `check ./std`. Run on every
  change while assembling a batch.
- **TIER 2 — `scratchpad/gates_perf1.sh` (~75 min)**: adds stage2, clang,
  stage3, STRICT_FIXPOINT. Run ONCE per batch, immediately before pushing.
- Bisect a TIER-2 failure with 2-minute s1 builds; do not go back to
  one-gate-per-commit.

Iterate in a scratch copy so a running gate never reads a half-edited tree:
`cp -R yo-self /tmp/yb && ./yo-cli compile /tmp/yb/main.yo --release -o /tmp/yb_s1`
(~2 min). Add `open(import("std/fmt"));` to any file you put an `eprintln` in.

### Suggested next moves, highest leverage first

1. **`comptime_expect_error` (7 files, ~90 assertions)** — the cheapest block:
   each failure is a missing VALIDATION (yo-self accepts what TS rejects), the
   files are otherwise green, and one validation can flip a whole file.
   **First one is done and proves the method** — see `operator_grouping` below.
   The remaining six, with the exact expectation each needs:

   | file                        | expectation yo-self wrongly accepts                                                                                                                           |
   | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `inherent_first_resolution` | `f.m(true)` must NOT fall through from the inherent `m(i32)` to the trait `Bar::m(bool)`; and `s.starts_with(i32(5))` must fail the `P : Pattern` where-bound |
   | `atomic_object`             | `atomic(ref(struct(inner : NonSend)))` must be rejected (Send derivation)                                                                                     |
   | `basic`                     | `x = 12` on a variable defined outside the fn body / outside the while loop                                                                                   |
   | `impl`                      | a fn returning `Impl(Id)` from divergent `cond`/`match` arms; `v.pick("s")`                                                                                   |
   | `module_struct_unification` | bare `module(x : i32)` and bare `Module` as expressions                                                                                                       |
   | `prelude`                   | a duplicate/conflicting `impl` on `AnotherBox`; `uninit.assume_init()` before init                                                                            |

   Method that worked: run the file under the diagnostic s1 (prints every
   swallowed error), find the `Expected compile error …` site, write the
   offending expression into `src/tests/fixme.yo`, and compare
   `./yo-cli compile` (TS) against the yo-self binary — TS rc=1 vs yo-self rc=0
   localises the missing check immediately.

2. **`Incompatible types:` closure-forall family (8 files, ~500 assertions)** —
   the reproducer is `issues/repros/closure-arg-abandons-enclosing-begin.yo`
   and dead ends 1-4 above narrow it a lot. Next probe: find what reads `U`
   inside `map`'s body when the SomeT already carries a resolution.
3. **`requires(...)` contract clauses (3 files)** — parser-level, self-contained.
4. Then the 19 REDs, which are the pre-existing cluster map in
   `issues/yo-self-69-red-list-map.md`.

- **#70 (`s2 test ./yo-self/tests`): DONE — 61/61.**
- **#69 (`s2 test ./tests`): 164/183 committed** (`3e8dfc1a6` extern-type
  carve-out — sync/atomic 15/15, sync/waitgroup 14/14, sync/rwlock 15/15,
  all at exact TS parity; full gates incl. STRICT_FIXPOINT).
  **SWEEP-VERIFIED**: the 183-file re-baseline (/tmp/sweep69_ext) reports
  GREEN=164, and its diff against the 161 baseline is EXACTLY the three
  expected flips with nothing else moving — so the three perf commits
  (920c2876d, a92e7c9a5, 011e15c7a) caused ZERO regressions.
  LESSON now in THE METHOD: verification sweeps catch what the battery
  misses — never skip the post-commit sweep, and grow the battery with
  every near-miss (comptime.test is now permanent).
- **PERF (priority 1) is under way and measured** — `check ./std`
  87.35 s → 29.71 s (2.94x), stage2 emit ~55-65 → 35.9 min (1.7x). See
  "1. PERFORMANCE FIRST" below for the numbers, the two dead ends not
  worth repeating, and the next lever.
- Recent commits (each fully gated incl. STRICT_FIXPOINT):
  `2dc6d1e39` needs-cycle-GC pre-scan (faithfulness+perf, flips nothing),
  `3e8dfc1a6` extern-type carve-out (3 sync files),
  `011e15c7a` + `a92e7c9a5` + `920c2876d` perf arc,
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

## FAITHFUL PORT FIRST (user directive 2026-07-25) — READ BEFORE WRITING CODE

> "we should always do faithful port first" ... "fix all the stubs with
> faithful ports"

yo-self is a PORT of the TS compiler in `src/`. When yo-self and TS diverge,
the repair is TS's mechanism, in TS's place, using yo-self's EXISTING
equivalents. A yo-self-only heuristic that turns a test green is WRONG — it
accumulates divergence and breaks the next thing.

Worked example from 2026-07-25, both of which made `cli/arg_parser` 15/15:

- INVENTED (rejected): `_is_pattern_era_enum_sibling`, a predicate comparing
  two enums by variant names and RENDERED field types, substituting the
  callee's registered return when they matched with differing ids.
- FAITHFUL (kept): TS sets `substitutions.set("Self", concreteType)`
  (`src/evaluator/values/impl.ts:2474`) and consumes it through
  `reEvaluateFunctionType(..., SelfType)` (`impl.ts:1494-1498`). yo-self's
  `find_methods_from_generic_impls` omitted the `Self` entry entirely and used
  a purely STRUCTURAL `substitute` — the exact case TS flags at `impl.ts:1451`
  ("types in Yo are nominal, so we can't just substitute structurally").

Three corollaries, each learned the hard way in one session:

1. **Distrust yo-self comments that explain why something could not be
   ported.** Three were false: a committed "structural lead" naming a DEAD
   DUPLICATE that nothing imports; `_tts`'s depth-cap story (the cap works —
   measured exactly 41 contiguous frames); and `await_analysis.yo:84`'s claim
   that TS's `ioBuiltin` marker "is not available in the Yo self-hosted type
   system" (it is: `extern_name` already carries the same field label, and the
   pass already receives a `get_info` callback).
2. **Faithful does not mean safe.** Two literal transcriptions of TS each
   regressed a gate: recording TS's `finalType` wrapper as the closure's
   expression type cost 13 corpus files (`PASS 127`, all `io_async`); the
   `Self` binding cost 13 hollow markers. Gate every one.
3. **When a faithful port seems to have NO effect, check that it FIRES.**
   Twice the port was right and the implementation silently no-op'd — once
   comparing pre-substitution nodes against a post-substitution key, once
   omitting `intern_type`.

### The stub inventory — `issues/yo-self-stub-inventory.md`

300 measured findings (78 HIGH, 153 medium), every yo-self module read against
its TS counterpart, each entry carrying the TS `file:line`, what yo-self does
instead, and a miscompile-impact rating. HIGH = can produce wrong C.

This reframes the red list: the 19 reds are SYMPTOMS of a port that diverges in
300 measured places. Work the HIGH entries rather than chasing tests one at a
time. NOTE the inventory also found that module headers are STALE IN BOTH
DIRECTIONS (`begin.yo`, `assignment.yo`, `initialization_assignment.yo`
advertise stubs that are now implemented, while real gaps go undocumented) — so
the headers are NOT a stub index; that file is.

## Priority order (user directive 2026-07-24)

### 1. PERFORMANCE FIRST — cut self-compile from ~55 min to ~15 min

**In progress, measured.** Full detail:
`issues/yo-self-compile-performance-rc-string-eq.md` +
`plans/PERF_BORROW_ELISION.md`.

`check ./std` (evaluator-only proxy): **87.35 s → 29.71 s, 2.94x.**
stage2 emit (the REAL metric): **~55-65 min → 35.9 min, ~1.7x.**

| step                                    | check ./std | stage2 emit |
| --------------------------------------- | ----------- | ----------- |
| baseline                                | 87.35 s     | ~55-65 min  |
| `920c2876d` TS match-place dup elision  | 79.90 s     | —           |
| `a92e7c9a5` yo-self port + 2 predicates | 31.02 s     | 46.8 min    |
| `011e15c7a` codegen String.from (177)   | 29.71 s     | 35.9 min    |

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

**WHERE THE EMIT TIME NOW SITS** (live `sample` of a stage3 emit —
this is the codegen phase, which `check ./std` never touches):
`__yo_decr_rc` 43%, `String ==` 38%, memcmp 9%.

`String ==` is now SOURCE-optimal (the match-place elision removed all
four of its `___dup`s — verified in the emitted C). It is 38% purely
from CALL VOLUME, driven by identifier lookup
(`evaluate_identifier_and_operator` is a top caller).

**NEXT LEVER: interning.** Make identifier/type-key comparison an id
compare instead of a byte compare. TS gets this free — JS interns its
strings, so `===` is a pointer compare — which is the whole reason
`String ==` can be 38% of a yo-self emit. `yo-self/types/intern.yo`
already has the pattern (`g_type_intern`). This removes both the
linear-scan compares AND the HashMap hashing.

Secondary: every `String ==` still pays four non-inlined accessor calls
(`ArrayList.len()` x2, `.ptr()` x2). TS's emit marks 4,435 functions
`always_inline`; yo-self's emit marks 2. Worth measuring.

**MEASURE THE RIGHT THING.** `check ./std` is evaluator-only and does
NOT exercise codegen — that is exactly why the emit moved 1.3x while the
proxy moved 2.82x. Measure any codegen round with a REAL emit
(`<s1> compile yo-self/main.yo --release --emit-c --skip-c-compiler`),
not the check proxy. `scratchpad/perf_ab.sh <binA> <binB> 3` alternates
arms so machine drift hits both equally.

Then: `_attach_early_return_only_drop_to_returns` (13.9% of decr
traffic) is O(V x subtree) — one full walk per early-return variable,
with nested blocks re-walking. Fix by HOISTING: walk once collecting
`{node, cleanupPoint}` pairs at every `return`/`unwind`, then loop the
variables over that list.
**Do NOT prune it on `Expr.$.controlFlow`** — that is NOT a subtree
summary (`begin.ts:2251` takes only `lastExpr`'s flow), so a block with
an early return in a non-tail statement carries no flag and would lose a
drop: a silent LEAK. Full write-up in the issue doc.

**Dead end (measured):** lowering the `_frame_positions` index threshold
from 64 to 16 is **+1.2% SLOWER** — building an index for a small frame
costs more than scanning a few names.

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

### 3. Remaining red families (~13 more files)

| Family                | Files                                                         | Diagnosis / pointer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| async-SM layer        | thread, worker                                                | post-capture-split: `sm->var_NNN` / void-variable C errors in async state-machine emission                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| sync/\*               | channel, mutex, once                                          | atomic/waitgroup/rwlock FIXED by `3e8dfc1a6` (extern type wrongly counted generic -> ctor skipped). The remaining three are NOT that bug: `once` + `channel` show the same `__yo_new___yo_tN` undeclared-ctor SYMPTOM but survive the fix, so a different type is being skipped — re-read their post-fix logs in /tmp/sweep69_ext, do not trust the old attribution. `mutex` is distinct: a spec emitted with `__unknown__Type__` in its name (note `unknown` is an INTENTIONAL signature fallback in BOTH compilers, TS helper.ts:2149 — so that is spec-identity/emission, not naming) |
| ordered collections   | ordered_map, btree_map, priority_queue                        | whole-body "Failed to transpile" + `dispose_fn` referencing never-emitted drop method (ref structs with HashMap/ArrayList fields)                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| closure identity tail | ref_closure_capture, closure_capture_rc_leak                  | closure return-type identity; spec names with `unknown` forall segments                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| singles               | cli/arg_parser, derive_clone_complex, impl_fn_field_rejection | each its own class; untriaged details in the g14 sweep logs (/tmp/sweep69_g14/\*.log)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Sub-class evidence for all of these: END of
`issues/yo-self-gap6-ctor-memo-reconciliation-attempt7.md`
("Residual-red classification" entry).

**Fresh post-fix signatures** (from the 164/183 sweep at /tmp/sweep69_ext —
use THESE, not the older table text) cluster the 19 reds into three:

| family                   | files                               | signature                          |
| ------------------------ | ----------------------------------- | ---------------------------------- |
| missing ctor             | derive_clone_complex, once, channel | `__yo_new___yo_tN` undeclared      |
| spec identity            | closure_capture_rc_leak, mutex      | `__unknown__Type__` in a spec name |
| struct-instance identity | cli/arg_parser, imm family          | `__yo_t35` vs `__yo_t24` mismatch  |

**Most promising lead** (`issues/repros/toplevel-some-type-check-forces-cycle-gc.yo`):
yo-self registers UNMONOMORPHIZED generic instantiations in the codegen
type table where TS registers only monomorphized ones — measured, TS has
ZERO `void**` fields on that repro and yo-self has EIGHT. `2dc6d1e39`
fixed the downstream symptom (those generics being read as cycle roots);
the registration itself is untouched and is plausibly what feeds the
missing-ctor family. Do NOT "fix" it by widening
`type_contains_some_type` globally — that is strictly more conservative
and would REMOVE constructors that currently work (reasoning in the
repro).

**START HERE for the missing-ctor family:**
`issues/repros/box-self-struct-field-derive-clone.yo`. A plain struct with one
`Option(Box(Self))` field + `derive(Clone)` — smaller than the recursive-enum
repro, and it exhibits the struct-instance-identity error
(`__yo_t15` vs `__yo_t1`) too, so it covers TWO of the three families. Its
header carries the measured causal chain, how to READ a specialization name,
and NINE disproven hypotheses with the evidence that killed each — including
three fixes that were implemented, measured, and reverted (one of them made
the emit strictly worse). Read it before writing any code for this family.

**`derive_clone_complex` is the same root, traced to the C** (via
`YO_KEEP_BATCH=1 <bin> test …`, which keeps `.yo_selftest_batch_1.bin.c`):

    static inline __yo_t48* yo_id_2747_V_id_1598_ret_…(void value) {
      __yo_t49* _tmp = __yo_new___yo_t49();   // __yo_t49 = GENERIC Box(V)
    }

i.e. a `Box.new` specialization whose V never got substituted, so it
constructs the generic `Box(V)` (`void* _u42_`) and takes a `void`
parameter — never legal C, hence both "call to undeclared function
`__yo_new___yo_t49`" and "argument may not have 'void' type".

DO NOT "fix" this by filtering unit-typed params out of the emitted
signature. TS's declarations.ts filters `isUnitType` only for ENUM VARIANT
fields (line 695), never for function params — it simply never produces a
unit param, because its specialization is correct. A filter would mask the
spec-identity bug, not fix it.

Two reductions already done, so don't redo them:
`issues/repros/generic-over-closure-type-field.yo` (the real
`impl_fn_field_rejection` failure — its three `comptime_expect_error`
rejections and its Dyn(Fn) workaround all already match TS), and the
9-line Channel repro shape in the cycle-GC repro's header.

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
