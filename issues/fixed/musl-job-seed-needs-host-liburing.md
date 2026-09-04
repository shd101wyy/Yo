# The musl job's seed cannot start: the Linux bundle needs `liburing.so.2`

**Status: FIXED** 2026-08-15 (found on PR #126, runs 31851051908 and
31854199991 — identical in both).

## Symptom

`Static musl Linux bundle (build + run, no publish)` failed at
"Stage 1 (Yo → C only, on the glibc host)" **within 10 milliseconds** of the
step starting, with exit code **127**:

```
yo: error while loading shared libraries: liburing.so.2:
    cannot open shared object file: No such file or directory
##[error]Process completed with exit code 127.
```

The seed install immediately before it reported success
(`seed linux-x64 installed from v0.2.4`).

## Root cause

The published Linux bundle is **dynamically linked against liburing**, because
it is built on a machine that has it. `#if __has_include(<liburing.h>)` decides
this when the C is compiled, so by the time the artifact exists the dependency
is baked in. The musl job installed no liburing, so the dynamic loader could
not start the seed at all.

## The misleading part, worth remembering

**Exit 127 is conventionally "command not found"**, and that is how it reads in
a CI log — especially one step after a PATH-modifying action. The first
investigation went looking for a `$GITHUB_PATH` problem in `install-seed`. The
actual message is from the dynamic loader, not the shell, and it is the only
line that says so. Read the line above the exit code before trusting the code.

A second reason it misled: the _other_ jobs that run the seed on Linux
(`test`, ThreadSanitizer, hollow sweep) all install `liburing-dev` for
unrelated reasons — to compile io_uring code — so they masked this dependency
everywhere except the one job that did not need liburing for its own build.

## Fix

Install liburing on the host before the seed runs:

```yaml
- name: Install liburing (needed to run the seed)
  run: |
    sudo apt-get update
    sudo apt-get install -y liburing-dev
```

This is the **host's** liburing, needed only so the seed binary can execute.
It is unrelated to the **static** liburing the Alpine stage links into the
musl artifact, and it does not enter the artifact: stage 1 is emit-only
(`--emit-c --skip-c-compiler`), so no host library is linked.

## Broader consequence (recorded in `plans/archive/P3_DISTRIBUTION.md`)

This is not just a CI bug — it is a property of the shipped product: **a user
who downloads the Linux bundle onto a box without liburing gets a binary that
will not start.** The P3 dependency table previously described liburing as
needed for "async I/O on Linux", which understates it. `install.sh` already
installs liburing, so the supported path is fine; the hazard is anyone
extracting a bundle by hand.
