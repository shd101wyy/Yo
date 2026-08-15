# The compiler holds its whole evaluator arena while the C compiler runs

**Status: OPEN — CONFIRMED TWICE, and now the sole cause of a red required
check.** (First measured 2026-08-15 from CI run 31862196401; re-confirmed the
same day on run 31864299243 under the memory cap.)

## Re-confirmation under the cgroup cap (run 31864299243) — the decisive trace

With `systemd-run --scope -p MemoryHigh=11G -p MemoryMax=14G` applied to the
`test` matrix legs, `test (ubuntu-latest)` still fails, and the post-mortem
step pins the moment precisely:

```
04:24:13   Building yo 65bb2ec → yo-out/x86_64-linux-gnu/bin/yo
04:36      yo-out/x86_64-linux-gnu/bin/yo.c written — 140,540,726 bytes
04:40:59   process dies, exit 2      (samples plateau at ~12.0-12.5 GB used)
```

**The emit SUCCEEDED.** Under an 11 GB soft cap the compiler got all the way
through evaluation and codegen and wrote the full 140 MB of C. It then spent
nearly five more minutes alive — holding that whole arena — while clang
compiled the file, and died there.

This isolates the bug from every other hypothesis:

- it is NOT the emit peak (that now fits under the cap),
- it is NOT clang being heavy (3.17 GB alone, measured locally),
- it is ONLY the two overlapping, and the second peak is entirely avoidable
  because nothing after `write_file` reads any of the state being held.

Verified by source read on the same day: nothing between the `write_file` at
`yo-self/main.yo` and the end of the compile path references `module_value`,
`env`, `ctx`, `c_src` or `shared_info_table`. The release is safe.

## What the timeline shows

`yo build` of `yo-self/main.yo` on a 16 GB ubuntu-latest runner, sampled every
20 s:

```
03:41 .. 03:50   Mem: 15989 total, ~15,480-15,540 used, ~210-290 free
03:47            yo-out/x86_64-linux-gnu/bin/yo.c written — 140,540,726 bytes
03:50            process dies, exit 2   (dmesg: no oom-kill)
03:50 (after)    Mem: 991 used, 14,737 free
```

The `.c` is written at 03:47 and the process is still holding ~15.5 GB three
minutes later, while `clang` is compiling that file. The two peaks **overlap**:

- Yo→C emit: ~15 GB of evaluator/codegen state.
- `clang -O2` on the emitted 140 MB C: measured locally at **3.17 GB peak /
  69 s** — modest on its own.

Neither is fatal alone. Their sum on a 16 GB box is.

## This is not "clang is heavy"

Locally, `clang -std=c11 -fno-strict-aliasing -fwrapv -w -O2` over the real
142 MB self-emit peaks at 3.17 GB and produces a working binary in 69 s. The
problem is that the compiler process has not released anything by the time it
spawns the child: the AST, evaluated values, the codegen `ExprInfoTable` and
the emitted C string are all still live across the `Command` invocation.

## Why it hid for so long

Every other self-building job in `test.yml` runs under
`systemd-run --scope -p MemoryHigh=11G -p MemoryMax=14G`, which forces the
kernel to reclaim into swap rather than letting the process balloon. Under that
cap the overlap is paged out and the build survives — so the underlying
behaviour never had to be fixed. The `test` matrix legs had swap but no cap,
and run 31862196401 shows the consequence starkly: **35,839 MB of swap
provisioned, 44 MB ever used**, because nothing applied the pressure that makes
Linux page anything out.

The workflow now applies the same cap (that is a mitigation, not the fix).

## Where the memory actually lives (correcting the obvious first guess)

The natural first move — extract the evaluate+emit region into a scope so its
locals drop before the child runs — is **not sufficient on its own**. The bulk
is held by module-manager GLOBALS, which no local scoping can release:

- `g_module_cache_keys` / `g_module_cache_vals` / `g_module_cache_types` and
  `g_loading_keys` / `g_loading_envs` (`yo-self/evaluator/module_loader.yo:88-94`)
  — every evaluated module's values, for the whole import closure.
- `g_cached_prelude_env` (`yo-self/module_manager.yo:218`).
- `g_shared_expr_info_table` (`:223`) — per-expression codegen metadata for the
  prelude, every demand-loaded module AND the entry module, deliberately shared
  so codegen can see every collected function's body.

Conversely, clearing the globals alone is also not sufficient: the locals
`module_value`, `env`, `ctx` and the 140 MB `c_src` still hold references at
the point the C compiler is spawned, and `ctx.expr_info_table` pins the table
even after the global slot is reassigned.

So a real fix needs BOTH halves — drop the local handles and clear the globals
— which is why this is a small design change rather than a one-line edit.

## CONFIRMED WORKING — run 31869274650 (2026-08-15)

`Stage 1: build the self-hosted compiler with the SEED` **passed on both Linux
legs**, the step that had failed on every previous attempt (15.5 GB uncapped,
then 12.4 GB under the cgroup cap). The split is what did it, and it works with
the **unmodified v0.2.4 seed** — no release required.

The diagnosis is therefore confirmed on both halves:

- two peaks overlapping, neither fatal alone; and
- a compiler-side fix cannot reach a seed-driven step, so the split had to be
  done at the workflow level.

Had only the compiler fix shipped, this leg would still be red.

Also verified rather than merely asserted: `Build system smoke test` passed,
which was the build-system coverage claimed as "not lost" when stage 1 stopped
using `yo build`.

Still NOT exercised: the compiler-side fix itself. It only runs when the
compiler doing the work is built from this tree — stage-2/stage-3, or stage-1
once `SEED_VERSION` reaches a release containing it.

## Status of the fix (2026-08-15)

**Compiler side — DONE** (`2a7af4324`). `yo-self/main.yo` now wraps evaluate+emit
in a scope and calls `mm_reset()` after the write, so both halves land together.

**But that does NOT fix stage 1 in CI**, and the distinction matters: stage 1
runs `yo build` under the **seed**, a released binary that predates the fix. The
overlap therefore still happens, inside a child process the workflow cannot
reach into. A compiler fix can only take effect once `SEED_VERSION` points at a
release containing it.

**CI side — DONE** (`d64a84a4b`), and it is seed-independent: stage 1 no longer
uses `yo build`. It emits C with `--emit-c-to --skip-c-compiler` (process exits,
returning everything to the OS) and compiles that C in a fresh process. Same
split the musl leg and `fixpoint-arm64.yml` already use.

Anything else that shells out to a single `yo compile` on a large program has
the same exposure until the seed advances — worth checking before adding a new
self-build job.

## Fix directions

1. **Release before spawning**, both halves together: clear the module cache,
   the prelude env and the shared `ExprInfoTable`, AND drop the local
   `module_value` / `env` / `ctx` handles, once the C string is on disk and
   before `Command` runs the C compiler. Nothing after that point reads any of
   it. The clearing primitives already exist (`clear_module_cache`,
   `mm_clear_prelude_env`, `mm_set_shared_expr_info_table`) and are plain
   global reassignments.
2. **Free the C string.** `c_src` is a ~140 MB `String` that stays live across
   the child process; it can be released immediately after `write_file`.
3. The broader arena cost is the subject of
   `plans/backlog/YO_SELF_ENV_SHARING.md` (def-time body envs COPY what TS
   SHARES — 7.4 M live `Variable`s). Fixing that shrinks the first peak
   generally, but (1) and (2) are cheap and independent of it.

## Verify

Sample RSS during a `yo build` and assert it DROPS after the `.c` is written
and before the C compiler finishes — today it stays flat at the emit peak. The
CI post-mortem sampler added in the same change (`/tmp/yo-mem.log`) already
produces exactly this trace.
