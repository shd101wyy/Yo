# io_uring ring creation failure exits the process — ENOSYS under Docker's default seccomp, EPERM on hardened kernels, ENOMEM under RLIMIT_MEMLOCK

**Status: OPEN** — filed 2026-09-26, out of the liburing audit
(`plans/DROP_LIBURING.md`, fixed as its Phase 5).

## Symptom

`__yo_io_init` in `src/codegen/async/runtime_io_linux.yo` treats every ring-creation
failure as fatal — first retrying once without setup flags, then:

```c
  if (ret < 0) {
    fprintf(stderr, "[Yo] io_uring_queue_init failed: %s\n", strerror(-ret));
    exit(1);
  }
```

Any async I/O on such a box dies with rc=1 at the first submission, with one stderr
line as the only diagnostic. Three real errno families reach this path:

- **`-ENOMEM`** — RLIMIT_MEMLOCK exhaustion from ring churn. Reproduced verbatim in CI
  ("[Yo] io_uring_queue_init failed: Cannot allocate memory",
  `issues/fixed/every-thread-creates-an-io-uring-ring-and-thread-churn-runs-out-of-memory.md`;
  that issue fixed the churn, not the death).
- **`-ENOSYS`** — kernel < 5.1, or `io_uring_setup` blocked by seccomp. Docker's
  default seccomp profile blocks `io_uring_setup` returning ENOSYS ("blocked due to
  security vulnerabilities that can be exploited to break out of containers" — Docker's
  seccomp documentation), and gVisor does not implement io_uring, so a Yo async program
  deployed in a stock container dies at first I/O. Expected message:
  `[Yo] io_uring_queue_init failed: Function not implemented`. This leg is
  documented-not-yet-reproduced here (no Docker on the auditing machine); verify on the
  first Docker-equipped box per the reproducer below.
- **`-EPERM`** — io_uring disabled by hardening (sysctl/kernel lockdown, sandbox
  profiles in the SELinux/apparmor families).

The only graceful-degrade precedent in the runtime is the sleep stub's `-ENOSYS`
(`std/sys/timer.yo`: "it is the one operation there that degrades instead of
aborting"). `plans/DROP_LIBURING.md` Phase 1 removes that stub arm (the ring layer
becomes always-compiled), which makes a general degrade path strictly more
load-bearing, not less.

## Reproducer (to run on the first Docker-equipped machine)

```bash
cat > tmp/fixme.yo <<'EOF'
{ sleep } :: import("std/sys/timer");
main :: (fn(io : Io) -> unit)({
  io.await(sleep(u64(10)), IoExn(io : io, exn : Exception(throw : ((_e) -> unwind(())))));
});
export(main);
EOF
yo compile tmp/fixme.yo --optimize 2 -o /tmp/sleeper
# Host: prints nothing, exits 0 after ~10 ms.
docker run --rm -v /tmp:/w ubuntu:24.04 /w/sleeper
# Expected in-container: "[Yo] io_uring_queue_init failed: Function not implemented", rc=1.
```

(The `sleep` await goes through the Linux timer path, which calls `__yo_io_init`; any
async file or socket op reaches the same exit. Verify which form the timer path takes
at fix time — the fix must cover every `__yo_async_*_start`, not the sleep op alone.)

## Root cause

Ring-creation failure has exactly one handling path: print and `exit(1)`. There is no
recorded "ring unavailable" state for the op starts to consult, so degradation cannot
even be expressed today except per-op in stub arms.

## Fix direction (plans/DROP_LIBURING.md Phase 5)

Record the init errno once (`_Thread_local`); every `__yo_async_*_start` thereafter
returns an already-completed future carrying that errno — generalizing the documented
sleep-degrade shape to the whole op set — plus one clear diagnostic naming the errno
and its likely cause:

- `ENOSYS` → kernel < 5.6 or seccomp-blocked (name Docker's default profile);
- `EPERM` → hardened/sandboxed kernel;
- `ENOMEM` → RLIMIT_MEMLOCK (point at
  `issues/fixed/every-thread-creates-an-io-uring-ring-and-thread-churn-runs-out-of-memory.md`).

Never `exit(1)`. A poll/epoll degraded backend is explicitly out of scope
(`plans/DROP_LIBURING.md` §10) until users hit blocked environments in practice.

The fix lands with a regression test that fails before and passes after: a build whose
`__yo_uring_queue_init` is forced to fail (e.g. an injected `seccomp` rule or a
`__YO_TEST_RING_INIT_ERRNO` override compile flag) must complete the awaited op with
the errno instead of exiting.
