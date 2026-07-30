# yo-self bootstrap — handoff

_Rewritten 2026-07-30. Everything historical was removed: per-round narratives
live in `git log` of this file and in `issues/*.md`. This document is only
(1) where the campaign stands, (2) the remaining work as concrete steps,
(3) how to measure honestly, and (4) the rules that must not be re-learned._

The goal: make the self-hosted compiler (`yo-self/`) build and run `./tests`
as correctly as the TypeScript compiler (`src/`, the GROUND TRUTH).

---

## 1. Where the campaign stands

**Honest score: 161 GREEN / 19 HOLLOW / 5 RED of 185 test files**, measured
with `scratchpad/hollow_sweep69.sh` after the comptime-arms round
(2026-07-30, flipped `inherent_first_resolution`, `algebraic_effects`,
`derive_clone_complex`, `impl_fn_field_rejection`, then `comptime` —
§2.1 is COMPLETE; results at `/tmp/hsweep_pv8/results.txt`; regenerate
before trusting it — /tmp is volatile).

Green baselines every change must preserve:

| gate                    | baseline                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| corpus diff-test        | **PASS 149 / DIFF 0** (incl. `derive_clone_recursive_enum.yo`, added 2026-07-30)                                 |
| `check ./std`           | **153/153**                                                                                                      |
| `check ./yo-self`       | last recorded **304/304** (a re-check was phantom-killed at ~15 min; slow, verify with `YO_MAIN_STACK_MB=4096`)  |
| stage2 real FTT markers | **0** (line-anchored grep — the historical `unwind()` marker is FIXED: zero-arg `unwind()` now stamps, begin.yo) |
| stage2 → stage3         | **FIXPOINT_HOLDS** (byte-identical)                                                                              |
| GATE-0 repros           | all three compile **and run** rc=0                                                                               |

`sys/bufio` and `thread` are FLAKY on this machine (intermittent SIGSEGV with a
ZERO-byte log — the phantom-kill signature). Re-run before believing either.

---

### Start here

1. Read §5 (THE METHOD) and §3's four measurement rules — they are what the
   round-to-round cost of this campaign actually depends on.
2. Build an s1 (`~2-3 min`, §4) and reproduce the score for ONE file with
   `scratchpad/measure_one.sh` before changing anything.
3. Then take §2.1 (two arms from flipping a file), or §2.3's
   missing-validation family if you want the cheapest possible first landing.

## 2. Remaining work, in priority order

### 2.1 `tests/comptime.test.yo` — DONE (GREEN, 28/28 = TS parity, 2026-07-30)

11 of its 13 originally-failing arms were fixed in the 2026-07-29/30 round. The
file flips only when BOTH remaining arms pass, because the generated batch
dispatch is one all-or-nothing expression.

**Arm 22 — DONE (2026-07-30): the shared-cell value model is LANDED.**
`PtrVal(target_value : ArrayList(EvalValue), target_index)`,
`Variable.value : ArrayList(EvalValue)` (via `value_cell_of`, empty = TS
undefined), ptr_fns hands the variable's own cell, property_access stamps
the scalar place as `ComptimeRef.ArrayRef(cell, index)`. All six arm-22
sub-blocks + arm 23 + tests/index.test.yo (48/48) pass standalone; TIER 1 +
TIER 2 + sweep clean. Arm 26 is ALSO done standalone (a26trial/a26both pass
— the batch-arm family fix covered the trial-mode `::` binding).
The last residue (a `comptime_expect_error` under a RUNTIME cond arm —
`issues/repros/cee-in-runtime-cond-arm.yo`) is ALSO FIXED: yo-self's
def-time body-eval defer had an extra `ft_has_ct_param` clause TS does not
have (TS shouldDeferBodyEvaluation, function-type.ts:445-451, has NO
comptime-param clause). Narrowed to VALUE-position comptime params only
(the `fn(comptime(n) : usize) -> Array(i32, n)` return-mismatch case that
motivated it — a recorded deviation); TYPE-position (`comptime(Idx) :
Type`) bodies now trial-evaluate at definition like TS, so the cee observes
the deliberate trait rejection. CAUTION for future measurement: a26trial-
style "repro passes" checks were HOLLOW (the sole statement FTT'd and rc
stayed 0) — always marker-check cee repros.

Original arm-22 plan (now landed, kept for reference):
Full scoping in `issues/yo-self-comptime-pointer-place.md` (Stage 2). Steps:

1. `PtrVal(target : EvalValue, index : usize)` → `PtrVal(target_value :
ArrayList(Self), target_index : usize)` — a 1-element list as the shared
   cell, the direct analogue of TS `PtrValue.targetValue: [Value]`
   (`src/value.ts:180-196`). ~8 match/construct sites: `value.yo` (eq,
   `value_to_string`), `eval.yo` ×2, `index_trait.yo` ×2, `clone_value.yo`,
   `comptime_index_fns.yo`, `ptr_fns.yo`.
2. `Variable.value : Option(EvalValue)` → `ArrayList(EvalValue)` (empty = TS
   `undefined`), porting TS `src/env.ts:73-79` and its comment verbatim. ~43
   construction sites in `env.yo` plus the `v.value` / `var.value` readers;
   `match(v.value, .Some(x) => …)` becomes `match(v.value.get(usize(0)), …)`, so
   most arms survive unchanged.
3. `ptr_fns.yo`: pass the variable's OWN cell (`src_var.value`) instead of a
   copy — TS `ptr-fns.ts:172`.
4. `assignment.yo`: add the scalar arm to the place consumer —
   TS `assignment.ts:1150-1173` writes `ptrTargetValue[0] = rhs`.
5. Gate: `tests/comptime.test.yo` arm 22, plus `tests/index.test.yo` (48 passed)
   as the runtime-Index-trait guard, then TIER 2.

This is mechanical but wide — give it its own round and its own gate.

**Arm 26 "Comptime SomeType constraint validation" — blocked on where-clause
constraint VISIBILITY.** Two attempts were written and reverted this round; both
rejections are measured. Read `issues/yo-self-cee-in-function-body.md` first —
it lists the three remaining candidates. Recommended first move: ONE probe
binary that prints, at the pending-constraint retry site in
`yo-self/evaluator/types/trait.yo`, both `ast_expr_to_string(lhs_expr)` and
whether `get_variables_from_env(env_mut, "Output")` finds anything. That single
probe distinguishes all three candidates:

1. `env_mut` is replaced wholesale in that file (`env_mut.frames =
te_info.env.frames`), so the frame holding the `Output` binding may be gone.
2. The retry re-enters via `_drop_where_constraint_failures`, whose local
   handler swallows what still fails — a resolver fix must be verified INSIDE
   that path.
3. The where-clause LHS `Self.Output` may not arrive as a 2-arg `BF_DOT` call.

Once the constraint is visible, re-apply the trait-field comptime-return
validation (TS `src/evaluator/types/trait.ts:1074-1102`) and require
`check ./std` to stay 153/153 — it is the false-positive detector, because the
prelude's own `ComptimeNegate` is exactly the shape being validated.

### 2.2 Remove the comptime-overload literal gate — DONE (2026-07-30)

The language rule is that a comptime call always wins — `1 + 2` folds to `3`.
TS's primary rule is ported (`function.ts:1737-1751`) but currently applies only
when every operand is a comptime LITERAL. One witness keeps the gate:

```rust
x := Box(i32)(99);
b := !(Var.is_owning_the_rc_value(x));   // RUNTIME binding → broken C
b :: !(Var.is_owning_the_rc_value(x));   // comptime binding → folds
```

The operand's value IS concrete (a `BoolVal` from the
`__yo_var_is_owning_the_rc_value` builtin), so the trial rightly accepts the
comptime candidate; in a runtime position its CTFE then yields nothing
emittable. It reaches codegen through the `iso(...)` macro's `cond` guard —
bisected to arm 2 of `tests/iso.test.yo` (`isolated := ^(x)`). Full analysis and
both witnesses: `issues/yo-self-comptime-overload-preference.md`.

UPDATE 2026-07-30: this gate is ALSO the root of the `NAME :: <ctfe call>`
batch-arm family (type_reflection / contracts_phase0 / parts of comptime+fn) —
a 6-line repro and a FULLY MAPPED removal attempt (both the fix that makes all
six family repros pass INCLUDING the iso/rc holdout, and the exact corpus
regression it causes plus its suspected root — the `get_func_param_comptime`
side-table keying at trial time) are recorded in
`issues/yo-self-comptime-overload-preference.md` §"2026-07-30 round". Start
the next attempt from that section's LAST paragraph: fix the Step-5 rejection
(helper.yo:672) for cloned/spec candidate ids, then widen `ct_successes` from
`foldable` to `successes`, delete `conc_out`, AND port the comptime-priority
rule into `_select_matching_overload` (the `.method()` picker needs it for
`self.neg()` inside CTFE bodies). Witnesses: scratchpad `ba_m`-class repros
(inline in the issue), `tests/iso`, `tests/rc`, `tests/imm_string`,
`tests/codegen-bootstrap/enum_ne_dispatch.yo` (anti-witness), TIER 2.

### 2.3 The hollow cluster (21 files)

A hollow file exits 0 while running NOTHING: the batch `main` is a single
`// Failed to transpile …` comment, so the harness scores every test a pass. One
evaluation failure anywhere in the file loses the whole dispatch, so a file
stays hollow until its LAST failure is fixed — and fixing one root can flip an
entire file.

| file                                                |   markers | root as last measured                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------- | --------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `asm`                                               |         1 | **unported**: `evaluate_asm: not yet implemented`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `iter_filter_closure`                               |         2 | **unported**: TypeVal SomeT callee without FnTrait                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `type_reflection`                                   |        24 | **unported**: `__yo_type_get_info: unsupported type variant`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `comptime`                                          |         1 | arms 22 + 26 — §2.1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `higher_kinded_types`                               |         1 | explicit `generic(...)` peel landed but did not flip it: the HKT-kinded binder + the method form `container.map(generic(B), f)` remain                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `spec/contracts_phase0`                             |         1 | arms 2/18 were the explicit-generic-arg root (peel landed, still hollow → another root); arm 8 is a cond-wrapped `invariant()` under cee                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `basic`                                             |         4 | `x := 13` after `(x : i32) = 12` needs TS `addVariableToEnv` shadowing rules (the `Test 'struct'` half is fixed — see the pointer-receiver issue)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `closure`, `fn`                                     |       1/3 | missing VALIDATIONS (yo-self accepts what TS rejects). `inherent_first_resolution` FLIPPED GREEN by the call-site where-clause re-application round (`issues/fixed/yo-self-callsite-where-clause-validation.md` — read it before touching this family; it maps 4 sub-roots incl. the prelude-env fork and the generic-impl base-trait key). Per-arm split (2026-07-30, all TS-clean): closure arm 2 = Impl-var reassign validation; fn arms 0/9/11/12/13/14 = outer-scope hiding in plain fn bodies, comptime fn-type bindings, `comptime_fn()`, runtime-arg-to-comptime-fn cees, arg-count cee, mutual-recursion `_()` forward closures; basic arms 2/4/6/12/14/18/19/24/25/26 = outer-init + shadowing (needs TS `addVariableToEnv` port: ~100 call sites, TS exempts 19 with `allowVariableShadowing: true`), tuple destructuring, nominal-struct cees, union ctor, labeled `then:/else:`, or-patterns + negative literals, comptime_int struct fields, match-Option-begin, for-range sum |
| `iterator_combinators`, `where_clause_fn_inference` |       2/1 | shared root: `Type mismatch for type member "_f":`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `collections/linked_list`                           |         1 | `Type mismatch for type member "value":` + match-on-`unit`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `option_result_combinators`                         |         1 | `Last expression in "begin" is not evaluated correctly:`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `imm_map`, `imm_set`                                |         1 | after noise subtraction: `Cannot unify incompatible types:`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `async_await`, `fmt`, `gadts`, `impl`, `prelude`    | 1/1/1/4/1 | see the per-file table in the root-cause map                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

The per-file evidence base is `issues/yo-self-hollow-root-cause-map.md`.
**Re-measure before acting on it** — it is dated 2026-07-29 and this round
superseded several of its entries (`comptime`'s `"Output"` root is fixed;
`contracts_phase0`'s "requires clause" attribution was wrong — the trigger was
the explicit `generic(...)` argument alone, verified by removing the contract
clause; `comptime_option_result` has since flipped GREEN).

Cheapest family first: **the missing-validation group.** Each is one check TS
performs and yo-self does not, in an otherwise-green file. Recipe: put the
offending expression in `src/tests/fixme.yo`, run `./yo-cli check` (TS) against
the s1 binary, and TS rc=1 vs s1 rc=0 localises the missing check in minutes.

### 2.4 The 8 REDs

Cluster-mapped in `issues/yo-self-69-red-list-map.md`. `algebraic_effects`
FLIPPED GREEN 2026-07-30 (72/72 run and pass): the failing test was zero-arg
`unwind()` — begin.yo's unwind arm had no zero-arg path (`return` had one) and
fed a `make_err_expr()` into evaluation, so the handler body never stamped;
ported TS begin.ts:1446-1479 (at-most-one-arg check + unit-typed Unwind
stamp). That same marker was the stage2 self-compile's LAST real FTT marker —
stage2 is now marker-free. 12 markers remain inside the file's cee-rejected
emission paths (all tests genuinely pass; same half-registered-fn class as
issues/yo-self-algebraic-effects-two-roots.md root B). Current list with marker
counts from the last sweep:

| file                               | markers | note                                                     |
| ---------------------------------- | ------: | -------------------------------------------------------- |
| `closure_capture_rc_leak`          |       3 | the closure `void*`-param family                         |
| `sync/mutex`                       |       2 | —                                                        |
| `imm_sorted_map`, `imm_sorted_set` |       1 | the parameter-type-expression side table (architectural) |
| `imm_threading`                    |       0 | C-level failure, no FTT markers                          |

A marker count of 0 with rc=1 means the C is invalid for a reason OTHER than a
dropped statement — read the clang error, do not go looking for FTT comments.

`derive_clone_complex` FIXED 2026-07-30: the provisional trait-method
registry — the port of TS's receiver-trait splice
(trait-type.ts:176-203/512), consulted AFTER the real registry
(fallback-when-empty; splice-ahead order shadowed same-impl sibling methods
and miscompiled derive(Eq)'s `!=`→`==` inner dispatch). Full write-up +
ordering lesson: issues/yo-self-69-red-list-map.md (2026-07-30 later
update). Corpus guard: `tests/codegen-bootstrap/derive_clone_recursive_enum.yo`.

### 2.5 Parked / known-open

- `./yo-cli test ./tests` under **TS** is GREEN: **2641 passed, 0 failed**
  (2026-07-30). The long-standing `basic.test.yo` `Test 'struct'` failure is
  FIXED — a method call on a `*(Self)` receiver was resolving to the raw-pointer
  `add(count : usize)` intrinsic instead of the pointee's own `add`; details and
  the both-directions regression test in
  `issues/basic-test-struct-batch-count-usize-i32.md`.
- The test runner still prints `Failed to import module "…":` with **nothing
  after the colon** when a generated batch module fails to compile. That empty
  message is what made the above look unactionable for weeks; the capture recipe
  in the same issue file is the workaround, and making the runner propagate the
  inner error is a small, high-value fix on its own.
- `issues/yo-self-std-string-swallowed-unify-noise.md` — one swallowed
  `Cannot unify incompatible types: "usize" and "u8"` inside
  `std/string/string`, present in nearly every file. Harmless today, but it is
  the noise floor (see §3) and one std function body never completes its
  definition-time validation.
- `issues/yo-self-comptime-const-batch-undeclared.md` — `G :: <ctfe call>` in a
  batch arm emits an undeclared C identifier (batch-arm context only).
- `issues/yo-self-begin-shared-id-clobber.md` — the CLASS is open: `begin`
  wraps a non-begin expr around the SAME node, so its `out_info` clobbers the
  inner ExprInfo on the shared id. Four instances found; the proposed durable
  fix is to invert the merge (start from `last_info`, clear what the begin level
  must own) instead of maintaining a whitelist.
- Side issues, not blockers: `issues/ts-early-return-nested-block-rc-drop.md`,
  `issues/ts-constructor-result-drop-o0-crash.md`.

---

## 3. How to measure honestly

**Never quote a bare "N passing".** 33 files were once counted green while
running nothing. Proven with a deliberate `assert(false)` probe (TS: "33 passed
/ 1 failed"; yo-self: "34 passed") — `issues/yo-self-hollow-test-batch-main.md`.

| tool                            | what                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scratchpad/hollow_sweep69.sh`  | honest score, all 185 files, resumable. **~8 min** (measured 2026-07-30 — the "~90 min" in older notes is pre-perf-work)                                                                                                                                                                                                                   |
| `scratchpad/measure_one.sh`     | one file, same rules (`BIN=… T=… TAG=… bash scratchpad/measure_one.sh`)                                                                                                                                                                                                                                                                    |
| `scratchpad/split_arms.py`      | explode a `.test.yo` into standalone per-arm `main` files. CAVEAT: only the preamble BEFORE the first `test(` is copied — module defs BETWEEN tests are DROPPED (type_reflection's `ColorR ::`), so confirm a failing arm against TS before believing it; relative `../std` imports break outside the repo — split into `tmp/`, not `/tmp` |
| `scratchpad/subset_arms.py`     | rebuild a `.test.yo` with only chosen arms — the ONLY way to blame an arm, since all arms share one dispatch expression                                                                                                                                                                                                                    |
| `scratchpad/capture_markers.sh` | run many failing files serially, keeping each one's batch `.c` + log                                                                                                                                                                                                                                                                       |
| `scratchpad/swallow_sweep.sh`   | sweep a probe-instrumented s1 to recover the SWALLOWED def-time error per file                                                                                                                                                                                                                                                             |

Four rules that cost real time to learn:

1. **Subtract the NOISE BASELINE.** Any file importing `std/string/string`
   (i.e. nearly all, via `std/assert` → `std/fmt/to_string`) swallows exactly
   one `Cannot unify incompatible types: "usize" and "u8"`. It caused two wrong
   root-cause attributions. Others (`__yo_expr_to_string`, `Incompatible
types:`, `use of moved value`) occur in PASSING files — take a green-file
   baseline and `comm -23` against it.
2. **Move a failing statement to MODULE level to SEE the swallowed error.**
   Module begin exprs are not wrapped in the def-time swallow, so a 3-second
   `check` replaces a probe build. This is the single biggest speed-up in the
   diagnosis loop.
3. **Count FTT markers UNANCHORED, or full-compile and let clang judge.** A
   failing sub-expression emits its comment MID-LINE
   (`(bool)(// Failed to transpile …)`), which `grep '^\s*// Failed'` reports as
   zero. The line-anchored form is correct ONLY for the stage2 self-compile
   count, where it exists to skip the compiler's own string literals.
4. **A `::` statement emitting `// Failed to transpile` means its node has NO
   ExprInfo** — the enclosing body eval THREW there (`::` is a no-op emitter,
   `codegen/exprs/generation.yo`). Everything after it in the body loses its
   info too, so the FIRST marker names the real failure.
   `comptime_assert` is a vacuous oracle when its argument is not a concrete bool.

### Building a diagnostic s1

yo-self swallows evaluator errors in FOUR places. Un-silencing them turns "the
file is hollow" into a precise error list:

| site                                                                 | tag suggestion |
| -------------------------------------------------------------------- | -------------- |
| `evaluator/exprs/_expr.yo` `_evaluate_expression_wrapper` catch-all  | `__DBG_W`      |
| `evaluator/calls/function_type.yo` `_trial_eval_fn_body` `inner_exn` | `__DBG_F`      |
| `evaluator/values/anonymous_function.yo` `inner_exn` (two sites)     | `__DBG_A`      |
| `evaluator/builtins/comptime_expect_error.yo` `local_exn`            | `__DBG_C`      |

Use DISTINCT tags — a single shared tag cannot tell the sites apart. Add
`open(import("std/fmt"));` to any file you touch EXCEPT
`yo-self/evaluator/calls/function.yo`, where `eprintln` is already in scope and
the import collides with `ToString`.

---

## 4. Gates

```bash
bun run build                                              # before any yo-cli work
YO_MAIN_STACK_MB=4096 ./yo-cli compile yo-self/main.yo --release -o /tmp/s1
S1=/tmp/s1 P=x bash scratchpad/gates_fast.sh               # TIER 1
S1=/tmp/s1 P=x bash scratchpad/gates_perf1.sh              # TIER 2
BIN=/tmp/s1 OUT=/tmp/hs bash scratchpad/hollow_sweep69.sh  # honest score
```

Measured costs on this box (2026-07-30 — **older notes quote 8-min builds and a
110-min TIER 2; both are pre-perf-work, do not plan around them**):

| step                  | cost                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------- |
| s1 build              | ~2-3 min                                                                              |
| TIER 2, end to end    | **~15 min** (battery ~6, corpus ~3.5, `check ./std` 0.5, stage2 emit 3.4, stage3 3.5) |
| honest 185-file sweep | ~8 min                                                                                |

TIER 2 is cheap enough now to run per landed fix — do that rather than batching
several risky changes into one gate, because attribution is what costs time.

`tests/index.test.yo` is NOT in the TIER-1 battery; run it explicitly whenever
you touch address-of / Index-trait / comptime-place code.

**Never** run two `yo-cli test` invocations against the same directory
concurrently (the batch artifacts `.yo_selftest_batch_*` live next to the test
file and clobber each other — this has produced phantom-hollow readings). Never
edit `yo-self/*.yo` while a gate is in GATE 4/5 (stage2/stage3 read the tree; a
mid-run edit invalidates the fixpoint comparison). To measure a test file while
a gate is running, copy it to a scratch dir and run it there.

---

## 5. THE METHOD (non-negotiable — proven over ~40 fix rounds)

1. **Faithful port first.** Find the TS behaviour (file:line) and port that
   shape. Where yo-self's model genuinely differs (value semantics vs TS object
   identity), document the divergence AND use the equivalent existing
   mechanism. Being broader OR narrower than TS both break the self-compile.
   Distrust yo-self comments claiming a port was impossible — several were
   false. If a faithful port regresses something, the regression is usually a
   SECOND missing port, not a reason to narrow the first (this round: the
   comptime-priority rule looked wrong until `_call_result_unknown` was found to
   be missing TS's runtime-only marking).
2. **Gate every change; revert on ANY regression.** Tiers above.
3. **No hollow greens.** rc=0 proves nothing. **STRICT_FIXPOINT does NOT catch
   hollowness** — a state once passed every gate including the fixpoint while
   emitting 19 markers, because stage2 and stage3 drop the same statements.
   ASan is useless here (`yo-cli` silently skips instrumentation); use
   `scratchpad/guardmalloc_corpus.sh`. Prove a gate can FAIL before trusting it
   to pass.
4. **Probe before fixing; instrument, don't infer.** Most fix attempts that
   skip this step are measured dead ends. One temporary `eprintln` naming the
   actual list/type/value has repeatedly replaced hours of reasoning.
5. **Never filter a trace on a bare identifier name.** The prelude defines `f`,
   `x`, `m`. Filter on a shape unique to the reproducer.
6. **One build must answer the whole question.** Pack every plausible probe into
   a single diag build with distinct tags; never one-hypothesis-per-build.
   Input-side experiments (crafted `.yo` files against an existing s1) cycle in
   seconds — rebuild the compiler only when the probe must live inside it.
7. **Long jobs die on this box.** rc=133/137/138/139 with a ZERO-byte log is a
   phantom kill — retry before believing a crash.
8. `./yo-cli compile` cannot take `*.test.yo` — extract a standalone repro with
   `main` + `export(main)`.
9. **Anchor scripted edits on UNIQUE context.** A condition once landed on the
   wrong same-text `if`. Assert `count == 1` in the patch script.

---

## 6. HARD-WON INVARIANTS (violate these and you re-live old sessions)

- **Per-call / per-closure type identity is THE recurring theme** (Gap-6). Do
  not weaken `_freshen_io_builtin_callee`, the call-scoped forall rebinds +
  lineage-identity gate (`types/synthesizer.yo`), the clfid spec-cache keying +
  per-spec SomeT rebuild (`calls/helper.yo`), or receiver-instance `Self`
  adoption (`expr_info.yo`).
- **`SomeT.resolved_concrete` is a SHARED-LINEAGE cell** — per-call resolutions
  must rebuild a FRESH SomeT + cell, never write the shared id last-wins.
- **The shell pattern:** any walker of struct fields / enum variants may get a
  recursive-`Self` SHELL (empty lists) — call
  `resolve_enum_shell(resolve_struct_shell(ty))` first.
- **`Some(UnknownVal)` ≠ a value.** Every ported TS `if (expr.$.value)` gate
  needs an `is_unknown_val` guard.
- **A runtime call result must be RUNTIME-ONLY** (`_call_result_unknown`). TS
  has no value there at all, and the flag is what makes "Cannot assign runtime
  argument to compile-time parameter" fire. Un-marking it silently re-enables
  comptime overloads for runtime operands.
- **Comptime integers are `i64`, not a bignum.** Any range/overflow reasoning
  must treat u64/usize as BIT PATTERNS (a value above `i64::MAX` reads as
  negative) — do the arithmetic in the unsigned domain for those types.
  `tests/comptime_overflow.test.yo` guards both directions.
- **Type-shape dispatch without a `Pointer` arm** silently no-ops for
  pointer-receiver methods.
- **Chars vs bytes:** `String.len()` is CHARS; byte loops use
  `bytes_len()`/`byte_at()`.
- **Retroactive envs:** ExprInfo envs share mutable Frames — "was X bound here"
  must use the emitter's C block-scope stack, not env lookups.
- **`type_to_string` is bounded by a monotonic visited set.** Do not remove it:
  without it one render reached 6.8 GB RSS and hung six test files for 1800 s.
- Yo syntax: `:=` is immutable (reassign needs `(x : T) = …`); no forward refs;
  no nested match patterns; a single-expression `{ }` parses as a struct
  literal (add a `;`); fn defs are `name :: (fn(...) -> T)({ ... })`; adjacent
  DIFFERENT operators need parentheses.
- **The type-parameter binder is `generic(T : Type)`, not `forall`.**
  `forall`/`∀` are reserved and rejected at lex time. Internal identifiers
  (`forall_labels`, `forall_types`) deliberately keep the old name.
- `./yo-cli fmt` every touched `.yo` before committing; lint-staged reformats
  `.md` on commit.
- rc=139 at `-O0` on deep recursion is stack exhaustion — use `--release` or
  `YO_MAIN_STACK_MB=4096`. `-O0` stays banned.

---

## 7. Key locations

| path                                                | what                                                              |
| --------------------------------------------------- | ----------------------------------------------------------------- |
| `issues/yo-self-hollow-root-cause-map.md`           | per-file evidence base for the hollow cluster + the noise table   |
| `issues/yo-self-69-red-list-map.md`                 | the REDs, cluster-mapped                                          |
| `issues/yo-self-hollow-test-batch-main.md`          | the hollow-batch defect itself + measured dead ends               |
| `issues/yo-self-comptime-pointer-place.md`          | §2.1 arm 22 — Stage 2 scoping                                     |
| `issues/yo-self-cee-in-function-body.md`            | §2.1 arm 26 — both reverted attempts, three candidates            |
| `issues/yo-self-comptime-overload-preference.md`    | §2.2 — the literal gate and its one holdout                       |
| `issues/yo-self-explicit-call-site-generic-args.md` | explicit `generic(...)` type application, what remains            |
| `issues/yo-self-stub-inventory.md`                  | 311 unported/divergent findings, each with a TS file:line         |
| `tests/codegen-bootstrap/`                          | the 148-file differential corpus (add a regression test per fix)  |
| agent auto-memory (outside the repo)                | `MEMORY.md` indexes distilled lessons — recall before re-deriving |

`tmp/` is a git-ignored scratch dir with ~78 stale `*.test.yo` files; a bare
`./yo-cli test` sweeps them up and they all fail. Pass an explicit path.
