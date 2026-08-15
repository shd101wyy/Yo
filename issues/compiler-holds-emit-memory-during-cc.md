# The compiler holds its whole evaluator arena while the C compiler runs

**Status: OPEN** (measured 2026-08-15 from CI run 31862196401.)

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

## Fix directions

1. **Release before spawning.** Drop the evaluator/codegen state once the C
   string has been written to disk and before `Command` runs the C compiler.
   The emitted C is already on disk at that point — nothing needs the in-memory
   copy. This alone should remove the overlap.
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
