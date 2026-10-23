# Two compiles of one output share the code spill file, and one writes C without the runtime

**Severity:** S1: when two compiles of one output overlap, the one that finishes second writes C without its runtime and fails in the C compiler on `__yo_borrow_assert_unborrowed` (the failure seen twice), while the one that finishes first splices a file the other has been rewriting. If the two compile different sources whose differences keep the C's length, that first compile's C mixes both versions, compiles, and its binary stays at the output path with rc=0. That case was never observed or constructed; see "Could it compile?".

**Status: FIXED (2026-10-23, see `## Fix`).**

## Symptom

Seen twice on the shared 64 GB box while other agents' builds were running:
with the installed seed v0.2.67 at 2026-10-22 02:39Z and with v0.2.68 at
2026-10-22 17:21Z (2026-10-23 local time, +0800).
Both seeds carry the code below unchanged. The command was
`yo build --std-path ./std` in a worktree. The C compile failed, and a re-run
a few minutes later passed:

```
Building yo v0.2.68-17-g861351670 → yo-out/x86_64-unknown-linux-gnu/bin/yo
Using bundled mimalloc
...
yo-out/x86_64-unknown-linux-gnu/bin/yo.c:64185:3: error: call to undeclared function '__yo_borrow_assert_unborrowed'; ISO C99 and later do not support implicit function declarations [-Wimplicit-function-declaration]
 64185 |   __yo_borrow_assert_unborrowed((void*)(*__yo_v_self));
...
20 errors generated.
yo: error: compile: C compiler failed (exit 1) on yo-out/x86_64-unknown-linux-gnu/bin/yo.c
Compilation error: Compilation failed (exit 1)
Skipping install: a step it depends on failed
```

Logs: `~/Workspace/Yo-wt/vbd-logs/async-alias/build1.log` (2026-10-22,
commit 582b1d0a4) and `~/Workspace/Yo-wt/vbd-logs/pr1541/r2_build_fail1.log`
(2026-10-22 UTC, 2026-10-23 local, commit 861351670). The 20 errors sit at the same relative
offsets in both logs (64099/64137/64305/… against 64185/64223/64391/…).

One reading of the failing `yo.c` (pr1541) was taken before the retry
overwrote it: its only `__yo_borrow_release` occurrence is inside a string
literal at line 127184. So the borrow primitives were not defined anywhere,
and the RC runtime that follows them was missing too. In a good `yo.c` of the
compiler (1.86 M lines), the code section starts at line ~59.5 K, the borrow
primitives are defined at ~67 K, and the first call to
`__yo_borrow_assert_unborrowed` is at ~85 K. In the failing files, function
bodies calling it start at ~64 K, right after the declarations. The code
section had lost its whole first part.

## Root cause

`yo compile` streams finished function bodies to a spill file during
emission (`Emitter.spill_code_if_large`, `src/emitter.yo`; landed
2026-09-30, `plans/CODEGEN_MEMORY_REDUCTION.md` §0.10). Each time the
in-memory code reaches 8 MiB, the buffer goes to disk. When writing the C
file, `run_compile` (`src/main.yo`) splices the spill between the
declarations and the in-memory tail. Two things made that fragile:

1. **The path was shared.** It was `${output}.yo-code-spill`, a pure function
   of `-o`, so two compiles of the same output used the same file. Each one's
   first spill opened it with `O_TRUNC`, and each wrote its chunks at its own
   offsets with `pwrite`. The first compile to finish then deleted it.
2. **The splice trusted the path, not the emitter.** Whether to splice was
   decided by `exists(code_spill_path)`. When the other compile had deleted
   the file, `exists` said no. The compile then wrote headers, declarations
   and the code tail with no error, and the spilled part was gone.

The spilled part is the start of the code section. That is the sys and async
runtime, the borrow primitives and the RC runtime
(`generate_atomic_gc_runtime_functions`), the constructor block and most
function bodies: 124.6 MB of the 143.9 MB `yo.c` in the reproduction below.
Every function still has a prototype in the declarations section, so the only
calls clang rejects are the ones with no prototype anywhere. Those are the borrow primitives, which is why every error
names `__yo_borrow_assert_unborrowed`. If the C compiler had got past them,
the link would have failed on the missing definitions.

### Where the second compile came from

The machine load and the C compiler only set the timing. Both incidents had
two `yo compile` processes running with the same `-o`, in the same worktree:

- **2026-10-22 16:45:48Z (pr1541; the failing log's mtime is 2026-10-23
  01:21 local, +0800):** an agent started `yo build` (commit f710cd53e). At
  16:47:34Z it ran `kill <yo build pid>`, and at 16:47:54Z it started a new
  `yo build` (861351670). The kill ended `yo build`
  but not its `yo compile` child, which ran on two minutes ahead of the new
  one. It finished first and deleted the spill, and the new compile wrote the
  truncated `yo.c`. The orphaned child is filed separately:
  `issues/2026-10-23-killing-yo-build-leaves-its-compile-children-running.md`.
- **2026-10-22 (async-alias):** a workflow was interrupted and resumed. Its
  first run's `yo build` (a script under `async-alias/tmp/`, started 02:21Z)
  was still running when the resumed agent started its own at 02:24:17Z (the
  `build1.log` one), 2 min 47 s behind it. The first build's log was last
  written at 02:36:15Z, and the second build's C failed about three minutes
  later, at 02:39:21Z. In between, at 02:37:03Z, the orchestrator found the
  two builds and killed the older one's process group.

### Hypotheses ruled out

- **A shared cache or temp path across worktrees** (`~/.cache/yo`, a fixed
  `/tmp` name, the version cache). A self-build's compile reads and writes
  none of them while emitting C. The only fixed `/tmp` names in `src/` are
  the warm-selfcheck's (`run_warm_selfcheck_compile`, a debug subcommand that
  `yo build` never runs) and two unused constants in `src/main.yo`. Two
  builds in DIFFERENT worktrees share nothing on this path, because every
  output path is inside its own worktree.
- **Runtime emission gated on racy state** (`--jobs`, chunked emission,
  the build runner's level scheduler). The borrow primitives are emitted
  unconditionally by `generate_atomic_gc_runtime_functions`, on one thread.
  `build.yo` builds the compiler at `ReleaseSafe` (`-O2`), and chunking is
  off for optimized builds, so `--emit-chunks` was not involved.
- **A cache-key collision.** Nothing is cached between the evaluator and the
  C file of a non-chunked compile.

## Reproducer

Deterministic, about 30 minutes on the loaded box:
`~/Workspace/Yo-wt/vbd-logs/flaky-build/race.sh <yo> <tag> 60`. It runs
`yo compile src/main.yo --std-path ./std --skip-c-compiler -o <dir>/yo` twice
on a frozen export (`git archive`) of develop d09011d8b. The second run starts
60 s after the first, and each run has its own `--emit-c-to`, so both C files
can be inspected. The 60 s lead means the first compile always finishes, and
deletes the spill, while the second is still emitting.

| binary | run | rc | C bytes | C lines | borrow primitives defined |
| --- | --- | --- | --- | --- | --- |
| seed v0.2.68 | A (first) | 0 | 143,943,423 | 1,872,335 | yes |
| seed v0.2.68 | B (+60 s) | **0** | **19,385,039** | **256,332** | **no** |
| this branch (3ff7b03d1) | A (first) | 0 | 144,755,547 | 1,883,858 | yes |
| this branch (3ff7b03d1) | B (+60 s) | 0 | 144,755,547 | 1,883,858 | yes |

With the fix, the two runs spilled to `yo.1474818.yo-code-spill` and
`yo.1479532.yo-code-spill` side by side, each removed only its own, and the
two C files are byte-identical (`cmp`). The branch's C is larger than the
seed's because the branch compiler emits different code; that is unrelated.

With the seed, run B reported success and wrote 19.4 MB of C. It has no
`// Function implementations` line, and the first byte that differs from A's
C is at line 59636, where the code section starts. Its first call to the
undefined primitive is at line 64461, and the next two are 38 and 168 lines
further on. That spacing matches both incidents exactly (64099/64137/64305
and 64185/64223/64391). Clang on B's C reproduces the reported error
verbatim:

```
B.c:64461:3: error: call to undeclared function '__yo_borrow_assert_unborrowed'; ISO C99 and later do not support implicit function declarations [-Wimplicit-function-declaration]
```

Regression test, seconds: `tests/cli-cases/compile-splices-only-its-own-code-spill`.
The fixture puts a foreign file at the old shared path (`app.yo-code-spill`,
containing an `#error` line) and compiles a program far too small to spill.
With the seed v0.2.68 the case records rc=1: clang stops on the planted
`#error`, which the compile spliced into `app.c`, and the compile deletes the
planted file. With the fix it records rc=0, and the planted file is still
there, unchanged.

That case fails only when both halves of the fix are reverted, so
`tests/internal/compile.test.yo` tests each half on its own:

- "a code spill that is gone or holds other bytes fails the compile" checks
  that `code_spill_path_for` carries the pid. It also runs `_check_code_spill`
  and `_copy_code_spill_into` on a missing file, a resized file and a short
  copy, and expects each one's error.
- "a compile splices only its own spill, by its byte count, and removes dead
  compiles' spills" runs `run_compile` in the test process on a program too
  small to spill. Beforehand it plants `#error` files at three paths: the test
  process's own pid path, the old shared path, and a pid that no process can
  have. It then expects no planted text in the C, the first two files
  unchanged, and the dead pid's file gone.

## Could it compile?

Call the compile that finishes first F and the other one L. L's first spill
opens the shared file with `O_TRUNC` while F has spilled P bytes. From then on
F writes its chunks at offsets P and up, and L writes its own from offset 0.
For each byte the last writer wins. F then splices whatever the file holds,
unchecked, and deletes it. L finds no file and writes C without its spilled
part, which is the loud failure above.

What F splices depends on how far L has got (`L_pos`):

- **L_pos < P:** the range from L_pos to P reads back as NUL bytes. The NULs
  replace whole F chunks, and the range before them is L's code, ending at a
  function boundary. Clang only warns about NULs, and an optimized build passes
  `-Wno-everything`, so the C parses. But F's functions in the hole are gone.
  They still have prototypes, so the link fails unless all of them are dead.
- **L_pos ≥ P:** there is no hole. The file is L's code up to L_pos, then F's
  own. In the reproducer below, run A (F) has no NUL bytes and is complete.
  That fits this case (or an L whose first spill came after F's copy), not
  the hole.

If both compile the same tree, both write the same bytes at the same offsets,
and F's C is correct. If they compile different trees, the result depends on
where the differences are:

- **Differences that change the C's length before L_pos:** L_pos falls inside
  a function in F's layout, and the C almost certainly does not parse.
- **Differences that keep the length, or that all come after L_pos:** the
  offsets line up. Examples are a changed constant, a flipped `<`, or a renamed
  identifier of the same length. F's C is then well formed. It holds L's
  version of every function before L_pos and F's own after it, so it compiles
  and links with rc=0, and F's binary stays at the output path. The observed
  build fails anyway, because L lost its spill.

The realistic trigger is exactly this: edit, kill the build, rebuild. In
pr1541 the orphan (F) and the re-run (L) compiled different commits.
Wrong-but-compiling C was therefore possible, though it was never observed
and never constructed. The fix closes it: no other process writes a
compile's spill, and `_check_code_spill` rejects a spill whose size is not
exactly what the emitter wrote.

## Fix

- **The spill path is per process:**
  `${output}.${pid}.yo-code-spill` (`src/main.yo`). No other process ever
  opens, truncates or deletes it. This is the same remedy as
  `issues/fixed/concurrent-yo-test-runs-in-one-directory-overwrite-each-others-batches.md`.
  `.gitignore`'s `*.yo-code-spill` still matches.
- **The emitter's count decides the splice, not the path.** `compile_module`
  returns the number of bytes it spilled through a new
  `code_spilled_out : &mut usize` parameter (`src/codegen/codegen_c.yo`).
  `run_compile` splices only when that count is non-zero.
  `_check_code_spill` fails the compile when the file is missing or its size
  differs from the count, and `_copy_code_spill_into` checks the bytes it
  actually copied against the count. A lost spill now fails as
  `yo: error: compile: the C code spill file "…" is gone, but this compile
  spilled N bytes to it; …`, not as C that is missing its runtime.
- **Spills of dead compiles are removed.** A compile killed during emission,
  or one whose codegen fails after its first spill, cannot remove its own
  spill (about 125 MB for a self-compile). With one fixed name, the next run
  overwrote it; with a per-process name, nothing would. So before emission,
  `_remove_dead_code_spills` lists the output's directory and removes every
  `<output>.<digits>.yo-code-spill` whose process is gone. `kill(pid, 0)`
  answers `ESRCH` on POSIX and `EINVAL` on Windows for such a pid. The spill of
  a compile that is still running is kept.

### Left as is

- **Concurrent compiles of one output.** Two compiles with the same `-o`
  still write the same C file and binary, and the last writer wins. Making
  that safe means stopping the orphan, which is the open issue above.

## Verification

All on this branch, with the tree binary built by `yo build --std-path ./std`:

- The reproducer above: the seed loses run B's spill, and the branch keeps
  both C files complete and identical.
- `tests/cli-cases/compile-splices-only-its-own-code-spill`: GOLDEN-DIFF with
  the seed (rc=1, stdout and tree differ) and PASS with the branch.
- `yo check ./src` and `yo check ./std` (both `--std-path ./std`): rc=0.
- `tests/internal/chunk_assembly.test.yo` (the spill's own tests): 6 of 6
  pass. `tests/internal/compile.test.yo` (imports `run_compile`): 6 of 6
  pass with `YO_TEST_LEAK_VERDICT=0`, the setting CI uses, including the two
  per-half cases above. `tests/internal/build_runner.test.yo` (also imports
  `src/main.yo`): 18 of 18 pass.
- `scripts/cli-diff-test.sh`: PASS 429, GOLDEN-DIFF 0, SKIP 1
  (`version-install-pinned`, network).
