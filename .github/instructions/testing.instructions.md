---
description: "Use when running tests, setting up test files, choosing a gate, or debugging test failures in the Yo compiler. Covers yo test, sanitizers and leak tests, cli-cases, the fixpoint, Tier 1 gates, the heavy lock and test file constraints."
---

# Testing Workflows

Every command here is the self-hosted compiler `yo` (a release bundle on `PATH`, or a tree-built
`yo-out/<target>/bin/yo`). There is no bun, npm or node outside `vscode-extension/`.

## Running tests

- `yo test` takes ONE positional path (`test: one path per run`); loop over files and gate on each
  exit code. `yo test --help` lists every flag.
- `--bail`/`-b` stops at the first failure; `-v`/`--verbose` shows details;
  `--test-name-pattern "<regex>"` selects by name (a regex, not a substring); `--list` prints
  `<file>\t<name>` for the selection without compiling; `--json` emits one `test` event per test
  (`file`, `name`, `status`, `duration_ms`, plus `message`/`output` on failure) and a `summary`
  event: read it instead of scraping `✓`/`✗`.
- **Always save verbose output to a file**: `yo test ./tests/x.test.yo --bail -v --parallel 1 &> out.txt`.
  Without `-v` a FAILING test loses its own `println` lines and its assert message (only
  `Test failed with exit code 6` remains). CI passes `--verbose`, so a missing expected
  diagnostic line in a CI log is evidence that the code printing it never ran.
- **The fast language suite needs both excludes**:
  `yo test ./tests --exclude tests/internal --exclude tests/cli-cases --bail` (~30 min).
  `tests/internal` compiles the compiler once per file; `tests/cli-cases` fixtures hold `.test.yo`
  harness inputs, one of which MUST fail. std's own tests: `yo test ./std --bail`.
- Large files are batch-compiled 100 tests per batch (`--test-batch-size N`); a slow file
  (`tests/string/string.test.yo`, ~300 tests) is faster to iterate with `--test-name-pattern`.
- `scripts/test-name-shard.sh <yo> <file> <i> <n>` prints a `--test-name-pattern` for stripe `i` of `n` of one
  file's tests (escaped, anchored, checked against `--list`); CI splits `verifier-list-len.test.yo` with it.
- Tests run under AddressSanitizer by default (leak detection on Linux).
- **The test binaries are compiled by whichever `yo` runs `yo test`.** Under the installed seed a test
  gets the SEED's codegen, and LeakSanitizer reports leaks the tree already fixed. Judge a leak or a
  codegen change with the tree's stage-1: `YO_STD=$PWD/std <stage-1> test <file> --parallel 1`.
- **`yo compile` on a `*.test.yo` file has no `main`**: the Yo side compiles (`--skip-c-compiler`
  succeeds) but the C link fails with `undefined reference to 'main'`. To iterate, extract the case
  into a standalone `.yo` with a `main` function and `export(main);` at the end.
- **A project with a `.yo-version` pin** (`markdown-yo`) re-dispatches EVERY `yo` command run inside it
  to the cached binary of that version (`--version` is answered before the dispatch, so it lies). Set
  `YO_VERSION_DISPATCHED=1` to run a tree or branch binary there.
- **Never point `yo test` at `issues/`.** Several `issues/repros/*.yo` are written in `test(...)` shape;
  a repro for an OPEN bug is supposed to fail.
- Concurrent `yo test` runs over one directory are isolated: batch artifacts are named
  `.yo_selftest_batch_<pid>_<fi>_<bi>` (`tests/internal/concurrent-test-runs.test.yo`).

### Gate on the EXIT CODE, not the last line

| tool | why the tail lies |
| --- | --- |
| `yo check` | on failure the summary (`yo: error: check: 1 file(s) failed evaluator coverage`) prints FIRST and the per-file trace AFTER, so `\| tail` shows `check: invoking evaluate_anonymous_module_begin_exprs`, which looks like success |
| `yo fmt --check` | a clean run is SILENT: empty output cannot be told from a crash |
| the fixpoint gate | its verdict is computed from `/tmp/<P>_stage*.c`, which a previous run may have left behind |

Grepping `evaluator OK` does not fix `check`: a failing run still prints
`check: …/std/prelude.yo — evaluator OK` for the prelude. Grep both sides
(`grep -E "evaluator OK|error|failed"`), or better capture `rc=$?` for every command in a gate script
and print it. The directory form (`check: 275/275 file(s) passed`) means clean only when present AND
both numbers are equal.

## Testing changes to the repo's `std/`

- The installed `yo` resolves `std` from its OWN bundle (resolution order:
  `--std-path > YO_STD > exe-walk-up > ./std`), so `yo test ./tests/...` after a `std/` edit silently
  tests the INSTALLED std. Point it at the tree:
  `YO_STD=$PWD/std yo test ./tests/sync/channel.test.yo --parallel 1`.
- Entries INSIDE a std tree (`yo test ./std`, `yo check ./std`, `yo compile std/...`) resolve that tree
  automatically (stderr note `yo: every entry lives inside the std tree at ...`); `./tests/**` does not.
- `yo test --std-path` reaches the batch-compile child only on a binary carrying that fix
  (`tests/cli-cases/test-std-path-forwarded`); with an older released `yo`, use `YO_STD`, which always
  reaches the child through the environment.
- A tree-built stage-1 walks up to the repo's `./std` and needs no override. Codegen changes in `src/`
  are only observable under it: the seed emits the old code whatever std it reads.
- `YO_KEEP_BATCH=1` keeps the generated `.yo`/`.c`/binary beside the test file, to confirm a batch really
  transpiled:

  ```bash
  YO_KEEP_BATCH=1 YO_STD=$PWD/std yo test ./tests/sync/atomic.test.yo --parallel 1
  bash scripts/count-transpile-failures.sh tests/sync/.yo_selftest_batch_*_1_0.bin.c
  ```

## Building a stage-1, and the C compiler

- **Build stage-1 the way CI does: `YO_MAIN_STACK_MB=4096 yo build --std-path ./std`.** Plain
  `yo build` gives the seed its own bundled std, so a std change the seed cannot lower passes every
  local gate and turns every CI job red at "Build stage 1 once" (#996). A std feature that needs new
  codegen or runtime lands in two steps across a `SEED_VERSION` bump.
- **gcc and clang disagree on emitted-C warnings.** The driver's optimized arm passes clang-only
  `-Wno-everything`, while `-Werror=return-type` stays load-bearing under gcc, so C that is clean under
  clang can fail a gcc build. CI builds with clang. For a matching local clang use the nix shell, and run
  the built binaries inside the same wrapper (outside it the nix-glibc/system-lib mix dies on a pthread
  `allocate_stack: size != 0` assertion):

  ```bash
  nix develop . --command bash -c 'yo build --std-path ./std --cc clang'
  ```

  `--cc` takes only `cc|gcc|clang|zig|emcc` (no path), so clang must resolve on `PATH`.
- **The artifact stamp names the compiler binary** (`yo-binary <path>:<size>:<mtime>`, beside sources,
  `yo.toml`/`yo.lock`, argv and `CURRENT_YO_VERSION`), so `<stage-1> build` really recompiles and yields
  the shipped-configuration stage-2 (mimalloc on Linux, `build.yo`'s flags). Check
  `sha256sum <stage-1> yo-out/<target>/bin/yo` differ. An older binary serves the cached artifact; force
  it with `YO_BUILD_NO_CACHE=1`.
- **Memory and timing verdicts need stage-2 vs stage-2.** A leak census, RSS A/B or
  `scripts/bootstrap/lsp_plateau.py` run on seed-built stage-1 measures the SEED's codegen. The
  fixpoint's `/tmp/<P>_s2` is built with the system allocator and plain `clang -O2`, so its wall time is
  not the shipped compiler's either.
- **Time anything with a tree-built binary, never the seed**: the seed lacks every fix merged since its
  release.
- **Windows:** a `src/codegen/async/runtime-io-*.yo` template edit reaches the compiler's OWN runtime
  only after a SECOND build (one build emits the new runtime but runs the old one), and
  `yo-out/<target>/bin/yo.exe build` cannot relink itself (LNK1104): compile to another `-o`. A failing
  test's abnormal termination is a SIGNAL status (`code() == None`, `signal() != 0`); clean nonzero
  exits give `code() == Some(n)`.

## Scratch files

- `tmp/fixme.yo` is the scratch file (`tmp*` is gitignored; contents are disposable):
  `yo check tmp/fixme.yo`, `yo compile tmp/fixme.yo --optimize 2 -o a.out && ./a.out`.
- Put new experimental `.yo` files in the worktree's `./tmp`, not `/tmp`. Create no `.js`/`.ts` files.

## Writing tests

`test` takes exactly two arguments, a name string and a body block. `assert`/`panic` are not
prelude-ambient: import them at the top (after any `pragma(...)` line). `io : Io` is bound inside every
test body. Each test file has its own import set: check that it imports `println` from `std/fmt` before
using it, and match the file's existing style.

```yo
{ assert } :: import("std/assert");
test("my test", {
  assert(true, "ok");
});
```

```yo
test("Async test", {
  task := io.async((io : Io) => {
    io.await(yield(), io);
  });
  io.await(task, io);
});
```

### Assertion builtins

- `assert(condition, msg)`: runtime; `msg` is any `Display` (`str`, template string, integer);
  `assert(condition)` uses a default message.
- `comptime_assert(condition, "message")`: fires wherever the condition folds to a CONCRETE `false`,
  at module level and inside a function or `test(...)` body. On a condition that is not comptime-known (a
  runtime value, an unbound generic) it only type-checks, so it is no gate there: pin the value in a
  module-level `::` binding and `assert` on that. Vacuity guard:
  `tests/cli-cases/compile-comptime-assert-in-fn-body`.
- `comptime_expect_error(expr, "text")`: expects a compile-time error whose message or help contains
  `text`. Always pass `text`: the one-argument form goes green on any unrelated error. It handles
  evaluator-level rejections, including an `impl(...)` inside a `test(...)` body.
- A diverging panic in a VALUE-position `match`/`cond` arm uses `__yo_panic("...")`: `std/assert`'s
  `panic` returns `unit` and cannot adopt the sibling arm's type.
- Prefer `opt.is_none()` over `opt == Option(T).None`: the latter needs `Eq` specialized on the payload.

### An `Exception` handler for a function under test

```yo
test("my test", {
  exn := Exception(
    throw : (
      err -> {
        assert(false, "unexpected error");
        unwind(());
      }
    )
  );
  result := my_function_that_throws(exn);
  // ...
});
```

The constructor pins the binding's type (pattern from `tests/internal/parser.test.yo`).

### Testing private members: sibling files and in-file tests

A `_`-prefixed member is visible only from its module and same-directory siblings (E0405 elsewhere,
`plans/reference/MEMBER_VISIBILITY.md`). Two shapes reach it, both run by `yo test <dir>`:

- **Sibling file**: `std/collections/hash-set.test.yo` beside `hash-set.yo`, importing it as its
  neighbours do (`import("./hash-set")`). The batch is written into that directory, so `set._map` is
  legal.
- **In-file**: a top-level `test("…", { … })` inside the module (recognised by a line starting with
  `test(`; a no-op for builds and `check`). The batch inlines the module's other top-level statements, so
  private helpers are visible. The batch is a COPY of the module: a module whose types the prelude
  re-exports (`String`, `ArrayList`, `Option`, …) gets a second, distinct copy of them, so test those
  with a sibling file. A module that is also a program may carry in-file tests (the batch drops its own
  `main`/`export(main)`).

Release bundles drop `std/**/*.test.yo`; in-file tests ship with their module as no-ops.

### Test shapes that silently pass

- **A drop-on-escape regression test can be hidden by DEFINITION ORDER.** The escape-drop lists compare
  source tokens (`_variable_initialized_after_cleanup_point`), so a callee (awaited wrapper, fused site)
  defined ABOVE its caller can hide the drop. Define it BELOW the caller or in another file
  (`issues/fixed/2026-11-07-a-fused-block-that-throws-drops-its-by-value-capture-twice.md`).
- **A platform-gated arm is never type-checked on other platforms.**
  `if(platform == Platform.Linux, { ... })` is folded before evaluation, so a type error in it passes
  locally and fails the WHOLE batch on Linux ("0 of N tests in this batch ran"). Force the arm on in a
  scratch copy and run it with the tree-built compiler (on macOS this proves only that it type-checks):

  ```bash
  perl -pe 's/if\(platform == Platform\.Linux, \{/if(true, {/' tests/x.test.yo > tests/zz_forced.test.yo
  ./yo-out/<target>/bin/yo test ./tests/zz_forced.test.yo --parallel 1; rm tests/zz_forced.test.yo
  ```

- **A network oracle that depends on TCP segmentation is probabilistic.** Whether two `write`s arrive as
  one `read` is the platform's choice; such a test fails on one CI leg of six and is not a flake
  (`issues/fixed/http-body-is-not-truncated-to-content-length.md`). Write the framed message AND the
  bytes after it in ONE `write_string`. One leg failing out of six is a diagnosis: check that leg's
  history before retrying:

  ```bash
  for r in $(gh run list --workflow "<name>" --limit 15 --json databaseId -q '.[].databaseId'); do
    gh api repos/<owner>/<repo>/actions/runs/$r/jobs --paginate \
      -q '.jobs[]|select(.name=="test (macos-26-intel)")|.conclusion'
  done | sort | uniq -c
  ```

- **A loopback HTTP framing test goes red only if the body cannot arrive in ONE read.**
  `std/http/wire.yo`'s `read_http_message` reads 8 KiB at a time, so for a small single-shot request the
  correct and broken framing give identical bodies
  (`issues/fixed/http-content-length-ows-and-invalid-values.md`):
  - server side: send a body larger than 8 KiB on a raw `TcpStream`; assert its length and last bytes;
  - client side: hold the connection OPEN after the response (no `Connection: close`) and give
    `fetch_with` a `with_timeout`, so a mis-parse is `HttpError.Timeout`, not a hang;
  - run the throwing `fetch` as its own `io.spawn`ed task and inspect the `JoinHandle` result: an
    `unwind` of the test body leaves the server task parked and the process never exits (rc=124).

### Partial application (`_`)

Syntax lives in `yo-syntax.instructions.md`; tests in `tests/fn.test.yo`. `_` works only on comptime
functions (return type `comptime(...)`). `generic(...)` parameters are inferred, not positional, so `_`
cannot stand for one (`F(_, a, b)` on `fn(generic(T : Type), comptime(a) : usize, comptime(b) : usize)` is
"expected 2 argument(s), got 3"); a type constructor whose type argument should stay open takes
`comptime(A) : Type`. A `_` slot typed by a generic binder keeps it: a binder the captured arguments fix is
substituted into the minted signature, and a binder only the hole names stays the minted function's own
binder, inferred from the hole arguments (`issues/fixed/2026-11-21-partial-application-through-a-generic-binder-loses-the-comptime-value.md`).
When testing one, read the result at run time (a typed local plus `assert`): `comptime_assert` on an
unknown value passes vacuously.

## Writing a test that observes a LEAK (macOS: ASan does not arm)

Local macOS ASan does not arm (next section), so an RC leak is invisible to `yo test` there and only
Linux LeakSanitizer sees it. Make the leak observable inside the language:

- **A `Drop` counter**: a module-level mutable binding (`(g_freed : i32) = i32(0);` at the top level of
  the `.test.yo`) and a `ref` struct whose `Drop` increments it. Assert the counter with a RUNTIME
  `assert` after the owning scope closes (`tests/rc.test.yo` `g_alias_disposed`, `tests/dyn.test.yo`
  `g_dyn_payload_disposed`, `tests/error.test.yo` `g_thrown_payload_disposed`). `comptime_assert`
  cannot read a runtime counter.
- **`ref_count(x)`** reads a count, also through a field or an `Rc` deref
  (`assert(ref_count(b.*) == 1, ...)`). `Rc.new(x)` builds a new cell; `ref_count` rejects a `Box`.

If neither fits and the file's ONLY failure mode is the leak verdict, put
`pragma(Pragma.NeedsLeakVerdict);` at the top: the runner then SKIPS the file, saying so, whenever no
verdict applies (`YO_TEST_LEAK_VERDICT=0`, a wasm target, `--disable-sanitize`, a non-address
`YO_TEST_SANITIZE`). Prefer the counter: a skipped test verifies nothing. The only CI leg running leak
verdicts ON is the weekly `leak-verdict.yml` (an allowlist plus a vacuity probe); dispatch it with
`gh workflow run leak-verdict.yml --ref <branch>` when touching leak plumbing.

Out-of-language measurement (extract the case to a standalone `.yo` with `main` + `export(main);`):

- **macOS `leaks`**:

  ```bash
  yo compile tmp/repro.yo --std-path ./std --optimize 2 --allocator system -o /tmp/repro.out
  leaks -atExit -- /tmp/repro.out        # "N leaks for M total leaked bytes"
  MallocStackLogging=1 leaks -atExit -- /tmp/repro.out   # + allocation stacks
  ```

- **`--allocator debug`** (no LSan and no `leaks`, e.g. Windows): the exit report lists every leaked
  block by allocation number, a run whose `main` returns with one exits 23, `yo test --allocator debug`
  fails a leaking test (unless `YO_TEST_LEAK_VERDICT=0`, passed on as `YO_DEBUG_ALLOC_VERDICT=0`), and
  `YO_DEBUG_ALLOC_TRAP=<n>` aborts at allocation `n`. A thread still running 1 s after `main` leaves the
  report unjudged.
- **`--allocator fixed --heap-size 1g --debug-heap`** prints
  `heap: peak …, N allocations, live at exit: B blocks / T bytes`.
- Put the leaking operation in a LOOP of N = 1/2/4/8 iterations (read from argv, same binary): a
  per-iteration leak grows linearly, a one-off stays flat. Run the payload-free variant as an over-drop
  canary, and re-run the fixed binary under `MallocScribble=1 MallocPreScribble=1`: recycled values in
  the output mean the fix introduced a use-after-free.
- An `unwind(...)` handler exits the function that INSTALLED it, so each loop iteration must install its
  handler in its own fn (one installed in `main` ends the run, rc=0, on the first unwind).

## Sanitizers on macOS

- The nix clang ships a mismatched ASan runtime: `yo compile --sanitize address` prints
  "AddressSanitizer is not functional with this compiler setup … Skipping sanitizer", and `yo test` runs
  every test UNSANITIZED without saying so. A use-after-free then usually passes locally.
- Apple's command-line-tools clang arms ASan (use-after-free, double free; not leaks). Put it first:

  ```bash
  PATH=/Library/Developer/CommandLineTools/usr/bin:/usr/bin:/bin:$PATH \
    yo test tests/rc.test.yo --parallel 1
  PATH=/Library/Developer/CommandLineTools/usr/bin:/usr/bin:/bin:$PATH MallocScribble=1 \
    ./repro   # built with --sanitize address --allocator system
  ```

  That `PATH` also puts bash 3.2 and BSD `sed` first: run `scripts/*.sh` with the nix `bash` by full path
  (`cli-diff-test.sh` refuses bash 3.2 with rc 2).
- A box where ASan binaries hang at startup (AMFI, `issues/retired/macos-26-asan-blocked-by-amfi.md`):
  `--disable-sanitize` skips ASan linkage; tests still check logic.

## Evaluator-only check (no codegen)

- `yo check <file-or-dir>...` runs the evaluator only over every path (the run fails when any file
  fails): much faster than `compile` for "does this still type-check?" and a bulk sanity pass
  (`yo check ./src`, `yo check ./std`) before any test.
- **`check` stdout redirected to a file is block-buffered.** A log that stops at `parsing std/prelude.yo` is not a hang: a
  seed `check ./src` takes about 35-40 min under load.
- **`check` misses codegen-enforced rules** (the hollow-`io.async`-body rule E0905): gate those with
  `yo compile src/main.yo --skip-c-compiler`.
- **Errors in `test(...)` bodies are swallowed unless `--test-bodies` is passed**
  (`src/evaluator/exprs/test.yo`). Gate an edited `*.test.yo` with `yo check <file> --test-bodies`
  (its trial has known false positives: it takes a different generic-inference path than the real batch).
  A tree-wide sweep or oracle that runs `check` over test files needs `--test-bodies` too, one file per
  call: without it, every site inside a `test(...)` body is skipped.

### The incremental loop: `check --watch`, `build --watch`, chunks, in-process tests

Plan: `plans/reference/INCREMENTAL_COMPILATION_ZIG_LESSONS.md`.

**`yo check <dir> --watch`** keeps one resident checker: one cold pass (~100 s for `./src`), then it polls
(`--poll-ms`, default 200) and prints one line per round
(`watch: revalidated 2 definition(s), rechecked 142 file(s), 0 failed (47158ms)`).

- A **fn-literal body or signature edit** (`name :: (fn(...) -> T)(body)`) re-forces that definition
  and its dependents and re-points importers that destructured it: a comment-only round takes ms, one
  leaf body ~80 ms.
- **Everything else falls back to file level** (a new or removed definition, a struct/enum/trait, a
  constant, an ordered statement): the file's reverse-import closure is re-checked.
- A body whose readers destructure a re-forced name (a hub like `src/token.yo`'s
  `is_identifier_continue`, read by `src/lexer.yo`'s `tokenize`) still re-checks those readers'
  closures: about half a cold pass.
- `YO_DEBUG_P3DIFF=1` explains a round on stderr (`[p3diff]`, `[p3rebind]`, `[p3round]` lines); read it
  before calling a slow round a bug.
- **A stale verdict IS a bug**: the oracle is `scripts/bootstrap/watch_verify.sh` (live session vs cold
  check). File it with the edit sequence and add the shape to `tests/internal/check-watch.test.yo`.
- `--watch-once` reads changed paths from stdin: one round, exit code = failures.
- **An owner purge in `mm_invalidate_document` must cover every cache that can hand back what it drops.**
  `check`, `check --watch` and `yo lsp` never run codegen after an invalidation, so only a
  `build --watch` round catches a stale cache: smoke a new purge with a two-module `yo build --watch`
  project (edit the import, break it, revert it, run the binary each round;
  `issues/fixed/build-watch-reuses-a-stale-imported-module.md`).
- RSS grows across a long session; restart it when the machine gets tight.

**`yo build --watch`** invalidates the changed files (`invalidate_changed_files`) and recompiles
artifacts in-process against the warm module cache (the `cc` leg stays a child; the artifact stamp still
decides what compiles). `--profile` prints `profile: watch round N <ms> rss=…MB` (round 1 is the cold
baseline); `--max-rss-mb N` re-execs at a round boundary above N MB.

**Chunked C emission** (`yo compile src/main.yo --emit-chunks auto --jobs 8 --profile`; also
`--chunk-by module`, `--no-chunk-lto`) splits the C into translation units behind a per-unit `.o` cache
(`<obj>.inputs-sha256`; `YO_BUILD_NO_CACHE=1` disables it) and reports
`chunks: 10 unit(s), 7 cached, 3 to compile (jobs=8)`. The C leg is the small part of a self-build;
the evaluator dominates. Fids embed source positions, so an INSERTION above a definition dirties every
caller's unit below it; a body-only edit dirties one unit. `--chunk-by module` keeps a module in one unit.

**`YO_TEST_IN_PROCESS=1`** compiles every batch of a `yo test` run in one resident evaluator (about half
the wall time). Opt-in and never CI: one `tests/internal` file already exceeds 4 GB, so the default
valve (`YO_TEST_MAX_RSS_MB=4096`, an execve restart at the next file boundary) degenerates into a
restart per file. Use it one file at a time:

```bash
YO_TEST_IN_PROCESS=1 YO_TEST_MAX_RSS_MB=12000 yo test ./tests/internal/<file>.test.yo --parallel 1
```

The hollow-batch check stays mandatory: an in-process regression presents as hollow batches.

**`YO_TEST_FORK=N`** (Linux, macOS) runs the first file in process, then forks one copy-on-write worker
per later file, at most N at a time; output, totals and exit code are the sequential runner's. Shared
pages are charged as they are written (summed PSS reached ~14 GB at N = 4 on `tests/internal`): take a
heavy slot only with that memory free.

### `check` + `build` both green is NOT proof for a tree-wide rename

Call sites structurally invisible to `check` and `build`:

| invisible in | why |
| --- | --- |
| macro `quote(...)` bodies | not evaluated until expansion |
| generic trait-impl bodies | `check` never instantiates them (`FromIterator.from_iter_add`) |
| generic helpers in the defining module | same |
| an `io.async` body inside a GENERIC fn whose `io` is a type variable | checked only at specialization |

The gate for a rename sweep is the full suite plus READING the cli-case golden diff. A golden that gets
SMALLER or reports FEWER findings (`Scanned 1 .yo file(s)` → `Scanned 0`) is a regression signal. Grep
`quote(`, `impl(` and `io.async(` bodies yourself
(`issues/fixed/ftt-stub-in-live-closure-falls-off-non-void-function.md`).

### Comparing emitted C, and "no behaviour change" refactors

- **Byte-identity of emitted C does not survive a `std/` source edit.** Generated identifiers embed
  anonymous type ids (`__yo_tN`) and a global counter (`yo_id_N`, `struct_decl_N`, `enum_decl_N`,
  `loop_yo_id_N`): adding declarations anywhere in `std/` shifts every later counter and permutes the
  `__yo_tN` numbering. For an additive codegen change compare normalized, sorted C instead:

  ```bash
  norm() { sed -E 's/__yo_t[0-9]+/__yo_tT/g; s/__YO_T[0-9]+/__YO_TT/g;
                   s/yo_id_[0-9]+/yo_id_N/g; s/(struct_decl|enum_decl|decl)_[0-9]+/\1_N/g;
                   s/_temp_[0-9]+/_temp_N/g' "$1"; }
  diff <(norm before.c | sort) <(norm after.c | sort)          # must be EMPTY
  diff <(grep -oE '__yo_[A-Za-z0-9_]+\(' before.c | sort -u) \
       <(grep -oE '__yo_[A-Za-z0-9_]+\(' after.c  | sort -u)  # must be EMPTY
  grep -c '<the new API you added>' after.c                    # must be 0 if unused
  ```

- **Emit-diffs must pin `YO_STD`**: minted ids incorporate the std tree's absolute path, so compile both
  sides with the same `YO_STD=<abs>/std`.
- **A refactor of the compiler's own data is gated by a compiler swap, not an emit-diff of two trees.**
  Build stage-1 of the merge base and of the branch, compile the BRANCH tree's `src/main.yo` with both in
  one directory (the fixpoint's stage-2 command line) and `cmp` the C: two compilers on one tree differ
  only when behaviour did.
- **A "no behaviour change" REWRITE of function bodies is gated on program OUTPUT**, not on C:

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

  For a pure rename, also compare the old body (`git show HEAD:<file>`) with the new one character for
  character. If the refactor exists to survive a future change, apply that change in a throwaway edit:
  the new tests must pass with the refactor and FAIL with the pre-refactor file.

## WASM testing

- Emscripten: `yo test ./tests/x.test.yo --cc emcc` (auto-targets `wasm32-unknown-emscripten`). The runner
  selects tests by the `YO_TEST_INDEX` environment variable, which emcc 4.0.12's node glue does not
  forward ("YO_TEST_INDEX is not set"): use CI's emsdk for an emcc verdict, or compile the case as a
  program (`yo compile x.yo --c-compiler emcc -o x.js && node x.js`). A threaded program links with
  `-sPROXY_TO_PTHREAD` (`main` runs on a pthread).
- Standalone WASI: `yo test ./tests/x.test.yo --target wasm32-wasip1` (runs via `wasmtime`).
- Skip a file with `pragma(Pragma.SkipWasm32Emscripten);`, `pragma(Pragma.SkipWasm32Wasi);` (e.g. files
  that spawn subprocesses) or `pragma(Pragma.SkipWasm);` (all WASM), within the first 50 lines. Pragmas
  are checked against the `Pragma` enum in `std/prelude.yo`. Per test:
  `{ arch, Arch } :: import("std/process");` and `if((arch == Arch.Wasm32), return())` at the top of the
  body.
- Errno values differ on WASI: use `std/libc/errno` constants, never numbers. `process.platform` is
  `"emscripten"` or `"wasi"`.
- New tests must pass on native, `--cc emcc` and `--target wasm32-wasip1`, or carry a skip pragma.
  Limitations and skipped tests: `plans/reference/WASM_SUPPORT.md`.
- **`usize` is 32 bits on wasm32**, the only such target, so a hardcoded bit position, shift amount or
  `1 << k` boundary passes the whole native suite (a shift equal to the operand width is UB). Derive
  widths:

  ```yo
  sh := usize(1);
  while(sh < (size_of(usize) * usize(8)), {
    c = (c | (c >> sh));
    sh = (sh * usize(2));
  });
  ```

  and in tests derive the boundary the same way (`bits :: (size_of(usize) * usize(8))`, then
  `usize(1) << (bits - usize(3))`), never `usize(1) << usize(61)`.
- **For anything touching sizes, capacities or bit math, run the wasm leg locally**, one file at a time
  with a timeout so a hang (rc=124) is a verdict (~15 min for the corpus):

  ```bash
  for f in $(find tests -name '*.test.yo' -not -path 'tests/internal/*' -not -path 'tests/cli-cases/*' | sort); do
    YO_STD=$PWD/std timeout 240 "$BIN" test "./$f" --parallel 1 --target wasm32-wasip1 &> "logs/$(echo $f | tr / _).log"
    echo -e "$?\t$f"
  done
  ```

## Verifier tests

Verify `tests/spec` PER PATH: `yo verify ./tests/spec` as one directory exits 1 with no JSON, because
`fixtures/negative` and `fixtures/invalid` hold inputs that fail evaluation by design.

```bash
for p in tests/spec/*.test.yo tests/spec/fixtures/valid tests/spec/fixtures/elision; do yo verify ./$p --format json; done
```

Every fixture of `tests/spec/fixtures/valid/` must prove the same set of functions under
`Pragma.Verify` and `Pragma.VerifyOrAssert`. The FV job's harness leg runs the sweep with stage 1; a
divergence fails unless `tests/spec/verify-both-modes-known.tsv` names its open issue:

```bash
python3 -I scripts/verify-both-modes.py --bin yo-out/x86_64-unknown-linux-gnu/bin/yo --std-path ./std
```

## Decision 43's origins corpus: `tests/origins/` is not run by `yo test`

`tests/origins/corpus/<id>.yo` is decision 43's corpus (`plans/backlog/REFERENCES_AND_ORIGINS.md` §8):
plain `.yo` programs in origin syntax, never `.test.yo`. CI runs all of the gates below in `test.yml`'s
`origins-corpus` job unless noted.

```bash
YO=yo-out/x86_64-unknown-linux-gnu/bin/yo bash scripts/origins-corpus.sh today   # the N0 gate, minutes
PHASES=N1 YO=... bash scripts/origins-corpus.sh target                           # a later phase's gate
```

- `tests/origins/corpus.tsv` is the manifest (anchor, kind, phase, expected verdict, and what `yo check`
  does `today`: first error code and text). `today` fails when a row's first error changes: decide
  progress or regression, then re-record the row.
- `tests/origins/model-corpus.test.yo` IS in the fast suite: it runs every row through the reference
  checker `tests/origins/model.yo`. A new row needs the fixture, the manifest row and a
  `verdict("<id>", …, "<expect>");` call; the script cross-checks all three.
- `tests/origins/unsound/` (G-B, `plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §6): each program has a
  `// expect: E09xx` or `// expect: accept` header, and a negative's positive twin is `<id>-pos.yo`. Gate:
  `YO=<binary> bash scripts/origins-unsound.sh` inside the nix shell (clang on `PATH`). A negative that
  passes `check` is compiled under ASan and run; every positive twin must run ASan-clean. `SHARD=i/n` runs
  one stripe of the byte-sorted program list (CI runs four).
- **A change to what `check` accepts gates the whole corpus with the binary built from its final head.**
  A sweep or delta gate that runs only the programs each merge changed, or that runs an older binary,
  misses a program that reached develop in between: that is how a G-B row broke develop after VERDICTS-73
  F2 (#2136). Re-run `origins-corpus.sh today`, `origins-unsound.sh` and `model-corpus` over every program
  after the last develop merge.
- G-D, the generator: `YO=<binary> python3 -I scripts/origins-gen.py` renders borrow programs (families
  `slot`, `args`, `valpos`, `join`) plus rustc twins and minimizes each use-after-free or rustc
  disagreement into `tests/origins/gen-findings/`. `YO_GEN_SEED=<n>` replays, `--sig <signature>` runs
  one program, `--verify-known` reports which `tests/origins/gen-known.tsv` rows still reproduce (delete
  the row in the PR that fixes it). Needs clang (nix shell), optionally `rustc`. Nightly in
  `origins-generator.yml`; not a `merge-gate` need.
- G-C, the rustc differential: `bash scripts/origins-diff-rustc.sh` compares rustc's verdict on every
  twin in `tests/origins/rust/` with the recorded Yo verdict (`LIVE=1 YO=<binary>` runs `yo check`
  instead). Every divergence is a `tests/origins/rust/DIVERGENCES.tsv` row (`design`, `parity`,
  `polonius` or `hole`); an unexplained one, or a listed one that no longer diverges, fails. A new corpus
  row with a Rust analogue gets its twin in the same PR. CI: `origins-rustc-diff.yml`.
- G-E, `scripts/check-origin-sinks.sh`: without arguments a grep gate (`local_borrow_register` only from
  its listed binding sites, the conflict check only from `local_borrow_access`, every lowering of the
  plan's §5 table calls its sink; a new lowering adds a `LOWERINGS` line). `--totality` with
  `YO=<binary>` runs `YO_AUDIT_ORIGIN_TOTALITY=1 yo check` over `./src`, `./std`, the corpus and the
  reference tests: the `[origin-totality]` count (`sink`, `untyped`, `depth`) must be 0, and every target
  but the corpus must check cleanly. `./src` needs `yo install` first on a fresh clone.

## CLI cases (`tests/cli-cases/`)

`scripts/cli-diff-test.sh` runs each case in a sandbox and compares rc, stdout and trees; `--record`
writes goldens. Always read each GOLDEN-DIFF before `--record`, and record with a binary built from the
SAME tree (one built before a merge silently drops the other side's changes).
`--shard I/N` scores every N-th case of the sorted list (CI's `cli-cases` job runs three stripes;
`gates_fast.sh` GATE 7 runs them all locally unless `T1_SKIP_CLI=1`).

- **`yo fmt` a fixture BEFORE recording.** CI's fmt check scans every fixture `.yo`, and the fixture's
  hash is part of `expected_tree`. Order: `yo fmt` the fixture, `--record <case>`, re-score without
  `--record`. Check with the tree-built binary (GATE 6), not the installed seed:
  `yo-out/<target>/bin/yo fmt --check ./src ./std ./tests`.
- **A `cmd` (and `expected_rc`) file needs a trailing newline**, or `read` drops the last line and
  NOTHING runs; `--record` then reports
  `NO-GOLDEN <case> (stdout_keep_match matched nothing — vacuous)`. Write it with
  `printf 'build run\n'`. To tell this from a wrong pattern: `--keep`, then
  `ls -la <kept sandbox>/run/stdout.raw` (0 bytes = never ran).
- **A bare-repository fixture needs a tracked `refs/.keep`.** After `git gc`/`pack-refs` its `refs/` is
  empty, git does not track empty directories, and a fresh checkout fails with
  `fatal: './remote.git' does not appear to be a git repository`. Re-record afterwards and verify from a
  clean worktree.
- **A LEXER-level error cannot live in a fixture** (`yo fmt` must lex it). Put it in
  `tests/internal/lexer.test.yo`, which calls `tokenize` with an `Exception` handler that asserts the
  message and `unwind`s, then `assert(false, "expected a lexer error")`. Write the source as a Yo string
  with the backslash DOUBLED (`String.from("s :: \"\\uZZZZ\";")`), not a backtick template.
- **A PARSE-level error may live in a fixture only if the fixture is already fmt-canonical**: `yo fmt`
  refuses to rewrite unparseable source and exits 1 when its output would differ
  (`tests/cli-cases/fix-says-what-it-cannot-repair/fixture/main.yo` is canonical). A parse-refusal unit
  test belongs in `tests/internal/formatter.test.yo` (`format_yo_source`).
- **Goldens that move with unrelated edits:**
  - `lsp-member-definition` records absolute line numbers in `std/collections/array-list.yo`: adding or
    removing lines above `ArrayList`, `ArrayList.new` or `ArrayList.push` moves them. Re-record
    (`YO_SELF_BIN=<stage-1> bash scripts/cli-diff-test.sh --record lsp-member-definition`) and check that
    only line numbers changed.
  - `explain-list` embeds every diagnostic summary from `src/diagnostics-registry.yo`: rewording one
    needs `--record explain-list`.
  - The `init*`, `build-stamp-dotted-dir` and `build-depfile-scoped-stamp` trees hash only the files
    `src/init.yo` generates; they move only with its templates.

## Yo source also lives INSIDE scripts and workflows — GATE 8 checks it

`yo check`, the language suite and a tree-wide migration see none of these:

- the verification hello world in `scripts/install.sh` and `scripts/install.ps1`;
- the post-install smokes in `.github/workflows/install-scripts.yml` (POSIX and Windows);
- the bundle smokes in `.github/workflows/release.yml`;
- the recursion probe in `scripts/bootstrap/probe-stack-sizing.sh`.

Their own workflows are path-filtered or release-only, so a removed language form would break the
installer for users (`issues/fixed/installer-verification-snippet-is-outside-every-per-pr-gate.md`).
`scripts/check-embedded-yo.sh <path-to-yo>` extracts, compiles and runs each and compares its stdout; it
is GATE 8 of `gates_fast.sh`. **A language sweep must grep scripts and workflows too.**
`scripts/build-site.yo` is Yo outside the checked directories as well: `test.yml`'s `docs-site` job
compiles it (with stage-1, or the seed on a docs-only change). Sweep it by hand.

## Bootstrap fixpoint

```bash
cp yo-out/<target>/bin/yo /tmp/yo-s1
S1=/tmp/yo-s1 P=local bash scripts/bootstrap/fixpoint_only.sh
```

- **Stage-1 must live OUTSIDE the repo.** Type keys embed each module's path spelling; a stage-1 inside
  the repo exe-walks-up to absolute std paths while the script's stage-2 uses relative `./std`, so the
  hash-bucket order differs and the verdict is a spurious `FIXPOINT_BROKEN`.
- **Stage-1 must come from the SAME tree it compiles.** The script compiles the tree as it is when it
  runs: an edit after building stage-1 makes the two stages different generations (a one-line std import
  gave 1.1 M differing lines with every step green). Do not edit the worktree during the run.
- **Read the diff before believing the verdict.** Uniform type-id renumbering (`__yo_t796` →
  `__yo_t614`) is generation skew, a different count of instantiations; a real break shows localized,
  structural differences.
- `fixpoint_only.sh` and `chunked_gate.sh` score stage-2 with `scripts/count-transpile-failures.sh` and
  the fixpoint GATES on it (see "Counting untranspiled bodies" below).

## What CI runs where

Plan and measurements: `plans/CI_ONE_HOUR.md`.

- **`test.yml`** (every PR to develop and every develop push; `merge-gate`) is the core battery: one seed
  build of stage 1 (`stage1`), the stage-2 `suite-candidate` built from it, and everything Linux x86_64.
  wasm/wasi, the chunked gate, the self-hosted jobs and the ubuntu suite reuse those two binaries instead
  of rebuilding them.
- **`native.yml`** (every develop push; `native-gate`) runs the macOS, Windows and Linux arm64 legs. Its
  cross-emits use the seed-built stage 1, the route release.yml ships. PRs do not run it: a change to a
  platform runtime (`src/codegen/async/runtime-io-*.yo`, Windows or macOS std paths) dispatches it on
  its branch with `gh workflow run native.yml --ref <branch>` before merging.
- A release needs both workflows green on the exact tip (release.yml checks both).
- **The compiler build cache** (`.github/actions/compiler-cache-key`, `stage1-cached`): stage 1,
  stage 2 and the cross-emitted C are restored when `src/`, `std/`, `build.yo`, `yo.toml`, `yo.lock`,
  `vendor/`, the seed, the runner image, clang and the recipe file are all unchanged. A suspected stale
  entry: set the repository variable `YO_CI_NO_BUILD_CACHE=1` and re-run.
- Striping knobs the jobs use, all defaulting to the whole set locally: `yo test --shard i/n`,
  `scripts/test-name-shard.sh`, `SHARD=i/n` for `scripts/origins-unsound.sh` and
  `scripts/bootstrap/hollow_sweep69.sh`, `cli-diff-test.sh --shard I/N`,
  `SIDE=single|chunked|compare` for `scripts/bootstrap/chunked_gate.sh`.

## Choosing a Tier 1 gate: select by what the diff touches

Tier 1 (AGENTS.md, "Gating is three-tier") is targeted at the diff; develop's battery runs everything.
Picking every `tests/internal` file costs hours (each re-evaluates the compiler, 4–7 min, even for two
tests), and passing many files to one `yo test` call fails in 0 s.

- **Always:** `yo build --std-path ./std` (when `src/` changed), `check ./src` and `check ./std` (each with
  `--std-path ./std`), `yo fmt --check` on the changed `.yo` files with the tree binary,
  `bash scripts/check-issue-refs.sh`. About 15 min.
- **A tree-binary `check ./src` when the `src/` diff touches rules the tree enforces more strictly than
  the seed** (capture lists, borrow and reference spellings `&x`/`&mut x`/`.*`, a recently tightened
  rule): the seed's `check ./src` and `yo build` only prove the SEED accepts the tree, while the
  fixpoint and every `tests/internal` file compile `src/` with the tree binary. Run
  `YO_MAIN_STACK_MB=4096 yo-out/<target>/bin/yo check ./src --std-path ./std`. (Example: `{ &env }` over a
  `&T` parameter passed the seed; the tree rejects it with E0926, fix `{ env : &env.* }`.)
- **`check` swallows `test(...)` body errors**, so a `src/` change to a type the `tests/internal` files
  construct or copy (a record turned from a shared handle into a value, a retyped field) shows only when
  `yo test` compiles each file. Cheaper sweep: generate each file in the shape `yo test` compiles (its
  non-test lines, then a `main` whose arms hold the test bodies), named `*.yo_selftest_batch_*.yo` so the
  test-file exemptions (E0611 `unwrap`) apply, in a sibling directory at the same depth as
  `tests/internal` so `../../src` imports resolve, and run one `check` over that directory (~40 min for
  all files).
- **Feature tests: grep for what changed.** The `tests/**/*.test.yo` files (minus `tests/internal` and
  `tests/cli-cases`) naming a changed identifier, plus the feature's own tests, one file per call:

  ```bash
  for f in $(cat feature-tests.txt); do yo test "$f" --parallel 1 > "log/$(basename $f).log" 2>&1; echo "$f rc=$?" >> log/feature.log; done
  ```

- **`tests/internal`: select by direct import or by a name the file uses**, not by "the prelude
  changed":
  - include a file that imports (`../../src/...`) a changed `src/` module, or whose source names a changed
    identifier (`grep -lw`);
  - a `std/`- or prelude-only change selects no file by import: add `compile.test.yo` as the
    self-compile smoke, plus any grep hit;
  - cap the selection at ~8 files, one per call; leave the rest to develop's battery and say so under
    Deferred. **Never run the whole `tests/internal` directory locally** (branch gates, reviews and
    regenerations alike, in-process or serial): it takes hours and concurrent runs collide on shared
    `/tmp` fixtures, producing false watch and module_invalidation failures.
- **cli-diff** only when the diff can move CLI output: std (line-pinned LSP goldens), diagnostics prose, a
  CLI command, `yo init` templates, a `yo fix` migration.
- **A change that alters what parses or type-checks outside `src/`/`std/` (a Generation A sweeping
  `tests/`) escapes the migration and a tree-binary Tier 1 in three places**
  (`issues/fixed/2026-10-18-the-fv-job-runs-generation-a-test-files-with-the-seed.md`):
  1. `yo test` steps a SEED runs: grep `.github/workflows/` and run those files with the seed;
  2. Yo inside workflow `run:` blocks and shell here-documents: run `scripts/check-embedded-yo.sh` and
     check each probe with the tree binary;
  3. programs in test string literals, compiled by a `yo` subprocess: put the tree binary first on `PATH`
     as `yo` (locally `yo` is the seed).
- **Split weights:** the gate is one weight-1 `heavy_take`; anything timed or above ~5 GB is a separate
  `exclusive` job queued after it.

A typical gate is 30–45 min. What it leaves out is develop's battery's job; a red develop job is fixed
forward.

## The heavy lock: one machine, several sessions

Two compiler-sized jobs starting together can swap each other into the runner's 600 s deadline, so every
heavy step goes through `scripts/heavy-lock.sh`, a FIFO lock under `~/Workspace/Yo-wt` (override with
`HEAVY_ROOT`, shared by every session on the machine):

```bash
source scripts/heavy-lock.sh
trap heavy_drop EXIT
heavy_take "<who>: build + check src"        # shares the machine (default 3 slots)
yo build --std-path ./std && yo check ./src --std-path ./std
heavy_drop
heavy_take "<who>: check-time A/B" exclusive  # runs alone
```

- **Heavy:** `yo build`, `check ./src`, `compile src/main.yo`, the language suite, any `tests/internal`
  file, the fixpoint. **Light, no lock:** small single test files, `fmt`, `check` of one small module.
- **Take `exclusive`** for anything timed (a timing or A/B) and, on a machine with little headroom, for
  steps past ~5 GB (a compiler-sized `tests/internal` file reaches ~6.5 GB). Only the `exclusive` argument
  makes a job exclusive; the label is free text. On a large box, memory-heavy runs
  (`YO_TEST_IN_PROCESS=1`, a compiler-sized file) take an ordinary slot: the admission check covers them.
- **Size the slots per machine in `~/Workspace/Yo-wt/heavy-lock.conf`**, never per session:
  `HEAVY_SLOTS=N` (1–26, default 3) and `HEAVY_MIN_AVAIL_MB=M` (default 6144, checked only when a job is
  admitted beside another, so it cannot catch a job that grows later). Waiters re-read it every poll and
  it wins over the environment. Budget ~4 GB per Tier 1 gate on top of the OS and sessions.
  `bash scripts/heavy-lock-test.sh` (~1 min) checks a change to the script.
- **Never hold a slot while idle.** A gate is one script with no waits inside; `trap heavy_drop EXIT`
  releases the slot on failure.
- **Take the slot in the process that outlives the job.** The owner line records `$$`, which in a
  `( … ) &` subshell is the PARENT's pid: if that returns at once, the next waiter reclaims the slot while
  the job runs. Put the gate in a script and start that (`nohup bash gate.sh &`).
- **Never backdate a ticket** (overriding `_heavy_now_ns`): an `exclusive` waiter claims slots only while
  oldest, so a backdated ticket deadlocks the queue. A restarted job queues at the tail.
- **`priority` is the one sanctioned queue jump, for release blockers only**:
  `heavy_take "<who>: <job>" priority` or `HEAVY_PRIORITY=1`; combines with `exclusive`. It sorts ahead
  of every ordinary ticket (FIFO among priority tickets), never preempts a running job, and never
  overtakes a queued `exclusive` ticket. The order is carried by the ticket NAME, but the code lives
  only in the copy that takes the ticket: from an older worktree source
  `git -C ~/Workspace/Yo show origin/develop:scripts/heavy-lock.sh`. Its owner line ends in `[PRIORITY]`.
- `cat ~/Workspace/Yo-wt/.heavy-lock*/owner` shows holders, `~/Workspace/Yo-wt/.heavy-queue/` the
  waiters (oldest first). A stopped holder (`ps -o stat=` shows `T`) blocks everyone: `kill -CONT` it.
- Killing a waiter or holder is safe: a dead waiter's ticket is pruned, and a slot whose owner pid is
  gone, or taken before the last boot, is reclaimed by the next waiter's scan.
- **Stop a `yo build` by its process group, not its pid**: killing the runner leaves its `yo compile`
  child writing the same `yo-out` outside any slot. Start the wrapper with `setsid` and
  `kill -- -<pgid>`; before restarting, check `pgrep -af "yo compile"`.

## Compiler internal tests — `tests/internal/`

The compiler's own tests (older docs: `yo-self/tests/`). They import `src/` via `../../src/...`, so every
file reaching `evaluator/index.yo` pays a compiler-sized compile.

```bash
yo test ./tests/internal/parser.test.yo --parallel 1
```

- **One file at a time, never the whole directory locally** (see "Choosing a Tier 1 gate"): one file
  peaks at ~6.5 GB, and two concurrent children swap into the runner's 600 s deadline, manufacturing
  failures. The runner ignores `--parallel` (it runs sequentially). CI runs the directory in the sharded
  `compiler-internal-tests-selfhosted` job; the fast suite and the wasm/emcc jobs exclude it.
- Run the relevant files whenever you modify `src/` or these tests.
- **Two settings separate a verdict from noise:** `YO_TEST_LEAK_VERDICT=0` (CI sets it; the in-process
  module evaluation leaks process-lifetime registries, `issues/self-hosted-emit-leaks-remaining-classes.md`,
  so e.g. every `check-watch.test.yo` test otherwise fails as `Memory leak detected:`; ASan crash
  detection stays armed), and `--compile-timeout-ms 2400000` on a busy machine (the default 600 s
  deadline fails the batch with `Yo compilation exceeded the configured time limit`).
- Build-system and CLI subsystems are tested here too (`build-runner`, `lock-file`, `resolver`,
  `manifest`, `toml-edit`, `target`, `fetch`, `install-command`, `cache`, `init`, `version`
  `.test.yo`); end-to-end CLI behaviour is in `tests/cli-cases/`.
- **Stack:** every emitted binary runs `main` on a worker thread with a 1 GiB stack (`__yo_main_stack`;
  `YO_MAIN_STACK_MB` overrides; a no-op on WASM). Big evaluator frames (`evaluate_match`,
  `evaluate_function_call`) are several MB at `-O0` and larger under ASan, so keep recursive comptime
  test inputs small (`fib(1)`, `countdown(1)`). `ASAN_OPTIONS=stack_size=N` sets the fake stack, not the
  real one.

### A hollow batch voids EVERY test in it, not one

The runner inlines all test bodies of a batch into one `__yo_user_main` (a `match` on `YO_TEST_INDEX`,
synthesized in `src/main.yo`). One expression codegen cannot transpile turns the whole function into a
`// Failed to transpile` comment: the binary runs nothing and every test in the batch "passes". The
`__yo_user_main` marker gate in `src/codegen/functions/generation.yo` makes this a hard error. **Never
weaken that gate to get a job green.** Debugging one:

- `YO_KEEP_BATCH=1` keeps `.yo_selftest_batch_<pid>_<fi>_<bi>.yo`; compile it directly to iterate.
- To read the marker text you need a pre-gate binary (with the gate, the compile aborts before writing C).
- Batch bodies are `ast_expr_to_string()` re-prints, not source slices: rule out a round-trip defect by
  testing the natural source form too.

### Counting untranspiled bodies: never anchor to start-of-line

Use `scripts/count-transpile-failures.sh <emitted.c>`; a hand-rolled `grep` is wrong both ways:

- **Overcount:** codegen spells its own markers as string literals, so stage-2 carries a nonzero
  string-literal floor that moves with codegen.
- **Undercount:** markers also appear mid-line (`return // Failed to transpile <expr>;`,
  `__yo_tN tmp = // Failed to transpile <expr>;`); `^\s*//` misses them.
- **Abort stubs:** an untranspilable body in a value-returning function becomes
  `abort(); /* untranspilable body in a value-returning fn: ... */` with no marker, and dies rc=134 at
  runtime. The script prints `N real (F string-literal floor, S abort-stub)`: **`0 real` alone is not
  clean; read the stub count**, and for an async change run the binary.
- A missing file exits 2 with `MISSING FILE`: check that first when a gate reports a suspiciously clean
  number.

The discriminator (shared with codegen's abort-stub detector): a string-literal occurrence is preceded by
`"`, an emitted marker never is. A stage-2 carrying an untranspiled body is broken even when
stage2 == stage3 byte-for-byte.

## Formatting

`yo fmt` is the only formatter (`vscode-extension/` keeps its own npm toolchain). Run `yo fmt <file>` on
every `.yo` file you create or modify; `yo fmt --check <file>` verifies. Gate with the tree-built binary
(GATE 6), not the seed: the formatter changes between releases.

## Linux async-backend testing (`YO_IO_BACKEND`)

- The Linux runtime picks io_uring, else epoll (one stderr line), else degraded
  (`plans/reference/DROP_LIBURING.md`). `YO_IO_BACKEND=uring|epoll|auto` pins it; a pinned backend that
  fails to initialize is a hard error.
- When touching `src/codegen/async/runtime-io-linux.yo` or the timer section of `runtime-io-common.yo`,
  run the async/io/net tests under BOTH backends:
  `YO_IO_BACKEND=epoll yo test ./tests/async-await.test.yo --parallel 1`, and again without the variable.
- `tests/internal/uring-runtime.test.yo` pins the emitted Linux and macOS runtime text (call the emitters,
  assert on the C, like `gc-runtime-atomics.test.yo`). An emit-diff of the runtime must pin `YO_STD` (see
  "Comparing emitted C"); all hunks must then sit between `Platform-specific sync helpers (Linux)` and
  `__yo_main_thread_entry`.
- Performance: `scripts/io-budget-check.sh` is the hard gate (syscall counts);
  `scripts/bench-io-backends.sh` and `scripts/bench-vs-libuv.sh` (needs libuv headers;
  `LIBUV_CFLAGS`/`LIBUV_LIBS` without pkg-config) are informational. Take medians (`REPS=7`) on a shared
  box. On WSL2 loopback TCP costs ~300 µs per round trip for every runtime: socketpair rows measure the
  runtime, TCP rows the kernel.
- Async lowering cost: `YO=$(which yo) YO_STD=$PWD/std bash scripts/bench-async-chain.sh` prints user-space
  instructions per iteration (perf, else callgrind) for a two-await await chain, `select`, `timeout`,
  spawn + join and a channel round trip (`scripts/bench/async-chain.yo`, `BENCH_MODE`/`BENCH_COUNT`). A
  count, so it is stable on a shared box; the plan's baseline table is `plans/backlog/ALLOCATION_FREE_ASYNC.md` §5.
- Nothing in the Linux pipeline links liburing (the ring layer is vendored).

## macOS async-runtime testing and prototyping

- **Prototype runtime changes without a self-build.** Emit a program's C with any current `yo`
  (`yo compile x.yo --emit-c --skip-c-compiler -o out`), replace the macOS runtime regions (from
  `Async I/O Runtime (macOS - kqueue)`, the macOS timer section, and `FS Event Operations` to the end of
  `__yo_poll_and_fs_event_tick`) with your edited C, and compile with the flags `yo compile` uses. A
  `clang` wrapper first on `PATH` that performs the same splice runs whole test files through the
  prototype (`yo test <file> --cc clang`). Port to the `.yo` emitters once measured and green: in the Yo
  template string every C backslash is doubled (`\\n`), and there is no backtick or `${`.
- **Benchmarks** (informational): `scripts/bench/io-bench.yo` and
  `scripts/bench/async-vs-libuv/io_bench_uv.c` (runtime level), `bench.yo` and `bench_uv.c` (std level).
  `brew install libuv`, then build the C twin with
  `-I$(brew --prefix libuv)/include -L$(brew --prefix libuv)/lib -luv`. Alternate binaries per round and
  take medians.
- **Measurement pitfalls:** `sample <pid>` is wall-clock (a thread blocked in `kevent` shows as `kevent`);
  split user and system time with `/usr/bin/time -l`. A `DYLD_INSERT_LIBRARIES` interposer counts libc
  wrappers (`send`/`recv` go through `sendto`/`recvfrom`). A kqueue is locked to the first API family:
  mixing `kevent` and `kevent64` fails with `EINVAL` and "measures" as 0.1 µs. Timer wakeups are coalesced
  (a 1 ms `kevent()` timeout wakes after ~1.25 ms, a default-leeway `EVFILT_TIMER` after ~1.5 ms; only
  `NOTE_CRITICAL` changes it). A level-triggered knote left enabled with no waiter busy-spins, "halving"
  ping-pong latency at 100% CPU: check CPU time before believing a latency win.
