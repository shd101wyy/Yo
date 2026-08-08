# 5 of 188 language test files fail under the self-hosted compiler (3 HOLLOW, 2 Linux-only RED)

**Found 2026-08-08** by the first full-corpus hollow sweep. Three exit 0 and report
passing tests while **running no assertions at all**; two more fail outright on
Linux while passing on macOS.

| platform            | GREEN | HOLLOW | RED   |
| ------------------- | ----- | ------ | ----- |
| macOS arm64 (local) | 185   | 3      | 0     |
| Linux x86_64 (CI)   | 183   | 3      | **2** |

The 3 HOLLOW are identical on both. The 2 RED are Linux-only — see that section.

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

## Plus 2 RED files — and they are LINUX-ONLY (found in CI, 2026-08-08)

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
so this is a **platform-specific divergence in `yo-self` itself**, not a broken test.
Neither file is in the 23-file `gates_fast` battery, so neither had ever been run
under the self-hosted compiler on Linux before this sweep existed — which is exactly
the blind spot the sweep was written to close.

### Root causes (from the uploaded sweep logs — they are two different bugs)

**`tests/string/string.test.yo` — clang's bracket-nesting limit.**

```
tests/string/.yo_selftest_batch_1.bin.c:44334:23:
  fatal error: bracket nesting level exceeded maximum of 256
yo-self: error: compile: C compiler failed (exit 256)
```

Not an RC or semantics bug — the self-hosted compiler emits **more deeply nested C
than the reference does** for this file, and trips clang's default
`-fbracket-depth=256`. The TS compiler builds the same test fine on the same runner,
so the emitted nesting genuinely differs between the two. Two candidate fixes, and
the choice matters: pass `-fbracket-depth=<N>` in the C-compiler invocation (papers
over it, and the flag is clang/gcc-specific), or find why yo-self nests deeper and
flatten it (addresses the divergence). Prefer diagnosing the divergence first — a
gratuitously deeper emit is itself a signal.

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

so `b` must keep the first `Holder` alive after `a` is reassigned. This is the
premature-drop / use-after-free shape, in the RC area — treat it as the higher
severity of the two.

**Do not assume it is an allocator-masked UAF.** That is the obvious hypothesis
("passes on macOS, fails on Linux" usually means freed memory still holds the old
bytes on macOS), and it was tested and **did not reproduce**:

```bash
MallocScribble=1 MallocPreScribble=1 <bin> test tests/ref_local_binding.test.yo --parallel 1
# -> 2 passed
```

So something other than allocator behaviour differs. Next candidates: platform-
specific codegen paths, or a divergence between the macOS- and Linux-built
self-hosted binaries themselves. Start from the CI artifact, not from local
bisection.

## Gated as a ratchet (done)

The sweep runs in CI as the `hollow-sweep` job, scored against
`scripts/bootstrap/known-failing.tsv` — `<path> <verdict>` pairs covering both
HOLLOW and RED. It compares **pairs, not bare paths**, so a file that changes
verdict (HOLLOW → RED or back) is caught rather than silently tolerated, and it
fails in both directions: an unlisted failure fails (no _new_ regression can
land), and a listed entry that no longer matches also fails (the list cannot go
stale). A missing allowlist file fails loudly too. `ALLOWLIST=/dev/null` demands a
fully-clean sweep. The sweep is resumable via `$OUT/results.txt`.

That banks the 165-file differential immediately, while these five are worked down.
**Fixing one means deleting its line** — the gate will tell you to.

> **Do not rename the allowlist to `.txt`.** `.gitignore` carries a blanket `*.txt`
> rule, which silently kept the first version of this file out of the repo — so the
> gate's first CI run scored every known file as a new regression. The script now
> fails explicitly when the allowlist is missing rather than treating it as empty.

## Remaining work

Root-cause and fix the five, then empty the allowlist.

- **The 3 HOLLOW**: start with `safe_code_structural_gates.test.yo` — smallest (115
  lines, a single `test(...)`, the rest module-level `comptime_expect_error(...)`),
  so the fewest confounders. Per the section above, reduce it by deleting arms from
  the real file, not by writing a new one.
- **The 2 RED**: read the per-file logs from the `hollow-sweep-results` CI artifact
  first — they do not reproduce on macOS, so local bisection will not work.
