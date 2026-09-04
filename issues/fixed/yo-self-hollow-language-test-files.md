# 3 of 188 language test files are HOLLOW under the self-hosted compiler

> **RESOLVED 2026-08-08.** All three are fixed and
> `scripts/bootstrap/known-failing.tsv` is EMPTY — the full-corpus sweep now
> demands a clean run on its own. What actually caused them, and why the first
> four fix attempts all missed, is in
> [`handover-yo-self-hollow-files.md`](handover-yo-self-hollow-files.md);
> the short version is that **all three were five separate bugs**, each hidden
> behind ONE swallowed error that erased the file's whole batch dispatch:
>
> | file                         | bug                                                                                                                                                                                                   |
> | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | `variadic_comptime`          | a comptime variadic parameter was never bound into the CALLEE env (the `quote` sibling was; the comptime one had no branch at all)                                                                    |
> | `index`                      | the `slice_copy` rewrite fired on comptime receivers; the range-type test matched a struct NAME that is always empty; `Range`/`RangeInclusive` are structurally identical so every `..` read as `..=` |
> | `safe_code_structural_gates` | `comptime_expect_error` restored the frame DEPTH but not the frames themselves, losing the MODULE frame; and a rejected module-level binding leaked into the codegen module-global registry           |
>
> Validation used the bar this document itself sets: an injected
> `assert(i32(1) == i32(2))` now FAILS in each of the three (it reported a
> clean pass before).

**Found 2026-08-08** by the first full-corpus hollow sweep. They exit 0 and report
passing tests while **running no assertions at all**.

| platform            | GREEN | HOLLOW | RED              |
| ------------------- | ----- | ------ | ---------------- |
| macOS arm64 (local) | 185   | 3      | 0                |
| Linux x86_64 (CI)   | 183   | 3      | 2 → **0, fixed** |

> **The 2 RED files are FIXED** (see "Plus 2 RED files" below for the diagnosis).
> Neither was actually platform-specific — Linux merely exposed both. They are no
> longer in `scripts/bootstrap/known-failing.tsv`. **The 3 HOLLOW remain open**
> and are what this issue now tracks.

## The census (first ever)

`scripts/bootstrap/hollow_sweep69.sh` runs every `tests/**/*.test.yo` except
`tests/internal` through `<bin> test` and scores each file honestly: GREEN
requires exit 0 **and** an emitted batch `__yo_user_main` that is not a
`// Failed to transpile` comment.

```
BIN=<self-hosted binary> OUT=/tmp/hsweep bash scripts/bootstrap/hollow_sweep69.sh
awk '{print $2}' /tmp/hsweep/results.txt | sort | uniq -c
```

| verdict | count |
| ------- | ----- |
| GREEN   | 185   |
| HOLLOW  | **3** |
| RED     | 0     |

```
tests/index.test.yo                      HOLLOW rc=0 hollow=1 markers=1  49 passed
tests/safe_code_structural_gates.test.yo HOLLOW rc=0 hollow=1 markers=1   1 passed
tests/variadic_comptime.test.yo          HOLLOW rc=0 hollow=1 markers=1  10 passed
```

Note the pass counts. `tests/index.test.yo` reports **49 passed** while
executing nothing — a bare "N passed" from the self-hosted runner is not
evidence that anything ran.

## Why this was invisible

CI runs `<bin> test` on only the **23-file** `gates_fast.sh` battery; the other
**165 language files were exercised solely by the TypeScript compiler**. All
three hollow files are outside the battery. `hollow_sweep69.sh` was written
precisely to close this and had been wired into no workflow at all
(`grep -rn hollow_sweep .github/` returned nothing) — see the ratchet below.

This matters for `plans/archive/SELF_HOSTING_COMPLETION.md` **P2**: after `src/` is
retired, the self-hosted binary's "N passed" becomes the only signal there is.

## Shape of the failure

In all three the **entire** test-dispatch `match` degrades to a comment, so the
whole file's body is skipped in one go:

```c
  // Failed to transpile match(((__yo_batch_env.env).get)(("YO_TEST_INDEX".to_string)()),
  //   .Some(__yo_test_idx) => cond((__yo_test_idx == ("0".to_string)()) => begin(...
```

Candidate constructs per file (each file's arms are dominated by one theme):

- `index.test.yo` — Index-trait reads, array/string slicing, `ComptimeList`
- `safe_code_structural_gates.test.yo` — `inout` params; 115 lines with a single
  `test(...)`, the rest module-level `comptime_expect_error(...)` negative cases
- `variadic_comptime.test.yo` — variadic comptime functions

## ROOT CAUSE TRACED 2026-08-08 — it is the EVALUATOR, not codegen

The `// Failed to transpile` marker is a **symptom**. The chain, established with
`YO_DEBUG_SWALLOW=1` (which prints every def-time error yo-self swallows):

1. A comptime call fails to evaluate — `evaluate_comptime_fn_call: function_value
is not a FuncVal` (`yo-self/evaluator/calls/comptime_fn.yo:500`).
2. So the enclosing comparison has type `unknown`.
3. So `comptime_assert` rejects it — `Expected bool value for "comptime_assert"`
   (`yo-self/evaluator/builtins/comptime_assert.yo:120-151`). **Swallowed.**
4. So the whole `main` body's evaluation aborts and **no ExprInfo is recorded**.
5. So codegen's `get_expr_info` lookup takes its `.None` arm and emits the marker
   — and because the batch's body is one giant `match`, that marker replaces the
   entire dispatch, taking every sibling test arm with it.

### Minimal repro (5 lines, clean TS/yo-self differential)

```rust
count_types :: (fn(...(comptime(types) : ComptimeList(Type))) -> comptime(usize))(types.len());
comptime_assert(count_types(i32) == usize(1), "one");
main :: (fn() -> unit)({ (); });
export(main);
```

- **TS**: compiles clean, 0 markers.
- **yo-self**: `error: Expected bool value for "comptime_assert"`, exit 1.

Not the round-trip: the `ast_expr_to_string` form `(types.len)()` fails
identically to the original `types.len()`. Not batch-specific either — this is at
module level, no `test(...)` and no dispatch. Note the original test FILE
`check`s clean (rc=0), because `check` does not force the comptime evaluation
that a real compile does.

### This is NOT the def-time swallow surface

That was my first hypothesis and it is wrong. `issues/retired/def-time-body-eval-swallow-surface.md`
is why the error is _invisible_, but the defect itself is one specific failure in
comptime call evaluation. Fixing the swallow would only make it _loud_. Start from
the repro above and `comptime_fn.yo:500` — ask what `function_value` actually is
for a variadic comptime function, since it is evidently not a `.FuncVal`.

Expect the three files to need **separate** fixes: `variadic_comptime` is variadic
comptime calls, `index` is comptime string/`ComptimeList` slicing, and
`safe_code_structural_gates` routes through `comptime_expect_error`.

### Two concrete leads in the CTFE call path (start here)

The CTFE route that reaches `evaluate_comptime_fn_call` is
`yo-self/evaluator/calls/function.yo:5200-5250`. Two things there look wrong for a
variadic comptime function, and both are consistent with the observed error:

1. **The callee falls back to a non-function value.** At `:5218`

   ```rust
   ct_func_value := match(callee_value,.Some(v) => v,.None => EvalValue.UnitVal);
   ```

   so an unresolved callee silently becomes `UnitVal` — which is precisely what
   `evaluate_comptime_fn_call` then rejects with "function_value is not a FuncVal"
   (`comptime_fn.yo:483-500`). The error message names the symptom; this is where
   the `None` originates. Worth throwing a diagnostic here rather than
   substituting `UnitVal`.

2. **The variadic arguments are dropped on the floor.** At `:5211-5215` the
   ArgValues is built as

   ```rust
   ct_arg_values := ArgValues(
     forall_args : ArrayList(ArgEntry).new(),
     args : ct_arg_entries,
     implicit_args : Option(ArrayList(ArgEntry)).None,
     variadic_args : ArrayList(VarArgEntry).new()   // <-- always EMPTY
   );
   ```

   `variadic_args` is never populated on this path, so even a correctly-resolved
   variadic comptime callee would be invoked with no variadic arguments. Compare
   the non-CTFE call path, which does collect them.

Confirm with the checked-in reproducer, and check the same two lines against the
TS equivalent before changing them — the CTFE route is shared by comptime methods
and macros, so an over-broad change here has wide blast radius.

### THE ACTUAL FAILING SITE (attempted 2026-08-08, three layers deep)

Lead 2 above is real but **not sufficient**, and the true failure is earlier than
the call. Narrowing it down:

**Layer 1 — `variadic_args` is never populated (real gap, fix written and reverted).**
yo-self already CONSUMES `arg_values.variadic_args` (`comptime_fn.yo:610-614`),
and TS both fills it (`helper.ts:1763-1801`) and spreads it
(`comptime-fn.ts:73-77`). But **every** construction site in yo-self passes
`ArrayList(VarArgEntry).new()` — grep it: nothing ever pushes a `VarArgEntry`.
`helper.yo` step 7b already evaluates the variadic args, it just files them into
`rt_args` (for the C-extern `snprintf` case) and drops them otherwise. Threading
those into the two in-scope `ArgValues` constructions type-checks cleanly, but
does NOT fix the reproducer — so it is necessary-but-not-sufficient and was
reverted rather than shipped unvalidated.

**Layer 2 — the failure is at DEFINITION time, not at the call.** The error points
at the function's own body:

```
Error: Variable "types" not found.
  count_types :: (fn(...(comptime(types) : ComptimeList(Type))) -> comptime(usize))(types.len());
                                                                                    ^ 1:83
```

So the def-time body evaluation cannot see the variadic parameter. That is why
the callee ends up with no value, which is why `ct_func_value` degrades to
`UnitVal` at `function.yo:5218`, which is why `comptime_fn.yo:500` reports "not a
FuncVal". The call-site leads are all downstream of this.

**Layer 3 — one def-time path binds the variadic parameter and the other does not.**
`function_type.yo` calls `_trial_eval_fn_body` from two places:

- `:984` (`flow_env`) — binds it, via the explicit
  `get_func_variadic_param(...) -> add_variable_to_env(...)` block at `:918-943`,
  with a comment noting the name/type "are not on TypeValue.Func, so they ride the
  side table".
- `:565` (`rp_env`, `_rerun_pending_def_evals`) — **does not**. It builds the env
  with `_build_def_time_body_env`, which has no variadic binding of its own, and
  never adds the block the flow path has.

**Suggested fix:** give `PendingDefEval` (`:219-232`) the variadic parameter (it
currently carries only `param_labels`/`param_types`/…), populate it where the
pending eval is registered, and bind it in `_rerun_pending_def_evals` right after
`_build_def_time_body_env`, mirroring `:918-943`. Better still, move the binding
INTO `_build_def_time_body_env` so both callers get it and the two paths cannot
drift again — that drift is the whole bug.

Do Layer 1 as well; it is a genuine port gap and will be needed once the callee
resolves. Gate the change with the full battery: this is the shared def-time body
eval, so the blast radius is every function definition in the language.

**ATTEMPTED AND RULED OUT (2026-08-08).** The suggested fix above was implemented —
the variadic binding moved into `_build_def_time_body_env` (so all three call sites
get it), `PendingDefEval` given a `variadic_param` field for the re-run path, and
the flow path's bespoke copy deleted. It type-checks cleanly and produces **exactly
the same error at exactly the same line**. So the failing evaluation **does not go
through any of the three `_build_def_time_body_env` call sites** — or
`get_func_variadic_param` returns `None` there (the side table is keyed by fn-type
expr id, and `copy_func_variadic_param` at `:854` re-keys it to the func-val id, so
a key mismatch is a live but unverified hypothesis). Reverted.

That is now **four** failed attempts on this bug. **Stop guessing and instrument**:
put a marker in the `.None` arm that yields `Variable "types" not found`, or at each
`_trial_eval_fn_body` call site, and run the repro. One build answers what four
speculative fixes did not. See
[`handover-yo-self-hollow-files.md`](handover-yo-self-hollow-files.md) for the full
working brief.

### A tempting codegen "fix" that is actively harmful — do not do it

`generate_func_call` bails to the marker whenever `get_expr_info` misses, _before_
reaching its compile-time-marker skip list. Hoisting the structural
`begin`/`cond`/`match` dispatches above that lookup (none of them take an
ExprInfo) makes all three files report `hollow=0`. **It is not a fix.** The bodies
still do not run — the failure just moves into `generate_match_expression`, which
emits `/* "match" expression is not evaluated */`, a comment the hollow detector
does not grep for. Verified by injecting `assert(i32(1) == i32(2))` into a test
body: it still reported "10 passed".

That would convert a _detectable_ hollow into an _invisible_ one, silencing the
gate. `yo-self/codegen/exprs/generation.yo` carries a comment at that spot saying
so. Hoisting only the compile-time markers (which genuinely emit no C, matching
`generation.ts:1081-1102`) IS correct and is done; it fixes the standalone case
and leaves the batch failure detectable.

## Do not extract a minimal `main` — it false-passes

Both obvious reductions were tried and **both compile cleanly** under the
self-hosted compiler, proving nothing:

1. `swap(x, y)` with `inout(a) : i32` params in a plain `main` — clean.
2. The same body kept inside a `test(...)` wrapper in a fresh one-test file —
   also clean, `0` markers in the batch `__yo_user_main`.

So the trigger is not `inout` alone, nor the batch wrapper alone. It needs the
surrounding file — most likely the module-level `comptime_expect_error(...)`
declarations interacting with batch generation. Reduce by **deleting arms from
the real file** (keeping the `test(...)` wrapper and the module preamble) rather
than by writing a new small file.

## Plus 2 RED files — FIXED 2026-08-08 (found in CI the same day)

The census above was taken on macOS arm64. The first CI run of the sweep (Linux
x86_64) reproduced the same 3 HOLLOW exactly, and found **two more files that fail
outright there while passing on macOS**:

```
tests/ref_local_binding.test.yo  RED rc=1 hollow=0 markers=0  1 passed
tests/string/string.test.yo      RED rc=1 hollow=0 markers=0  none
```

- `ref_local_binding` exits 1 _after_ reporting "1 passed" — a later test fails.
- `string/string` exits 1 with no summary at all — it dies before running anything.

Both pass under the TS compiler on Linux (the `test (ubuntu-latest)` job is green),
so both are divergences in `yo-self` itself, not broken tests. Neither file is in
the 23-file `gates_fast` battery, so neither had ever been run under the
self-hosted compiler on Linux before this sweep existed — exactly the blind spot
the sweep was written to close.

**Neither turned out to be genuinely platform-specific.** Linux merely exposed
both: one through a stricter clang default, the other through a stricter
allocator. Both reproduce and are fixable from macOS once you know that.

### Root causes (from the uploaded sweep logs — they are two different bugs)

**`tests/string/string.test.yo` — clang's bracket-nesting limit.**

```
tests/string/.yo_selftest_batch_1.bin.c:44334:23:
  fatal error: bracket nesting level exceeded maximum of 256
yo-self: error: compile: C compiler failed (exit 256)
```

Not an RC or semantics bug — the self-hosted compiler emits **more deeply nested C
than the reference does** for this file, and trips clang's default
`-fbracket-depth=256`.

**RESOLVED — it was a missing port, and the deeper nesting was the symptom.**
yo-self compiled every test in a file as ONE batch, and the generated `cond`
dispatch nests one brace level per test: 252 tests → 261 levels. TS was already
batching at `DEFAULT_TEST_BATCH_SIZE = 100` (`src/test-runner.ts:54`), so its emit
for the same file peaks at 105 across 3 batches.

It is also not platform-specific: local clang 21.1.7 just defaults to a higher
bracket depth than CI's. `clang -fbracket-depth=256 -fsyntax-only <batch>.c`
reproduces it exactly on macOS, which is what made it debuggable.

The tempting fix — passing `-fbracket-depth=<N>` — was rejected: it papers over a
real divergence and the flag is clang/gcc-specific. Porting the batching addresses
the cause. After the fix: 3 batches at depth 109/109/61, 252/252 passing, every
batch clean under an explicit `-fbracket-depth=256`.

**`tests/ref_local_binding.test.yo` — an RC lifetime failure.**

```
✗ "binding the handle keeps an object alive"
```

The test is a handle-aliasing case:

```rust
a := Holder(s : String.from("kept"), n : i32(0));
b := a;
a = Holder(s : String.from("other"), n : i32(1));
assert(b.s == "kept", "b's handle keeps the original object alive");
```

so `b` must keep the first `Holder` alive after `a` is reassigned. This was the
higher-severity of the two — an RC lifetime defect rather than a build failure.

**RESOLVED.** It _was_ allocator-dependent, but not in the way the obvious
hypothesis predicted, which is why `MallocScribble` came back negative:

```bash
MallocScribble=1 MallocPreScribble=1 <bin> test tests/ref_local_binding.test.yo --parallel 1
# -> 2 passed   (scribble fills FREED memory; it does not detect a DOUBLE free)
```

The actual defect is a **double free**, not a stale read: `b := a` left two
`__yo_decr_rc` calls on one `rc=1` object because the dup/drop pair optimizer
cancelled the drop of the wrong variable in the alias chain (it walked the frame
forwards where TS walks it reversed). glibc's allocator detects the second free
and aborts; macOS malloc tolerates it. Scribble was the wrong instrument —
it perturbs freed _contents_, and nothing here ever read freed contents.

Fixed in `yo-self/evaluator/exprs/begin.yo` (reverse the walk **and** port TS's
`dupCalls.length = 0`; either half alone still double-drops). Regression coverage
is in `tests/rc.test.yo` — it counts disposals via a module-level counter so it
fails on every platform, not only where the allocator happens to notice.

**Lesson worth keeping:** "passes on macOS, fails on Linux" has at least two
distinct causes — a stale read of freed memory (scribble finds it) and a double
free (scribble does not). A negative scribble result rules out only the first.

## Gated as a ratchet (done)

The sweep runs in CI as the `hollow-sweep` job, scored against
`scripts/bootstrap/known-failing.tsv` — `<path> <verdict>` pairs covering both
HOLLOW and RED. It compares **pairs, not bare paths**, so a file that changes
verdict (HOLLOW → RED or back) is caught rather than silently tolerated, and it
fails in both directions: an unlisted failure fails (no _new_ regression can
land), and a listed entry that no longer matches also fails (the list cannot go
stale). A missing allowlist file fails loudly too. `ALLOWLIST=/dev/null` demands a
fully-clean sweep. The sweep is resumable via `$OUT/results.txt`.

That banks the 165-file differential immediately, while the remaining three are
worked down.
**Fixing one means deleting its line** — the gate will tell you to.

> **Do not rename the allowlist to `.txt`.** `.gitignore` carries a blanket `*.txt`
> rule, which silently kept the first version of this file out of the repo — so the
> gate's first CI run scored every known file as a new regression. The script now
> fails explicitly when the allowlist is missing rather than treating it as empty.

## Remaining work

The 2 RED are fixed and de-allowlisted. **Three HOLLOW files remain**; fixing them
empties `scripts/bootstrap/known-failing.tsv` and the gate then demands a fully
clean sweep on its own.

Start with `safe_code_structural_gates.test.yo` — smallest (115 lines, a single
`test(...)`, the rest module-level `comptime_expect_error(...)`), so the fewest
confounders. Per "Do not extract a minimal `main`" above, reduce it by deleting
arms from the real file rather than writing a new small one: both obvious
extractions compile cleanly and prove nothing.

Method note from the RED work that applies here too: the `hollow-sweep` CI job now
uploads the per-file sweep logs alongside `results.txt`, so a failure that does not
reproduce locally is still diagnosable from the artifact. That is what turned both
RED files from "Linux-only mystery" into ordinary bugs in one CI cycle.
