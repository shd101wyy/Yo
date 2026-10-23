# Killing `yo build` leaves its compile children running

**Severity:** S2 — after `kill <yo build pid>` the artifact compile keeps running, outside any lock the caller held, and later writes its C file and binary over whatever a re-run in the same project produced.

**Status: OPEN.** Found 2026-10-23 while tracing the two spurious
`__yo_borrow_assert_unborrowed` build failures
(`issues/fixed/2026-10-23-concurrent-compiles-of-one-output-share-the-code-spill-file.md`).

## Symptom

`yo build` runs each artifact compile as a child process (`compile_artifact`
in `src/build_runner.yo` spawns `<self> compile ...`). A SIGTERM to the
`yo build` process ends it (rc=143) but not the child, which is reparented and
runs to completion:

```
$ yo init orphan --name orphan && cd orphan
$ yo build > build.log 2>&1 &
$ P=$!; until C=$(pgrep -P $P); do sleep 0.1; done   # the compile child appears ~13 s in
$ kill $P
parent alive? no
child alive? yes            # reparented to a subreaper
...                         # 14 s later the child finishes and writes
yo-out/x86_64-unknown-linux-gnu/bin/orphan
```

(Measured 2026-10-23 with the v0.2.68 seed. The `build.log` of the killed
build still received the child's whole output, ending in the link.)

## Why it matters

The usual way to stop a build is to kill the command that was started, often
through a wrapper that takes the machine-wide heavy lock
(`scripts/heavy-lock.sh`). The wrapper then drops its slot while the compile
it was guarding runs on for up to 25 minutes (a self-build), unaccounted. A
re-run in the same project then compiles the same output path concurrently
with it:

- Until 2026-10-23 the two compiles also shared the code spill file, and the
  re-run's C lost every spilled function body and the runtime. That part is
  fixed (the spill name now carries the pid).
- What remains: both compiles still write the same `<output>.c` and the same
  binary. The orphan, which usually started earlier, normally finishes first
  and the re-run's output wins. If the orphan finishes LATER, its binary,
  built from the earlier tree, replaces the re-run's. Its C write can also
  truncate the C file while the re-run's C compiler is reading it.

The 2026-10-23 incident followed this pattern: an agent ran
`kill <yo build pid>` and restarted the build 20 seconds later, and the
orphaned compile finished first. (The 2026-10-22 incident had the same
overlap from a different source: a workflow resumed while its interrupted
run's `yo build` was still going in the same worktree.)

## Reproducer

The shell steps above. To see the overlap with a re-run, start a second
`yo build` in the same directory right after the `kill` and list the
processes: two `yo compile` processes write one output.

## Possible fixes

- `yo build` forwards SIGTERM/SIGINT/SIGHUP to its live children (and waits
  for them) before exiting. This needs a signal-handler hook in the
  runtime that the build runner can register, which the runtime does not offer
  today.
- Alternatively, on Linux the child can be spawned with
  `prctl(PR_SET_PDEATHSIG, SIGTERM)`, so it dies with its parent. That is
  Linux-only; macOS would still need the forwarding.
- A per-output lock taken by `yo compile` (an `flock` beside the output) would
  serialize two compiles of one output, whatever started them. It does not
  stop an orphan from writing a stale binary after a re-run's.

Until then: stop a build by its process group (`kill -- -<pgid>`, or
`setsid` the wrapper and kill the session), not by the `yo build` pid.
