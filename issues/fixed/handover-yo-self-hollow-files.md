# HANDOVER — the 3 HOLLOW test files (RESOLVED)

**Written 2026-08-08** after four failed fix attempts; **all three fixed the
same day.** Full history and the RED-file work live in
[`yo-self-hollow-language-test-files.md`](yo-self-hollow-language-test-files.md).

---

## 0. Resolution — and the one wrong assumption that cost four attempts

**§4's failure chain is wrong at step 1, and that is why every attempt built on
it failed.** It reads "evaluating `count_types`'s **body at definition time**,
the variadic parameter `types` is not in scope". The error's token points at the
definition line, so this looked certain — but the token points there only
because that is where the BODY is; the failing evaluation was the **call**.

One experiment settles it, and it needs no instrumentation at all:

```bash
# definition ALONE — rc=0, compiles clean
count_types :: (fn(...(comptime(types) : ComptimeList(Type))) -> comptime(usize))(types.len());
main :: (fn() -> unit)({ (); }); export(main);

# definition + ONE call — rc=1, `Variable "types" not found`
n :: count_types(i32);
```

The def-time body env **does** bind the variadic (`function_type.yo:918`, the
`__DBG_VP` hit §6 measured). The **callee** env at a call site never did:
`function.yo`'s inline FuncVal arm binds a `quote` variadic
(`...(quote(elems))`, the `array_list`/`hash_map` macros) and had **no branch at
all** for the comptime one. That is the whole of `variadic_comptime`.

**Generalising the method note**: an error whose token sits inside a function
body says nothing about WHO evaluated that body. Splitting the reproducer into
"definition alone" vs "definition + call" costs one compile and is decisive —
cheaper than the four speculative fixes, and cheaper than the instrumentation
build in §6.

The other two files were **not** the same root cause (§7 was right to assume
separate bugs) and were **not** one bug each — they were four more, each hidden
behind the next:

| file                         | bugs                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index`                      | the `slice_copy` rewrite fired on COMPTIME receivers, so `x(0 .. 5)` on a `comptime_str` matched `str`'s runtime `slice_copy` (TS guards exactly this, function.ts:815-823) · `_check_range_type` matched a struct NAME that is structurally always empty, so no range was ever recognised · `Range` and `RangeInclusive` are both anonymous `struct(start : T, end : T)`, so type compatibility cannot tell them apart and every `..` resolved as `..=` |
| `safe_code_structural_gates` | `comptime_expect_error` snapshotted the frame DEPTH only, and an expected throw can unwind past a `pop_frame` — measured 3 frames in, 2 out, the lost one being the MODULE frame · a rejected module-level binding still registered its name as a module-level global, so codegen module-qualified every later local of that name while its declaration stayed unqualified                                                                               |

Each file surfaced its next bug only once the previous one was fixed, because a
single swallowed error erases the batch's ENTIRE `__yo_user_main` dispatch. Budget
for that shape: "the file still fails" after a correct fix is the expected
intermediate state, not evidence the fix was wrong.

Everything below is the brief as it stood before the fix, kept for the method
notes and the four ruled-out attempts.

---

## 1. The mission

Three language test files are **HOLLOW** under the self-hosted compiler: they
exit 0 and report passing tests while executing **no assertions at all**.

```
tests/index.test.yo                      49 passed   <- runs nothing
tests/safe_code_structural_gates.test.yo  1 passed   <- runs nothing
tests/variadic_comptime.test.yo          10 passed   <- runs nothing
```

60 fake passes. `index.test.yo` is the one that matters most: **31 of its 49 arms
are ordinary runtime tests** (array/slice/HashMap/Deque indexing) that are lost as
collateral, not comptime tests.

This matters for `plans/SELF_HOSTING_COMPLETION.md` **P2**: once `src/` is retired,
the self-hosted binary's "N passed" is the _only_ signal there is, and a
silent-success failure mode is the worst thing to carry into that.

**Done means**: all three run their assertions, and
`scripts/bootstrap/known-failing.tsv` is empty. The gate then demands a fully
clean sweep by itself.

---

## 2. Current state

- The three files are **allowlisted and detectable** — CI's `hollow-sweep` job
  passes because they are listed in `scripts/bootstrap/known-failing.tsv`, and it
  fails if a NEW hollow file appears or a listed one changes verdict.
- **Do not "fix" this by making the marker disappear.** See §5, attempt 2.
- Nothing about the sweep or the ratchet needs changing. This is purely an
  evaluator bug hunt.

---

## 3. Reproduce it in 30 seconds

A 5-line module-level reproducer is checked in — no test runner, no batch, no
`test(...)` wrapper involved:

```bash
# TS: rc=0, compiles clean
./yo-cli compile issues/repros/yo-self-variadic-comptime-call-not-funcval.yo \
  --emit-c --skip-c-compiler -o /tmp/x

# yo-self: rc=1
YO_MAIN_STACK_MB=4096 <yo-self-bin> compile \
  issues/repros/yo-self-variadic-comptime-call-not-funcval.yo \
  --emit-c --skip-c-compiler -o /tmp/x
```

An even smaller one that isolates the _first_ error (put in `/tmp/ct_bind.yo`):

```rust
count_types :: (fn(...(comptime(types) : ComptimeList(Type))) -> comptime(usize))(types.len());
n :: count_types(i32);
main :: (fn() -> unit)({ (); });
export(main);
```

yo-self reports, pointing at the **definition** line, column 83 — i.e. inside the
function's own body:

```
Error: Variable "types" not found.
  count_types :: (fn(...(comptime(types) : ComptimeList(Type))) -> comptime(usize))(types.len());
                                                                                    ^
```

**`YO_DEBUG_SWALLOW=1` is the key tool.** It prints every def-time error yo-self
swallows; without it you see only the downstream symptom.

**Control that works** — so the trigger is variadic-ness specifically, not
comptime functions in general:

```rust
plain_ct :: (fn(comptime(a) : Type) -> comptime(usize))(usize(1));
comptime_assert(plain_ct(i32) == usize(1), "control");   // compiles clean in BOTH
```

---

## 4. The verified failure chain

1. Evaluating `count_types`'s **body at definition time**, the variadic parameter
   `types` is not in scope → `Variable "types" not found`. **Swallowed.**
2. The definition therefore never produces a value.
3. So at the call site the callee's `ExprInfo.value` is `None`
   (`function.yo:2939-2943`).
4. So `ct_func_value` degrades to `EvalValue.UnitVal` (`function.yo:5218`, a
   `.None => EvalValue.UnitVal` fallback).
5. So `evaluate_comptime_fn_call` reports **"function_value is not a FuncVal"**
   (`comptime_fn.yo:483-500`). **Swallowed.**
6. So the enclosing `==` has type `unknown`, and `comptime_assert` rejects it —
   `Expected bool value for "comptime_assert"` (`comptime_assert.yo:120-151`).
   **Swallowed.**
7. So the whole body's evaluation aborts and **no ExprInfo is recorded**.
8. So codegen's `get_expr_info` lookup misses and emits
   `// Failed to transpile <the ENCLOSING expression>`
   (`codegen/exprs/generation.yo`, the `.None` arm). In a generated test batch the
   enclosing expression is the **entire `match` dispatch** — so one failed
   compile-time assertion erases every test in the file.

**Step 1 is the bug. Steps 2-8 are consequences.** Every fix attempt aimed at
steps 3-8 has failed (§5).

---

## 5. Four attempts that did NOT work — do not repeat these

### Attempt 1 — hoist the comptime-only markers above the ExprInfo lookup ✅ SHIPPED, insufficient

`generate_func_call` bailed to the marker before reaching its
`comptime_assert`/`comptime_expect_error` skip list. Hoisting the list above the
lookup (matching `generation.ts:1081-1102`) is **correct and is merged** — it takes
a standalone `comptime_assert(x(0 .. 5) == "Hello", …)` from 1 marker to 0. It does
**not** fix the three files, because their failure is upstream at step 1.

### Attempt 2 — hoist the structural `begin`/`cond`/`match` dispatches ❌ HARMFUL

Tempting, because none of those generators takes an `ExprInfo`, and it makes all
three files report **`hollow=0`**. **It is not a fix.** The bodies still do not
run: the failure just moves into `generate_match_expression`, which emits
`/* "match" expression is not evaluated */` — a comment the hollow detector does
not grep for.

Caught by injecting `assert(i32(1) == i32(2))` into a test body: it still reported
**"10 passed"**. This would trade a _detectable_ hollow for an _invisible_ one and
silence the gate. `codegen/exprs/generation.yo` carries a comment at that spot
warning against it. **Do not do this.**

### Attempt 3 — populate `variadic_args` ❌ insufficient (real gap, still worth doing later)

yo-self **consumes** `arg_values.variadic_args` (`comptime_fn.yo:610-614`), and TS
both fills (`helper.ts:1763-1801`) and spreads it (`comptime-fn.ts:73-77`) — but
**every** yo-self construction site passes `ArrayList(VarArgEntry).new()`. Nothing
ever pushes a `VarArgEntry`. `helper.yo` step 7b already evaluates the variadic
args; it just files them into `rt_args` for the C-extern `snprintf` case and drops
them otherwise.

Threading them into the two in-scope `ArgValues` constructions type-checks cleanly
and **does not fix the repro** — because the callee never resolves in the first
place (step 1). Reverted rather than shipped unvalidated. It is a genuine port gap
and will be needed _after_ step 1 is fixed.

### Attempt 4 — bind the variadic param in `_build_def_time_body_env` ❌ NO EFFECT

`function_type.yo` calls `_trial_eval_fn_body` from multiple places, and only the
flow-analysis one (`:984`, via an explicit `get_func_variadic_param` →
`add_variable_to_env` block) binds the variadic parameter. Moving that binding into
the shared `_build_def_time_body_env` (all three call sites), plus giving
`PendingDefEval` a `variadic_param` field for the re-run path, type-checks cleanly
and produces **exactly the same error, at the same line**.

So **the failing evaluation does not go through any of the three
`_build_def_time_body_env` call sites**, or the side-table lookup returns `None`
at that point. That is the single most useful negative result here — it rules out
the obvious location.

---

## 6. MEASURED — the instrumentation result (start here)

Rather than guess a fifth time, the three `_trial_eval_fn_body` call sites were
instrumented with distinct markers and the `/tmp/ct_bind.yo` repro re-run. One
build, and it answers both open questions:

```
64  __DBG_PATH dg_env(deferred_generic)     <- function_type.yo:1192
71  __DBG_PATH flow_env                     <- function_type.yo:984
 0  __DBG_PATH rp_env(rerun_pending)        <- function_type.yo:565  NEVER RUNS
--
 1  __DBG_VP hit                            <- get_func_variadic_param returned Some
```

Two things follow, and they redirect the whole hunt:

1. **The `rp_env` / `_rerun_pending_def_evals` path never executes for this
   repro.** All the `PendingDefEval` plumbing in attempt 4 was irrelevant to it.
   The live paths are `flow_env` and `dg_env`.
2. **The variadic side-table lookup hits ONCE across 71 flow-path body
   evaluations.** `get_func_variadic_param` is returning `None` essentially
   everywhere. So attempt 4's binding was correct in shape and simply never had
   an entry to bind — which is exactly why moving it changed nothing.

**This promotes the key-mismatch hypothesis to the leading candidate.** The side
table is keyed by the **fn-type expr id**, and `copy_func_variadic_param`
(`function_type.yo:854`) re-keys it to the **func-val id**. If the def-time body
eval looks it up under a different id than the one it was registered against, the
lookup misses and the parameter is never bound — producing precisely
`Variable "types" not found`.

**Next step, and it is small:** at the failing site, log both the key being looked
up and the keys actually present in `g_func_variadic_params`. If they differ, that
is the bug and the fix is a key fix, not an architecture change.

Reproduce the instrumentation by adding an `eprintln` at each
`_trial_eval_fn_body` call site (`:565`, `:984`, `:1192`) and inside the
`get_func_variadic_param(...) .Some(...)` arm at `:918-943`.

## 7. What is still NOT known

- Whether `index.test.yo` and `safe_code_structural_gates.test.yo` share this root
  cause. Their triggers differ (comptime string/`ComptimeList` slicing, and
  `comptime_expect_error` respectively), so **assume separate bugs until proven
  otherwise**. Only `variadic_comptime` has been traced.

---

## 8. Suggested approach — diagnose before patching

Four speculative fixes failed. Instrument first.

1. ~~Find the real evaluation path.~~ **DONE — see §6.** The live paths are
   `flow_env` and `dg_env`; `rp_env` never runs.
2. **Check the side-table key — this is now the leading candidate.** §6 shows
   `get_func_variadic_param` returns `Some` exactly ONCE across 71 body
   evaluations, so the binding has nothing to bind. Log both the key looked up and
   the keys present in `g_func_variadic_params`. Registration is keyed by fn-type
   expr id; `copy_func_variadic_param` (`:854`) re-keys to func-val id.
3. **Compare against TS.** `src/evaluator/calls/function-type.ts:499` evaluates the
   body via `evaluateBeginExpression` against the **fn-type evaluation env**, where
   the variadic parameter is already bound. yo-self rebuilds a fresh env instead —
   that architectural difference is the origin of this whole class. The faithful
   fix may be to reuse the fn-type env rather than to patch each rebuild site.
4. Only then apply attempt 3's `variadic_args` work, which is needed once the
   callee resolves.

---

## 9. Validation bar — non-negotiable

**`hollow=0` is NOT proof.** Attempt 2 produced `hollow=0` while running nothing.
Every claimed fix must pass this probe:

```bash
cp tests/variadic_comptime.test.yo tests/zz_probe.test.yo
# insert `assert(i32(1) == i32(2), "PROBE");` as the first statement of a test body
YO_MAIN_STACK_MB=4096 <bin> test tests/zz_probe.test.yo --parallel 1
# MUST FAIL. If it reports "N passed", the bodies still are not running.
rm tests/zz_probe.test.yo
```

Then the full battery — this is the shared def-time body eval, so the blast radius
is every function definition in the language:

```bash
S1=<bin> P=x bash scripts/bootstrap/gates_fast.sh      # 0 failures; battery hollow=0
S1=<bin> P=x bash scripts/bootstrap/fixpoint_only.sh   # FIXPOINT_HOLDS
BIN=<bin> OUT=/tmp/hsweep bash scripts/bootstrap/hollow_sweep69.sh
```

And **delete each fixed file's line** from
`scripts/bootstrap/known-failing.tsv` — the ratchet fails on stale entries by
design, so a real fix makes CI red until the list is updated. That is intentional.

---

## 10. Traps specific to this codebase

- **`check` passes on all of this.** `yo-self check tests/variadic_comptime.test.yo`
  is `rc=0` with 0 errors, because `check` never forces the comptime evaluation a
  real compile does. Never use `check` to validate a fix here.
- **Errors are swallowed.** Without `YO_DEBUG_SWALLOW=1` you will chase symptoms.
  This is not the same as `issues/retired/def-time-body-eval-swallow-surface.md` — that
  explains why the error is _invisible_, not why it happens. Fixing the swallow
  would only make this loud.
- **Do not extract a minimal `main` from a hollow test file.** Both obvious
  reductions compile cleanly and prove nothing. Reduce by deleting arms from the
  real file, or use the checked-in module-level repro.
- **`YO_KEEP_BATCH=1`** preserves `.yo_selftest_batch_*.{yo,bin,bin.c}` next to the
  test file for inspection. The runner batches at 100 tests/batch, so a file can
  emit several — glob them, never assume `_1`.
- Background builds take ~10 min; `gates_fast` ~20; the fixpoint ~15. Do not run
  two heavy jobs at once on a 16 GB box — they swap and manufacture failures that
  do not reproduce.

---

## 11. File map

| What                              | Where                                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| Repro                             | `issues/repros/yo-self-variadic-comptime-call-not-funcval.yo`                             |
| Full history                      | `issues/yo-self-hollow-language-test-files.md`                                            |
| Allowlist                         | `scripts/bootstrap/known-failing.tsv`                                                     |
| The swallowing handler            | `yo-self/evaluator/calls/function_type.yo:249-283`                                        |
| Def-time env builder              | `yo-self/evaluator/calls/function_type.yo:291`                                            |
| Variadic binding (flow path only) | `yo-self/evaluator/calls/function_type.yo:918-943`                                        |
| Variadic side table               | `yo-self/evaluator/types/function.yo:259`                                                 |
| Callee value resolution           | `yo-self/evaluator/calls/function.yo:2939-2963`                                           |
| `UnitVal` fallback                | `yo-self/evaluator/calls/function.yo:5218`                                                |
| "not a FuncVal"                   | `yo-self/evaluator/calls/comptime_fn.yo:483-500`                                          |
| comptime_assert eval              | `yo-self/evaluator/builtins/comptime_assert.yo:100-155`                                   |
| Codegen marker (`.None` arm)      | `yo-self/codegen/exprs/generation.yo`                                                     |
| TS reference                      | `src/evaluator/calls/function-type.ts:499`, `helper.ts:1763-1801`, `comptime-fn.ts:73-77` |
