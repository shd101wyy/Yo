---
description: "Use when running tests, setting up test files, or debugging test failures in the Yo compiler. Covers yo test, sanitizers, and test file constraints."
---

# Testing Workflows

> Every command here is the self-hosted compiler `yo`, a native binary from a
> release bundle on your `PATH`. The `./yo-cli` bash shim, the TypeScript
> compiler that USED TO live at `src/`, and the `bun test` suites that exercised
> it are all deleted (`src/` is now the Yo compiler — see AGENTS.md's note) — there is no bun, npm, or node in this repo outside
> `vscode-extension/`.

## Testing changes to the repo's `std/`

The installed `yo` resolves `std` from its OWN release bundle (exe-walk-up
beats the `./std` fallback), so running `yo test` from the repo root after
editing `std/` silently tests the INSTALLED std, not your edit. Point it at
the tree explicitly:

```bash
YO_STD=$PWD/std yo test ./tests/sync/channel.test.yo --parallel 1
```

A tree-built stage-1 (`yo build` → `yo-out/<target>/bin/yo`) walks up to the
repo root and finds `./std` naturally, so it needs no override — and it is
what CI's suite legs run. Changes to `src/` codegen are only observable
under such a stage-1; the installed seed emits the old code no matter which
std it reads.

**`--std-path` now works for `yo test` too — but check which binary you are
running.** `yo test` compiles its generated batch in a SPAWNED child
(`src/main.yo`), and that child used to be given `--c-compiler`, `--target`,
`--sanitize` and friends but NOT `--std-path`, so it re-resolved std on its own
and landed back on the installed bundle. The runner evaluated against one std
and compiled the batch against another, silently — green for code that was
never compiled, whenever the edit was behaviour-only rather than shape-changing.
Fixed 2026-08-26 (`issues/fixed/yo-test-does-not-forward-std-path-to-batch-compile.md`,
gated by `tests/cli-cases/test-std-path-forwarded`). **A released `yo` on PATH
predating that fix still has the old behaviour**, so when the binary is not one
you built from this tree, prefer `YO_STD` — it rides the inherited environment
and has always reached the child.

`YO_KEEP_BATCH=1` keeps the generated `.yo`/`.c`/binary next to the test file,
which is how you confirm a batch really transpiled:

```bash
YO_KEEP_BATCH=1 YO_STD=$PWD/std yo test ./tests/sync/atomic.test.yo --parallel 1
bash scripts/count-transpile-failures.sh tests/sync/.yo_selftest_batch_1_0.bin.c
```

### A loopback HTTP framing test only goes RED if the body cannot arrive in ONE read

`std/http`'s `read_http_message` reads 8 KiB at a time and nothing truncates
its buffer to `Content-Length`, so for a small single-shot request the CORRECT
and the BROKEN framing produce byte-identical bodies — a framing test built on
`fetch` + a short body passes either way. Two shapes that actually discriminate
(both used by `issues/fixed/http-content-length-ows-and-invalid-values.md`):

- **Server side** — send a body larger than 8 KiB (12 000 bytes there) on a raw
  `TcpStream`. A mis-read length stops the read after the first chunk, so the
  handler sees a SHORT body. Assert the length and the last bytes, not just
  "the body is non-empty".
- **Client side** — hold the connection OPEN after writing the response
  (HTTP/1.1's default; every older test in `tests/http/` sends
  `Connection: close`, and close-delimiting supplies the body that broken
  framing could not) and give `fetch_with` a `with_timeout`, so a mis-parse
  surfaces as `HttpError.Timeout` instead of a hang.

Run the throwing `fetch` as its OWN `io.spawn`ed task and inspect the
`JoinHandle` result: a handler that `unwind`s the test body leaves the server
task parked on a listener that is never closed, which keeps the Linux event
loop alive and the process never exits (rc=124).

## Scratch experiments

- `tmp/fixme.yo` is the scratch file for one-off experiments (`tmp*` is gitignored). It replaces the old `src/tests/fixme.yo`.
- Type-check it with `yo check tmp/fixme.yo`; compile and run it with `yo compile tmp/fixme.yo --optimize 2 -o a.out && ./a.out`.
- Its contents are disposable — there is no need to restore them after modifying it.

## C codegen tests

- Run specific test: `yo test ./tests/XXX.test.yo` (add `-v` for verbose)
- The **full test suite** (`yo test --bail`) takes ~30 minutes on a Mac Mini M4 and is safe to run locally. Use it for broad regression checks after significant changes.
- `--bail` or `-b` — stop after first failure
- `-v` or `--verbose` — show detailed errors
- `--test-name-pattern "Test XXX"` — run specific test by name
- Tests automatically use AddressSanitizer for leak detection.

## Windows: failing tests report a SIGNAL status, and a runtime-template edit needs TWO builds

`yo test` on Windows used to die with `yo: error: unknown I/O error` at the
first failing test (the waitpid NTSTATUS bug — fixed 2026-08-29,
`issues/fixed/yo-test-failing-child-windows-unknown-io-error.md`). A failing
test now prints `✗` with `Test failed with exit code 22`-style raw statuses
(SIGABRT), the summary, and exits 1 — same shape as Linux.

Two Windows-specific facts remain:

- An abnormal child termination (assert/abort) is a SIGNAL status:
  `code() == None`, `signal() != 0`. Clean nonzero exits still give
  `code() == Some(n)` for n in 0–255.
- **A `src/codegen/async/runtime_io_*.yo` template edit takes effect in the
  compiler's OWN runtime only after a SECOND build** — the stage-1 rule
  again: one `yo build` gives a binary that emits the new runtime but still
  runs the old one. And `yo build` invoked as `yo-out/<target>/bin/yo.exe`
  cannot relink itself (LNK1104: Windows will not overwrite a running
  executable) — compile to a different `-o` path instead.

## Evaluator-only check (no codegen)

- `yo check <file-or-dir>` — runs the evaluator on a single `.yo` file or every `.yo` under a directory and prints any type / evaluator errors. No C generation, no C compile.
- Much faster than `compile` for "does this still type-check?" iteration during refactors or migrations.
- Useful as a bulk sanity pass after touching many files: `yo check ./src` or `yo check std/` before running any test.
- **`check` is evaluator-only.** The async state-machine restrictions are enforced in CODEGEN, so `check` passes straight over them. Use `yo compile src/main.yo --skip-c-compiler` (~3 min) to catch that class.

### `check` + `build` both green is NOT proof for a tree-wide rename

Renaming an existing std method (`HashSet.add` -> `insert`, 2026-08-25) had
`yo check ./std` 152/152, `yo check ./src` 262/262 AND `yo build` rc=0 all green
while the tree was broken. Four classes of call site are structurally invisible:

| invisible in | why |
| --- | --- |
| macro `quote(...)` bodies | not evaluated until expansion, so nothing type-checks them at definition time |
| generic trait-impl bodies | `check` never instantiates them (e.g. `FromIterator.from_iter_add`) |
| generic helpers in the defining module | same — the six `result_set.add` sites inside hash_set's own set-ops |
| **async closure bodies** (`io.async((e) => {...})`) | the evaluator's deferred trial SWALLOWS the error and codegen emits `// Failed to transpile` — **no error anywhere** |

The last row is the dangerous one. A missed call in `std/fs/walker.yo`'s
symlink loop made `walk_with` return an EMPTY list, so `yo fetch`, `yo version`
and both report lints kept building and traversed nothing. See
`issues/ftt-stub-in-live-closure-falls-off-non-void-function.md`.

### `usize` is 32 bits on wasm32 — the native suite cannot see width bugs

The wasm targets are the only place `usize` is not 64 bits, so any code that
hardcodes a bit position, a shift amount, or a `1 << k` boundary is a regression
the whole native suite will pass. Measured 2026-08-27: adding a `>> usize(32)`
step to `HashMap`/`HashSet`'s power-of-two capacity rounding — correct on the
hosts — made `with_capacity` round wrong on wasm32, where a shift equal to the
operand width is undefined. `tests/collections/hash_map.test.yo`'s "rounds up to
power of 2" failed under `--target wasm32-wasip1` while `yo test ./tests` stayed
green at 3240/3240.

Derive widths instead of writing them:

```rust
sh := usize(1);
while(sh < (sizeof(usize) * usize(8)), { c = (c | (c >> sh)); sh = (sh * usize(2)); });
```

and in tests, derive the boundary the same way (`bits :: (sizeof(usize) * usize(8))`,
then `usize(1) << (bits - usize(3))`) rather than writing `usize(1) << usize(61)`,
which is meaningless on a 32-bit target.

**So run the wasm legs locally for anything touching sizes, capacities or bit
math**, one file at a time with a timeout so a hang is a verdict rather than a
wait:

```bash
for f in $(find tests -name '*.test.yo' -not -path 'tests/internal/*' -not -path 'tests/cli-cases/*' | sort); do
  YO_STD=$PWD/std timeout 240 "$BIN" test "./$f" --parallel 1 --target wasm32-wasip1 &> "logs/$(echo $f | tr / _).log"
  echo -e "$?\t$f"
done
```

~4 s a file, ~15 min for the corpus, and it reports HANGS (rc=124) that the
`--bail` suite hides behind whichever file fails first. This is how both the
3.4-hour `ThreadPool` deadlock (`issues/fixed/wasi-thread-pool-submit-deadlock.md`)
and the width bug above were found.

### "Byte-identity of the emitted C" does NOT survive a `std/` source edit

The standing acceptance test for an *additive codegen* change — record `sha256`
of the emitted-C corpus before editing, require `same=N diff=0` — is only valid
when the `.yo` SOURCE is unchanged. Generated C identifiers embed two families
of number: anonymous type ids (`__yo_tN`) and a global declaration/expression
counter (`yo_id_N`, `struct_decl_N`, `enum_decl_N`, `loop_yo_id_N`). **Adding
declarations anywhere in `std/` shifts every counter ordered after the insertion
point by a constant and permutes the `__yo_tN` numbering**, so the `.c` changes
`sha256` even when the program is provably identical. Measured 2026-08-26 while
adding six unused methods to `std/string/string.yo`: the shift was a uniform
+1004, and the numbers appear in `std/collections/array_list.yo` and
`std/allocator.yo` identifiers too, not just the edited file's.

Compare like this instead — it is strictly stronger than a `sha256` match:

```bash
norm() { sed -E 's/__yo_t[0-9]+/__yo_tT/g; s/__YO_T[0-9]+/__YO_TT/g;
                 s/yo_id_[0-9]+/yo_id_N/g; s/(struct_decl|enum_decl|decl)_[0-9]+/\1_N/g;
                 s/_temp_[0-9]+/_temp_N/g' "$1"; }
diff <(norm before.c | sort) <(norm after.c | sort)          # must be EMPTY
diff <(grep -oE '__yo_[A-Za-z0-9_]+\(' before.c | sort -u) \
     <(grep -oE '__yo_[A-Za-z0-9_]+\(' after.c  | sort -u)  # must be EMPTY
grep -c '<the new API you added>' after.c                    # must be 0 if unused
```

An empty sorted-normalized diff with equal line counts says the emitted program
is the same multiset of statements; the symbol-set diff says no function was
added, removed or renamed. In-order differences that remain are pure
declaration reordering.

**And for a "no behaviour change" REWRITE, drop the emitted C entirely —
compare the program's OUTPUT.** The recipe above still assumes the source is
additive. A refactor that claims to preserve behaviour while changing function
BODIES (a loop rewritten onto a different iterator, a method renamed and
delegated) makes the emitted C differ on purpose, so no C-level comparison
— normalized or not — can pass without weakening it into meaninglessness.
Measured 2026-08-26 on the D4 PR 2 migration: 13567 → 14139 lines and a
different symbol set, from a change whose whole contract was "no behaviour
change". The gate that has teeth:

```bash
# 1. BEFORE editing: a standalone driver over the touched surface, with a
#    corpus that includes the inputs the refactor is ABOUT (multibyte, empty,
#    boundary). Print every result AND its length, so a silent truncation
#    shows up.
yo compile tmp/probe.yo --std-path "$PWD/std" --optimize 2 -o tmp/probe.bin
./tmp/probe.bin > before.txt; shasum -a 256 before.txt
# 2. AFTER: same binary rebuilt, same corpus.
./tmp/probe.bin > after.txt; diff before.txt after.txt     # must be EMPTY
```

Two companions make it airtight. **Body-identity** where the refactor claims a
pure rename: extract the old body with `git show HEAD:<file>` and compare it
character-for-character to the new one — that covers call sites no runtime test
can reach (compiler-internal code, which does not take effect until the tree is
rebuilt). And a **simulated future state**: if the refactor exists to survive a
change that has not landed yet, apply that change in a throwaway edit and run
the new tests against it, then run them again with the pre-refactor file. The
new tests must fail in the second run. If they pass both ways they are not
testing the refactor.

So for a rename sweep the gate is the FULL suite plus READING the cli-case
golden diff — never check/build. A golden that gets SMALLER or reports FEWER
findings (`Scanned 1 .yo file(s)` -> `Scanned 0`) is a regression signal, not
drift. Grep separately inside `quote(`, `impl(` and `io.async(` bodies; the
compiler will not name those sites for you.

## Build system tests

- The build system is covered by `.yo` tests in `tests/internal/`: `build_runner.test.yo`, `lock_file.test.yo`, `target.test.yo`, `fetch.test.yo`, `install_command.test.yo`, `cache.test.yo`, `init.test.yo`, `version.test.yo`.
- Tests cover: build registry, artifacts, steps, DAG, dependencies, lock file, target parsing, path deps, transitive deps.
- Run them like any other internal test: `yo test ./tests/internal/build_runner.test.yo --parallel 1`.
- End-to-end CLI subcommand behaviour is covered separately by the `tests/cli-cases/` corpus.

## Adding a cli-case: `yo fmt` the fixture BEFORE recording the golden

A cli-case fixture (`tests/cli-cases/<case>/fixture/*.yo`) is a real `.yo` file
and CI's "Check the formatted code" step scans the whole tree, so an
unformatted fixture reds the PR even when every other gate is green. Fixtures
sit outside the `src/ std/ tests/internal/` paths people usually pass to
`yo fmt`, which is exactly why this is easy to miss.

Order matters: formatting changes the fixture's content hash, and that hash is
part of the case's `expected_tree` golden. So `yo fmt` the fixture FIRST, then
`scripts/cli-diff-test.sh --record <case>`, then re-score without `--record`.
Doing it the other way round means recording twice.

Verify with all three roots, using the INSTALLED release binary rather than a
locally built one, since that is what CI runs:

```bash
yo fmt --check ./src ./std ./tests
```

## Editing ANY file under `.github/skills/` re-records two cli-cases

`yo skills install` (restored in #412) copies the skill tree into a project, and
the `skills-install` / `skills-install-zh` cases record the **content hash of
every installed file** in their `expected_tree`. So a one-line edit to, say,
`.github/skills/yo-syntax/syntax-cheatsheet.md` — the file this repo asks you to
update whenever you learn a Yo lesson — turns the tier-1 CLI gate red with

```
── GOLDEN-DIFF  skills-install  (rc=0; tree)
    content-differs (vs recorded golden hash): ./.agents/skills/yo-syntax/syntax-cheatsheet.md
```

roughly 25 minutes into a PR's `Self-hosted \`test\` subcommand` job. The fix is
a re-record, not a revert:

```bash
YO_SELF_BIN=<your stage-1> bash scripts/cli-diff-test.sh --record skills-install skills-install-zh
YO_SELF_BIN=<your stage-1> bash scripts/cli-diff-test.sh          # re-score, expect a clean card
```

Review the diff before committing: it should be exactly one changed hash line
per case per edited skill file. Anything else means the install copied
something you did not intend.

## A fixpoint run's stage-1 must live OUTSIDE the repo (`/tmp/yo-s1`)

Type keys embed each declaring module's PATH SPELLING, and std resolution is
`--std-path > YO_STD > exe-walk-up > ./std`. A stage-1 sitting INSIDE the
repo (e.g. `yo-out/<target>/bin/yo`) exe-walks-up to the repo std and renders
ABSOLUTE module paths; the script's stage-2 binary is built in `/tmp` and
falls back to relative `./std`. Different path spellings → different type-key
strings → different hash-bucket emission order → a FIXPOINT_BROKEN verdict
with same-content, reordered/renumbered C (measured 2026-08-23: first
divergence was `struct_decl_31673__Users/...` vs `struct_decl_31673___std/...`).
Copy the binary first, exactly as AGENTS.md shows:

```bash
cp yo-out/aarch64-apple-darwin/bin/yo /tmp/yo-s1
S1=/tmp/yo-s1 P=local bash scripts/bootstrap/fixpoint_only.sh
```

## A fixpoint run's stage-1 must come from the SAME tree it compiles

`scripts/bootstrap/fixpoint_only.sh` takes a prebuilt stage-1 via `S1=` and has
it compile the tree as it exists **when the script runs**. So editing anything
between building that stage-1 and starting the gate invalidates the result:
stage-2 then carries the edit while stage-1 does not, the two binaries are
different generations, and their emissions legitimately differ.

Measured 2026-08-13: adding one import to `std/process/command.yo` four seconds
before the gate started produced `FIXPOINT_BROKEN` with **1.1 M differing
lines** — while every individual step passed (`STAGE2_RC=0`, `hollow=0`,
`CLANG_RC=0`, `STAGE3_RC=0`). Rebuilding stage-1 from the final tree gave
`FIXPOINT_HOLDS` with no code change at all.

**Read the diff before believing the verdict.** Pure type-id renumbering
(`__yo_t796` → `__yo_t614` with everything shifted) is the signature of a
different COUNT of type instantiations — i.e. generation skew — not a semantic
regression. A real break shows localized, structural differences instead.

This is the same two-generation rule as the seed pin, in a different costume:
anything that changes `std/` shifts every program that links it.

## Compiler internal tests — `tests/internal/`

These are the self-hosted compiler's own tests. **They lived at `yo-self/tests/`
until 2026-08-05**; translate that path when reading older `issues/` and `plans/`
documents. They moved because the TypeScript `src/` was going to be retired and
`yo-self/` renamed to `src/`, so the tests belong under `tests/` rather than
being shuffled again later. BOTH have since happened.

```bash
yo test ./tests/internal --parallel 1        # the whole directory
yo test ./tests/internal/lexer.test.yo --parallel 1
yo test ./tests/internal/parser.test.yo --parallel 1
```

- They import `src/` internals via `../../src/...`, so every file
  that reaches `evaluator/index.yo` pays a full compiler-sized Yo compile.
- **MEASURED 2026-08-05, M4, `--parallel 1`, 58 files:** 22.2 min under the
  self-hosted binary. (The same sweep took 40.5 min under the since-deleted TS
  compiler, and 63 min as a both-compilers differential — historical, no longer
  runnable.)
- **Use `--parallel 1`, and run one at a time.** `macro_expansion` alone
  peaks at ~6.5 GB, so two concurrent children on a 16 GB machine swap — and the
  swapping trips the runner's own 600 s evaluator deadline, MANUFACTURING failures
  that do not reproduce in isolation. (The runner ignores `--parallel`
  regardless: "Accepted for CLI compatibility; v1 runs sequentially".)
- The fast language suite excludes them: `yo test ./tests --exclude tests/internal`.
  CI does the same, and runs `tests/internal` as its own informational job
  (`compiler-internal-tests` in `.github/workflows/test.yml`).
- Run them whenever modifying `src/` source or these tests.
- No WASM directives needed (pure logic, no I/O syscalls) — but they are
  host-toolchain-only in CI, excluded from the emcc and wasm32-wasip1 jobs.
- Large `.test.yo` files are batch-compiled in chunks of 100 tests by default. Use `--test-batch-size N` to tune this when a generated C batch is too large or when you need tighter failure isolation. Smaller batches reduce C size but repeat Yo compilation, so avoid lowering this unless needed.
- Do not run multiple `yo test ...` commands concurrently. The test path currently writes shared scratch files such as `/tmp/yo_self_out.c`, so concurrent runs can collide and produce misleading compile errors or skipped-test counts.

#### A hollow batch voids EVERY test in it, not one

The self-hosted runner inlines **all test bodies of a batch into a single
`__yo_user_main`** (`src/main.yo:1328-1349`, `cond` arms keyed on
`YO_TEST_INDEX`). So one expression codegen cannot transpile turns that whole
function into a `// Failed to transpile` **C comment** — the C compiler skips
it, the binary runs nothing, and the runner reports **every test in the batch as
passing**. Measured 2026-08-12: 23 vacuous tests in
`tests/internal/expr_info.test.yo`, with the CI job green the whole time
(`issues/fixed/yo-self-option-eq-ref-enum-not-specialized.md`).

The `__yo_user_main` marker gate in `src/codegen/functions/generation.yo`
turns this into a hard error. **Never weaken that gate to get a job green.**

Debugging one:

- `YO_KEEP_BATCH=1` keeps `.yo_selftest_batch_<fi>_<bi>.yo` next to the test
  file; compile that directly to iterate instead of re-running the suite.
- To read the marker's text you need a **pre-gate** binary (an older stage-1) —
  with the gate the compile aborts before the `.c` is written.
- Batch bodies are `ast_expr_to_string()` **re-prints**, not source slices, so a
  round-trip defect is a candidate. Rule it out by testing the natural source
  form as well.
- Prefer `opt.is_none()` over `opt == Option(T).None` in tests: the latter needs
  `Eq` on the payload type specialized, which is a much heavier requirement than
  the assertion actually needs.

#### Counting untranspiled bodies: never anchor to start-of-line

Use `scripts/count-transpile-failures.sh <emitted.c>` — do not hand-roll a
`grep`. Two things make a hand-rolled one wrong in opposite directions:

- **Overcount.** Codegen spells its own marker strings (`String.from("// Failed
  to transpile ")`), so the compiler compiling itself bakes them into stage-2 as
  C string literals. That floor is 15 as of 2026-08-25 and moves whenever
  codegen gains or loses a fallback branch — it is not the "fixed floor of 2"
  older docs assert.
- **Undercount.** `grep -cE '^\s*// Failed to transpile'` scores only the
  standalone-comment form. Codegen also emits markers **mid-line**, as
  `return // Failed to transpile <expr>;` and
  `__yo_tN tmp = // Failed to transpile <expr>;`, and anchoring calls those
  clean. That is the mistake that let a hollow `io.async` closure body ship
  green (`issues/ftt-stub-in-live-closure-falls-off-non-void-function.md`).
- **Invisible since PR #275.** When the untranspilable body sits in a
  **value-returning** function, codegen no longer emits markers at all — the
  whole body becomes
  `abort(); /* untranspilable body in a value-returning fn: ... */`, because
  falling off the end is UB and `-Werror=return-type` rejects it. Such a file
  scores **`0 real`** and the program dies rc=134 at runtime. The script prints
  an `N abort-stub` field for exactly this; **`0 real` alone is not proof a
  file is clean — read the stub count too**, and for an async change also run
  the binary. MEASURED 2026-08-26 on a closure nested inside an `io.async`
  closure body: `0 real (0 string-literal floor, 1 abort-stub)`, rc=134.
- **A missing file used to score clean.** `grep` on a path that does not exist
  printed nothing and the script answered `0 real`, exit 0. It now exits 2 with
  `MISSING FILE`. Check that first when a gate reports a suspiciously clean
  number (`fixpoint_only.sh` scores `/tmp/$P_stage2.c` through this script).

The rule that separates them: a **string-literal** occurrence is immediately
preceded by a double quote; an **emitted marker** never is. Match anywhere on
the line, then reject matches whose preceding byte is `"`. This is the same
discriminator the codegen abort-stub detector uses
(`src/codegen/functions/generation.yo`, PR #275).

`fixpoint_only.sh` and `chunked_gate.sh` both call the script, and
`fixpoint_only.sh` **gates** on it: a stage-2 carrying an untranspiled body is a
broken compiler even when stage2 == stage3 byte-for-byte, because both stages
emit the same hole.

### macOS 26 AMFI / ASAN dylib workaround

On macOS 26+ (current release), locally-compiled C binaries linked against the
Nix-store ASAN dylib (`libclang_rt.asan_osx_dynamic.dylib`) are rejected by
AMFI/XProtect with "Unrecoverable CT signature issue". The process starts but
never executes; the test runner's 60s watchdog eventually kills it. This
affects ALL branches and ALL test files, including a trivial `assert(true)`.

**Workaround**: pass `--disable-sanitize` to skip AddressSanitizer linkage:

```bash
yo test ./tests/basic.test.yo --disable-sanitize --parallel 1
yo test ./tests/internal --disable-sanitize --parallel 1
```

This disables leak detection on macOS, but tests still validate logic.
See `issues/retired/macos-26-asan-blocked-by-amfi.md` for the kernel-log evidence.

**Alternative** (slower, but keeps ASAN coverage on Linux/WASI): use
`--target wasm32-wasip1` to run via `wasmtime`:

```bash
yo test ./tests/internal --target wasm32-wasip1 --parallel 1
```

> Note: no file in `tests/internal` carries a `SkipWasm32*` pragma (verified
> 2026-08-05) — the split evaluator files that used to need them are gone. They are
> kept out of the cross-target CI jobs by `--exclude tests/internal` instead, since
> compiling the compiler for a WASM target costs far more than it proves.

The WASM test runner uses Emscripten (`emcc`) with `-sSTANDALONE_WASM` and
`-sINITIAL_MEMORY=67108864` / `-sSTACK_SIZE=8388608` so large test binaries
have sufficient memory.

Tests that spawn sub-processes (e.g., `integration.test.yo`) are automatically
skipped via `pragma(Pragma.SkipWasm32Wasi);` and are not required for CI on affected systems.

### Stack depth limit for yo-self evaluator tests

> **HISTORICAL (2026-08-05).** The specific function measured below,
> `evaluate()` in `src/evaluator/eval.yo`, was RETIRED along with that whole
> legacy proto-evaluator file, and the linker-level stack reserves quoted below
> lived in the since-deleted TypeScript test runner. The **mechanism and the
> platform numbers still apply** to the other large evaluator frames
> (`evaluate_match` ~9 MB, `evaluate_function_call` ~8 MB at `-O0`) — this
> section is kept as the explanation for why deep comptime recursion needs a big
> stack.
>
> **What provides that stack today:** every emitted binary runs its program body
> on a worker thread with a **1 GiB stack by default**, overridable at runtime
> via the `YO_MAIN_STACK_MB` env var (`__yo_main_stack`, emitted by
> `src/codegen/functions/generation.yo`, on both the POSIX and Windows arms).
> WASM keeps a direct call and has no worker stack, so `YO_MAIN_STACK_MB` is a
> no-op there. Nothing sets a linker `-stack_size` / `/STACK:` reserve any more.

The `evaluate()` function in `src/evaluator/eval.yo` had ~2482 local variables
(grown from ~693 in early phases) and occupied **~1.5 MB of stack space per frame**
at `-O0` without ASAN, due to the large `EvalValue`/`TypeValue` enum types stored
directly on the stack. ASAN inflates this further by disabling stack frame reuse
and adding redzones around every variable.

**Per-frame overhead by platform:**

- macOS ARM64 native (no ASAN): ~1.5MB per `evaluate()` frame
- macOS ARM64 with ASAN: ~566KB per `evaluate()` frame (ASAN "fake stack" uses
  separate heap allocation, reducing the real C-stack portion)
- Windows x86_64: ~1.1MB per `evaluate()` frame with ASAN

**macOS ARM64 native (measured against a 256MB reserve, `-Wl,-stack_size,0x10000000`):**

- Safe: countdown(1) needs ~5 frames × 1.5MB ≈ 7.5MB (was SIGSEGV at 8MB default)
- Safe: countdown(10) needs ~50 frames × 1.5MB ≈ 75MB → ✓ with 256MB reserve
- Safe: ack(2,3) needs ~100 frames × 1.5MB ≈ 150MB → ✓ with 256MB reserve
- Unsafe: ack(3,2) needs ~2700+ frames → **STACK OVERFLOW** (too deep for any reasonable stack)

**macOS ARM64 with ASAN (8MB default; --disable-sanitize recommended):**

- Safe: countdown(1) needs ~5 frames × 566KB ≈ 2.8MB → ✓
- Safe: fib(1) needs ~4 frames × 566KB ≈ 2.3MB → ✓
- Unsafe: countdown(2) needs ~7 frames × 566KB ≈ 4MB → **STACK OVERFLOW** (after Phase 3a ExprId growth)
- Unsafe: fact(2) needs ~8 frames × 566KB ≈ 4.5MB → **STACK OVERFLOW**
- Unsafe: fib(5) needs ~22 frames × 566KB > 8MB → **STACK OVERFLOW**

Note: Frame sizes grew significantly after Phase 3a (ExprId added to AstExpr) and Phase 2az
(TraitT extended with new fields). See `issues/asan-eval-frame-size-after-expr-id.md`.

**Windows x86_64 (measured against a 16MB reserve, `-Wl,/STACK:16777216`):**

- Safe: countdown(2) needs ~7 frames × 1.1MB ≈ 7.7MB → ✓
- Safe: fact(2) needs ~8 frames × 1.1MB ≈ 8.8MB → ✓
- Unsafe: countdown(3) / fact(3) would exceed 16MB → **STACK OVERFLOW**

When writing recursive evaluator tests, use small inputs (e.g. fib(1), countdown(1)).
Do NOT use `ASAN_OPTIONS=stack_size=N` — that sets the fake stack, not the real C stack.

## Important constraints

- You **cannot** `yo compile` on a `*.test.yo` file. To test a failing test, move the code into a separate `.yo` file with a `main` function and `export(main);` at the end.
- Always save test log output: `yo test ./tests/XXX.test.yo --bail --verbose &> test_output.txt`
- If a `main` linker error appears (`undefined reference to 'main'`), add `export(main);` at the end of the `.yo` file.

## File creation rules

- Do not create new `.js`, or `.ts` files unless told to do so — the repo has no JS/TS toolchain outside `vscode-extension/`.
- You can comment out existing code in `tmp/fixme.yo` and create new test code there.
- If you want to create new `.yo` files, create them in `./tmp` directory under this workspace, not `/tmp`.

## Test syntax

Tests use the `test` keyword with exactly 2 arguments: a name string and a body block.

```rust
{ assert } :: import("std/assert");
test("my test", {
  assert(true, "ok");
});
```

`assert`/`panic` are NOT prelude-ambient — every test file that uses them
needs `{ assert, panic } :: import("std/assert");` at the top (after any
`pragma(...)` line).

**`io : Io` is automatically bound** inside every test body — no parameter is needed. All tests can use `io.async(...)`, `io.await(...)`, `io.spawn(...)`, etc. directly:

```rust
test("Async test", {
  task := io.async((io : Io) => {
    io.await(yield(), io);
  });
  io.await(task, io);
});
```

> **Note:** The old `test "name", using(io : Io), { body }` 3-argument form is no longer supported.

## Assertion builtins for Yo tests

- `assert(condition, "message")` — runtime assertion (evaluates at runtime in the compiled C code); requires `{ assert } :: import("std/assert");`. The message accepts any `ToString` type; `assert(condition)` uses the default message.
- `comptime_assert(condition, "message")` — compile-time assertion (evaluates during compilation). Use this for testing comptime behavior.
- `comptime_expect_error(expr)` — expects the expression to produce a compile-time error. Use this to test that invalid code is properly rejected.

`assert(condition, msg)` accepts any `msg` implementing `ToString` — plain
`str` literals, template strings, integers, etc. all work:

```rust
assert(false, `unexpected: ${value}`);
assert(false, "unexpected");
```

For a diverging panic in a VALUE-position match/cond arm (the arm must yield
`T`), use the builtin `__yo_panic("...")` — `std/assert`'s `panic` returns
`unit` and cannot adopt the sibling arm's type.

## Exception effect in yo-self tests

When testing a function that takes an `exn : Exception` parameter, build the handler
locally and pass it in:

```rust
test("my test", {
  exn := Exception(throw : ((err) -> { assert(false, "unexpected error"); unwind(()); }));
  result := my_function_that_throws(exn);
  // ...
});
```

This is the standard pattern from `tests/internal/parser.test.yo`. The struct
constructor `Exception(...)` pins the binding's type, so no annotation is needed
on the LHS.

Prefer `comptime_assert` over `assert` when the value being tested is compile-time known.

## Partial application (`_`) tests

Partial application tests live in `tests/fn.test.yo`. Key facts:

- Partial application with `_` only works on **comptime functions** (return type must be `comptime(...)`)
- It does NOT work on runtime functions or `generic` parameters — use `comptime` parameters instead
- Type constructors like `Result`, `Option` use comptime params and work with `_`
- `fn(generic(A, B, C)) -> comptime(Type)` does NOT support `_` — the partial application counts the original function type's `parameters`, which excludes generic params
- Use `fn(comptime(A) : Type, comptime(B) : Type) -> comptime(Type)` for custom type constructors that need `_`

## Formatting

`yo fmt` is the only formatter in the repo — the JS/TS lint and format scripts
(`bun run lint`, `bun run format`, eslint, prettier) went with the TypeScript
tree. The one exception is `vscode-extension/`, which keeps its own npm
toolchain.

- **Always run `yo fmt <files>` on any `.yo` files you create or modify before committing.**
  - To check: `yo fmt --check path/to/file.yo`
  - To fix: `yo fmt path/to/file.yo`
  - Example: `yo fmt tests/internal/formatter.test.yo`

## Slow test files

Some test files contain hundreds of tests and take a long time on their own:

- `tests/string/string.test.yo` — 246 tests, ~8 minutes
- Other large test files may take several minutes

When running a single large file, use `--test-name-pattern` to target individual tests for faster iteration. The full suite (`yo test --bail`) finishes in ~30 minutes total on a Mac Mini M4.

For large generated test binaries, use `--test-batch-size N` to split one `.test.yo` file into smaller generated C binaries. The default is 100 tests per batch.

## WASM testing

- Run a test on Emscripten: `yo test ./tests/XXX.test.yo --cc emcc` (auto-targets `wasm32-unknown-emscripten`)
- Run a test on standalone WASI: `yo test ./tests/XXX.test.yo --target wasm32-wasip1` (runs via `wasmtime`)
- Use `pragma(Pragma.SkipWasm32Emscripten);` to skip a test file on the Emscripten target.
- Use `pragma(Pragma.SkipWasm32Wasi);` to skip a test file on the standalone WASI target.
- Use `pragma(Pragma.SkipWasm);` to skip a test file on ALL WASM targets (generic catch-all).
- Place skip pragmas at the top of the file (within the first 50 lines). A file can have both target-specific pragmas, or the generic one. Pragmas are validated by the evaluator against the `Pragma` enum in `std/prelude.yo`, so typos surface as compile errors.
- For per-test skips, add `{ arch, Arch } :: import("std/process");` and use `if((arch == Arch.Wasm32), return())` at the top of the test body.
- See `plans/reference/WASM_SUPPORT.md` for the full list of WASM-skipped tests and limitations.
- **Errno values differ on WASM** (WASI numbering). Always use constants from `std/libc/errno`, never hardcode errno numbers.
- When adding new tests, verify they pass on native (`yo test ...`), Emscripten (`yo test ... --cc emcc`), and WASI (`yo test ... --target wasm32-wasip1`), or add appropriate `pragma(Pragma.SkipWasm*);` calls.
- `process.platform` returns `"emscripten"` or `"wasi"` depending on target.
