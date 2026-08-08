# 3 of 188 language test files are HOLLOW under the self-hosted compiler

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

This matters for `plans/SELF_HOSTING_COMPLETION.md` **P2**: after `src/` is
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

That was my first hypothesis and it is wrong. `issues/def-time-body-eval-swallow-surface.md`
is why the error is _invisible_, but the defect itself is one specific failure in
comptime call evaluation. Fixing the swallow would only make it _loud_. Start from
the repro above and `comptime_fn.yo:500` — ask what `function_value` actually is
for a variadic comptime function, since it is evidently not a `.FuncVal`.

Expect the three files to need **separate** fixes: `variadic_comptime` is variadic
comptime calls, `index` is comptime string/`ComptimeList` slicing, and
`safe_code_structural_gates` routes through `comptime_expect_error`.

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
