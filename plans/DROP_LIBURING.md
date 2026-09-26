# Drop the liburing dependency — vendor the io_uring ring layer, add an epoll fallback

**Status:** ACTIVE — proposed 2026-09-26, extended the same day with the epoll fallback
and the performance guarantees (Phases 5–6). Phase 0 is this document plus its companion
issue (`issues/fixed/io-uring-init-failure-exits-the-process.md`).

**Landed:** Phase 0 (this doc + the issue), Phase 1 (the vendored ring layer; PR #946 —
`yo check ./src` 279/279, emit-diff clean, probe binaries link and run with zero
`io_uring_*` undefined symbols, 5 internal pins), Phase 2 (docs en/zh + the
PORTABLE_C trap note + the 256→1024 SQE doc fix; PR #947), Phase 5 (the epoll fallback
+ ladder; every gate green incl. the Docker default-seccomp leg — the issue is closed
and moved to `fixed/`). Open: Phase 3 (waits on the release train), Phase 4 (seed-gated cleanup — the
gate is `SEED_VERSION` at or past the FIRST release built from Phase 1, which
is v0.2.45+ since v0.2.44 was cut from develop before this stack merged).

**Phase 6 landed** (PR #<p6>): G1 zero-regression (emit-diff + the A/B bench:
echo identical, timer/file within variance); G2
`scripts/bench-io-backends.sh` + `scripts/bench/` programs + the
`io-floors.env` ratchet — measured on the merge box the epoll fallback is
FASTER than the ring (echo 1.75x, timers 20x, files 7x — inline completion
beats CQE round-trips there; re-measure on stock Linux at release checks);
G3 the always-on `__yo_stats_*` counters (deviation from the #ifdef plan:
three thread-local increments cost nothing next to the entries they count,
and always-on avoids the -D plumbing) + `scripts/io-budget-check.sh` as the
hard gate (CI job `io-budgets`) — measured: ring 2 enters/op linear, epoll
0 on inline ops; timer 2-4 enters/tick; a 150 ms blocked window accrues
<= 4 enters / <= 3 probes on either backend (the anti-spin rule). G4 came
with Phase 5 (YO_IO_BACKEND + the never-silent fallback line).

Measurement notes from the Phase 1/5 gates: probe program C 5,189 → 5,428 lines
(ring layer net +239), +~800 more with the epoll section; user binaries 0 undefined
`io_uring_*`, no liburing in `ldd`; the generation-2 emit (new binary compiling the
compiler) is liburing-free, exactly the §5 seed-lag table. This is
both the decision record and the implementation plan. Seed at writing: `v0.2.43`
(`.github/workflows/release.yml`); the first liburing-free release is therefore
**≥ v0.2.44** and is referred to below as *release N*.

## 1. The decision

**Keep io_uring (the kernel interface) as the primary backend, drop liburing (the
library), and add an epoll fallback for the environments where io_uring cannot exist.**

The Linux async runtime already *is* our own runtime — futures, deferred submission
batching, the eventfd wake channel, cancellation by type-tagged `cancel_fn`, timerfd
timers. liburing supplies only the thin ring plumbing under it: ring setup/mmap, `get_sqe`
index math, `submit`/`enter`, and CQ peek/wait. That is ~10 linked functions plus header
inlines, replaceable by roughly 400 lines of pure C11 emitted inline. The macOS backend
(`runtime_io_macos.yo`, 2,057 lines) and the Windows backend (`runtime_io_windows.yo`,
4,914 lines) are already hand-rolled syscall-level runtimes with no third-party library;
after this plan the Linux backend joins them — twice over, because the fallback is a port
of the macOS design (§4 Phase 5).

io_uring itself stays the primary: it is what makes async `openat`/`statx`/`fsync`/
`renameat` possible at all (epoll is a readiness API and cannot express them), and the
runtime's op set, batching and wake design are unchanged. The audit (§2) found that every
historical failure blamed on "the async runtime" was in fact a failure of **packaging the
library** — dynamic `DT_NEEDED`, header/pkg-config skew, sanitizer blindness — which is
exactly the part vendoring removes.

Precedent: libuv implemented io_uring support the same way (direct
`io_uring_setup`/`io_uring_enter` syscalls, no liburing dependency) precisely so the
dependency does not land in every downstream binary — Node ships it to millions of
machines. We emit C into every user program; the same argument applies to us twice over.
libuv also keeps an epoll path for the environments io_uring is blocked in; Phase 5 is
ours.

## 2. The audit (evidence this plan rests on)

### 2.1 The dependency surface today

`src/codegen/async/runtime_io_linux.yo` (2,061 lines; C bodies verbatim, no
interpolations) plus the Linux timer section of `src/codegen/async/runtime_io_common.yo`
(lines ~640–770, `${timer_dispose_init}` interpolation). Ring config: 1024 entries,
thread-local, `IORING_SETUP_SINGLE_ISSUER|COOP_TASKRUN|DEFER_TASKRUN` with a retry
without flags for older kernels. Lazy ring creation on first submission (the #934
RLIMIT_MEMLOCK fix). No registered buffers, no buffer rings, no multishot, no SQPOLL, no
`IORING_OP_TIMEOUT` (sleep is timerfd + `POLL_ADD`).

Linked (non-inline) liburing symbols used — the complete list:

| Symbol | Replacement (§3) |
| --- | --- |
| `io_uring_queue_init_params` | `__yo_uring_queue_init` (setup syscall + 3 mmaps) |
| `io_uring_queue_exit` | `__yo_uring_queue_exit` (3 munmaps + close) |
| `io_uring_get_sqe` | `__yo_uring_get_sqe` (userspace sqe_head/tail shadow) |
| `io_uring_submit` | `__yo_uring_submit` |
| `io_uring_submit_and_wait` | `__yo_uring_submit_and_wait` |
| `io_uring_wait_cqe` | `__yo_uring_wait_cqe` |
| `io_uring_wait_cqe_timeout` | `__yo_uring_getevents` (enter with `GETEVENTS`, see below) |
| `io_uring_peek_cqe` | `__yo_uring_peek_cqe` |
| `io_uring_peek_batch_cqe` | `__yo_uring_peek_batch_cqe` |

Everything else — 16 `prep_*` helpers, `sqe_set_data`, `cqe_seen`, `cqe_get_data` — is
`static inline` in `liburing.h`; we vendor equivalents. Roughly 120 `io_uring_*` call
sites in `runtime_io_linux.yo` and 4 in `runtime_io_common.yo`, all mechanical renames.

The single `io_uring_wait_cqe_timeout` call passes a **zero** timeout (the
DEFER_TASKRUN probe in `__yo_io_poll`, per
`issues/fixed/io-uring-defer-taskrun-poll-never-enters-kernel.md`). A zero-timeout wait
is exactly `io_uring_enter(fd, 0, 0, IORING_ENTER_GETEVENTS)`: non-blocking, materialises
deferred completions, no timeout argument of any kind. **The vendored layer needs no
enter-timeout path at all** — no `IORING_ENTER_EXT_ARG`, no `io_uring_getevents_arg`.

### 2.2 What the dependency has cost, measured in this repo

| Failure class | Record |
| --- | --- |
| Seed died at `exec` with exit 127: `liburing.so.2` is a `DT_NEEDED` of every published Linux bundle | `issues/fixed/musl-job-seed-needs-host-liburing.md` |
| Header present but pkg-config blind → `undefined reference to io_uring_*` in CI, repeatedly; needs a dedicated `check_liburing_consistency` (`scripts/install.sh:484`) and a load-bearing `_probe_liburing` (`src/main.yo:2310`) | `src/main.yo:2310–2329`, `scripts/install.sh:288–295` |
| The no-liburing `#else` arm did not compile at all | `issues/fixed/liburing-fallback-does-not-compile.md` |
| `install.sh --from-source` never passed `-luring` | `issues/fixed/installer-source-build-never-links-liburing.md` |
| TSan cannot see liburing's raw-syscall mmap/munmap of rings → false races; runtime shims (`__yo_tsan_ring_mapped/unmapping`) and a gate that could never pass | `issues/fixed/tsan-reports-a-race-between-two-threads-io-uring-rings.md` |
| Every CI job that runs a Linux binary must `apt-get install liburing` first | `.github/actions/build-stage1/action.yml:47–66`, `.github/workflows/release.yml:1001–1006`, test.yml's musl leg |
| Portable-C single-file needs liburing headers at the USER's build time, or async aborts | `plans/reference/PORTABLE_C_DISTRIBUTION.md` ("the liburing trap"), `scripts/make-portable-c.sh:67` |

The `-luring` flag is pushed at exactly one site (`src/main.yo:4754–4756`, fed by
`_probe_liburing`); "compile and test funnel through one link path" per its doc comment.
No test golden references liburing (the only `tests/` hit is a generated `.bin.c`
leftover).

### 2.3 External context

- **Docker's default seccomp profile blocks `io_uring_setup`** returning ENOSYS
  ("blocked due to security vulnerabilities that can be exploited to break out of
  containers" — Docker seccomp docs). gVisor does not implement io_uring. Google
  disabled io_uring fleet-wide and on ChromeOS/Android apps after ~60% of its 2022
  kernel-exploit bounties targeted it. This is the motivation for the Phase 5 fallback
  and its companion issue — and, post-Phase 5, the acceptance environment for it.
- **Go declined io_uring for its netpoller** (golang/go#31908, open since 2019) partly
  for these sandbox reasons; Go's answer was to keep epoll. Yo's runtime is CQE-shaped,
  so epoll cannot be our *primary* interface — Phase 5 makes it the *fallback* for
  exactly the environments Go was protecting.
- **libuv** (Node): direct syscalls, no liburing, runtime detection, and an epoll path
  underneath. Both halves of this plan follow it.

## 3. Target design

### 3.1 Namespace

All vendored symbols are namespaced — `__yo_uring_*` functions,
`__YO_IORING_*`/`__YO_NR_*` constants, `struct __yo_uring_sqe/cqe/params/ring` — so the
emitted translation unit can never collide with user C interop that itself includes
`<liburing.h>`, and the `__yo_` prefix stays filtered out of `yo doc` output. The epoll
fallback uses the same `__yo_epoll_*` namespace.

### 3.2 The vendored UAPI

- **Structs** (defined by us, from the stable kernel UAPI; `linux/io_uring.h` layouts,
  append-only since 5.1): `__yo_uring_params` (including the embedded sq/cq offset
  structs), `__yo_uring_sqe` (64 bytes, fixed layout), `__yo_uring_cqe` (16 bytes).
  Ring offsets are read **from the params the setup syscall returns**, not hardcoded —
  the same robustness rule liburing follows.
- **Constants**: setup flags (`SINGLE_ISSUER`, `COOP_TASKRUN`, `DEFER_TASKRUN`),
  `IORING_ENTER_GETEVENTS`, the opcodes used by the 16 prep helpers, `IOSQE_IO_LINK` is
  NOT used (no linked SQEs today), the mmap offsets (`__YO_IORING_OFF_SQ_RING` = 0,
  `..._CQ_RING` = 0x8000000, `..._SQES` = 0x10000000).
- **Syscalls**: `syscall(__NR_io_uring_setup, …)` and `syscall(__NR_io_uring_enter, …)`
  with `#ifndef __NR_io_uring_setup` fallback defines of 425/426 — io_uring's syscall
  numbers are unified across architectures (they postdate the asm-generic numbering
  merge). `io_uring_register` (427) is not used. `<sys/syscall.h>` + `<unistd.h>` +
  `<stdint.h>` only: compatible with clang, gcc and `zig cc`, glibc and musl. The
  fallback backend needs nothing exotic either: `epoll_create1`/`epoll_ctl`/`epoll_wait`
  are plain libc, present everywhere (this is precisely why they are allowed in
  locked-down seccomp profiles that block io_uring).

### 3.3 The ring protocol and its barriers

The runtime is single-issuer (one thread submits) and single-threaded per ring, which is
the simplest quadrant of liburing's protocol. The four ordering points, expressed with
C11 `__atomic_load_n/store_n` (`__ATOMIC_ACQUIRE`/`__ATOMIC_RELEASE`; free on x86-64,
`ldar/stlr` on aarch64):

| Step | Access |
| --- | --- |
| Fill an SQE slot, then `sq_array[t & mask] = idx` | plain stores — we own both until the tail publish |
| Publish k SQEs | `store_release(sq.tail)` → `io_uring_enter(fd, k, …)` |
| Read completions | `load_acquire(cq.tail)`, then plain CQE reads up to it |
| Consume n CQEs | `store_release(cq.head, head + n)` |

`__yo_uring_getevents()` = `enter(fd, 0, 0, GETEVENTS)` replaces the zero-timeout
`wait_cqe_timeout` probe. The TSan shims stay, retargeted at our ring's mapping
pointers — the address-reuse happens-before gap they close
(`issues/fixed/tsan-reports-a-race-between-two-threads-io-uring-rings.md`) is a property
of ring mappings, not of who made them.

### 3.4 What disappears

- The `#if __has_include(<liburing.h>)` / `#else` split in `runtime_io_linux.yo`
  **and** the `#ifdef __YO_HAS_LIBURING` / `#else` split of the timer section in
  `runtime_io_common.yo`. The Linux runtime is always compiled in full; "is async
  available" stops being a per-machine build-time property of the user's C compiler and
  becomes what it always should have been: a runtime capability ladder (§3.6).
- The sleep stub's `-ENOSYS` degrade arm — subsumed by the ladder's final rung.
- `_probe_liburing`, the `-luring` link flag, `check_liburing_consistency`, and (after
  the seed bump) every CI `apt-get install liburing`.

### 3.5 Kernel floors (become the documented contract)

| Capability | Kernel |
| --- | --- |
| The op set the runtime submits (`openat`/`close`/… the existing floor) | 5.6+ |
| `COOP_TASKRUN` / `SINGLE_ISSUER` / `DEFER_TASKRUN` flags | 5.19 / 6.0 / 6.1 — requested together, retried with no flags on rejection (existing logic, preserved verbatim) |
| Async `ftruncate` (`IORING_OP_FTRUNCATE`) | 6.14+ |

One behavior delta, made consciously: `IORING_OP_FTRUNCATE` is today compile-guarded on
liburing's macro, which keys on the **liburing version on the build box**, not the
kernel — a new-liburing/old-kernel box already emits the op and gets `-EINVAL` at
runtime, and an old-liburing/new-kernel box silently loses async ftruncate to a sync
call. After vendoring we define the opcode ourselves and always emit it; below 6.14 the
op completes with `-EINVAL` and the future surfaces it. The compile guard never
guaranteed kernel support; now the failure is honest and in one place. (On the epoll
fallback every op is sync-completed or readiness-driven — see Phase 5 — so op-level
kernel floors do not exist there.)

### 3.6 The backend ladder

Selection happens **once per thread**, at the first `__yo_io_init`, and never re-decides:

```
try ring (io_uring)  ──failure (any errno: ENOSYS seccomp/old kernel, EPERM hardened,
   │                   ENOMEM RLIMIT_MEMLOCK, …)──▶  try epoll  ──failure──▶  errno-futures
   ▼                                                    ▼                       (degrade; the
 ring path,                                      epoll path, port of            companion issue's
 instruction-identical                          the macOS backend              original fix shape)
```

- `__yo_backend` is a `_Thread_local` enum (`__YO_BACKEND_NONE/URING/EPOLL/DEGRADED`).
  Every `__yo_async_*_start` and the loop's poll/wait carry **one predictable branch**
  on it (`if (__yo_backend == __YO_BACKEND_EPOLL) return __yo_epoll_<op>(…);`). The
  ring path's emitted instructions are unchanged — the branch rides where the existing
  `__yo_io_initialized` check already sits. No function-pointer tables, no per-op
  indirection: the primary path pays nothing measurable (G1 in Phase 6 proves it).
- The wakeup channel is backend-agnostic and unchanged: the same eventfd, armed with a
  ring `POLL_ADD` (today's design) or registered with `epoll_ctl(EPOLL_CTL_ADD)`
  (fallback). `__yo_io_notify` — the foreign waker's write under the loop lock — does
  not know which backend armed it.
- `YO_IO_BACKEND=auto|uring|epoll` env override (emitted-C `getenv` precedent:
  `YO_ASYNC_STRICT` in `runtime_core.yo:312`, `YO_MAIN_STACK_MB`). `auto` is the
  default ladder; `uring`/`epoll` force a backend — forced and failing is a hard error,
  not a silent ladder step, so tests and benchmarks can pin the exact path they assert.
  A fallback logs exactly one line
  (`[Yo] io_uring unavailable (<errno>); async I/O running on the epoll fallback`) —
  never silent.

## 4. Phases

### Phase 0 — this PR

This document, the `plans/README.md` index line, and
`issues/fixed/io-uring-init-failure-exits-the-process.md`. Docs-only.

### Phase 1 — vendor the ring layer in the emitted Linux runtime

The compiler change. One PR; behavior-preserving by construction (the emit-diff gate in
§6 enforces it outside the two runtime strings).

Files:

- `src/codegen/async/runtime_io_linux.yo` — insert the vendored layer (UAPI structs,
  constants, ring struct, the ~10 functions, prep helpers; pure C, no interpolations,
  per the file's header comment) at the top of the async section; delete the
  `__has_include`/`#else` structure including the whole stub arm; rename all
  `io_uring_*` references to `__yo_uring_*`; retarget the TSan shims. `__yo_io_init`'s
  `exit(1)` on failure **stays this phase** — the ladder arrives in Phase 5, and this
  phase must not change kernel-failure behavior.
- `src/codegen/async/runtime_io_common.yo` — collapse the timer section's
  `#ifdef __YO_HAS_LIBURING`/`#else`; rename its 4 `io_uring_*` references.
- `src/main.yo` — delete `_probe_liburing` (doc comment at :2310, definition at :2415),
  its call site and the `-luring` push at :4754–4756; fix the system-libs comment at
  :4639.
- `std/sys/timer.yo` — doc comment: the "on a Linux box built without liburing" clause
  becomes "on a kernel without io_uring (< 5.6 or seccomp-blocked)".
- NEW `tests/internal/uring_runtime.test.yo` — following the
  `tests/internal/gc_runtime_atomics.test.yo` pattern (call the generator with a real
  `Emitter`, pin the emitted text): assert the Linux runtime C contains
  `__yo_uring_queue_init` and `__YO_IORING_ENTER_GETEVENTS`, and contains neither
  `liburing` nor `io_uring_queue_init`; assert the common runtime's timer section no
  longer emits the `-ENOSYS` stub arm.

Run `yo fmt` on every `.yo` file touched.

### Phase 2 — docs tell the new truth (same release window as Phase 1; separate PR or folded into it)

Both languages, always:

- `docs/en-US/INSTALL_LINUX.md` + `docs/zh-CN/INSTALL_LINUX.md` — drop liburing and
  pkg-config-for-liburing from prerequisites; state the kernel ≥ 5.6 floor for the
  io_uring path and the epoll fallback below it.
- `docs/en-US/ASYNC_AWAIT.md` + `docs/zh-CN/ASYNC_AWAIT.md` — update liburing mentions;
  document the ladder and `YO_IO_BACKEND`.
- `docs/en-US/STD_SYS_MODULE.md` + `docs/zh-CN/STD_SYS_MODULE.md` — same.
- `plans/reference/PORTABLE_C_DISTRIBUTION.md` — annotate the liburing-trap sections as
  superseded by this plan (they document a prerequisite that Phase 1 removes).

### Phase 3 — release N ships; the seed bumps

Nothing manual beyond the standing release curation. Release N (≥ v0.2.44) is the first
built from Phases 1–2 (and 5–6 if they land in the same window — preferred, so the
Docker story ships complete; slipping them to N+1 is acceptable and changes nothing
about Phase 4's gate). Its bundles and portable-C artifacts are liburing-free. The
Release workflow's `SEED_VERSION` bump pins CI to N. Watch the develop battery go green
with the liburing installs still in place (they are now harmless), in particular the
musl leg and the fixpoint gates.

### Phase 4 — the cleanup wave (gated on `SEED_VERSION` ≥ N)

One mechanical PR, deletions only. Until this lands, everything below still needs
liburing **to run the seed** (old bundles are dynamically linked) or **to link
seed-emitted C** (`build-stage1`'s `stage1.c` is emitted by the seed's
`runtime_io_linux.yo`, not ours) — see §5.

- `.github/actions/build-stage1/action.yml` — remove `liburing-dev` from the apt
  install (:47–66) and `-luring` from the clang line (:141).
- `.github/workflows/release.yml` — remove the "Install liburing (needed to run the
  seed)" steps and their comments (~:568, ~:1001–1006).
- `.github/workflows/test.yml` (musl leg), `fixpoint-arm64.yml`, `install-scripts.yml`,
  `deploy-site.yml` — delete every remaining `liburing` reference (grep at execution
  time; the list is whatever `grep -rn liburing .github/` says then).
- `scripts/install.sh` — remove liburing from `_pkglist` and every distro package
  name (:157–172, :376–429), `check_liburing_consistency` (:484–500), the `uring_libs`
  block (:769–790).
- `scripts/make-portable-c.sh` — drop the "install liburing headers" directive (:67).
- Check `tests/cli-cases/` goldens for install-script output changes (none reference
  liburing today; re-record with `--record` only if a fixture actually changes).

### Phase 5 — the epoll fallback backend (the ladder's middle rung)

Motivation: the companion issue's environments — Docker's default seccomp (ENOSYS),
gVisor, hardened kernels (EPERM), RLIMIT_MEMLOCK exhaustion (ENOMEM, the #934 class),
pre-5.6 kernels. Today all of them exit(1) at first I/O.

**Design: a port of the macOS backend, which already solved every problem this
fallback faces** (`src/codegen/async/runtime_io_macos.yo`):

- **Sockets/pipes/ttys** — try the nonblocking op inline; on `EAGAIN`, arm a pending op
  and park (`runtime_io_macos.yo:1279–1301` is the blueprint). Port the
  `__yo_io_pending_op_t` machine (op tag, future, fd/buf/size, allocation pool) from
  kqueue to epoll: `EVFILT_READ` → `EPOLLIN`, `EVFILT_WRITE` → `EPOLLOUT`, both
  **level-triggered** (kqueue's default — the retry loop is then trivially correct:
  on an event, retry the syscall; `EAGAIN` again just leaves the pending op armed).
  Completion does `EPOLL_CTL_DEL` and completes the future exactly as a CQE would
  (same post-completion hooks — the accepted-socket `O_NONBLOCK` fixup, the dgram
  address-length handoff).
- **connect** — nonblocking `connect` → `EINPROGRESS` → arm `EPOLLOUT` → on event,
  check `SO_ERROR` (the macOS `EVFILT_WRITE` equivalent). **accept** — `EAGAIN` → arm
  `EPOLLIN` → accept on event.
- **Regular files, and the no-readiness-op family** (`openat`, `statx`, `mkdirat`,
  `unlinkat`, `renameat`, `symlinkat`, `linkat`, `fsync`, `fdatasync`, `ftruncate`,
  `shutdown`, `setsockopt`/`getsockopt`, `socket`, `bind`, `listen`) — **synchronous
  completion in the future**, which is *exactly and deliberately* what macOS does today
  (`runtime_io_macos.yo:1270–1277`, "Regular files: synchronous pread (fast, backed by
  unified buffer cache)"; `openat` ditto at :1365). The fallback therefore does not
  invent semantics — it adopts the platform floor the project already ships. A C-level
  worker pool (libuv's answer) is the recorded stretch goal (§10), not Phase 5.
- **Timers** — the same timerfd, registered in the epoll set instead of a ring
  `POLL_ADD`; the timer section of `runtime_io_common.yo` gains an epoll arm.
- **The loop wait** — `epoll_wait` replaces `io_uring_wait_cqe`. The current
  `!__yo_io_initialized` branch in `__yo_io_wait` (which `poll()`s the eventfd and
  `nanosleep`s for watch-only loops) is *replaced by* this backend's wait, not kept
  beside it: the notify eventfd is `epoll_ctl`-registered, timerfds are registered,
  so one blocking wait covers wakes, timers and I/O.
- **Selection** — the §3.6 ladder: ring → epoll → errno-futures; `YO_IO_BACKEND`;
  one-line fallback log; forced-and-failing is a hard error.

Files: `runtime_io_linux.yo` (the epoll section sits beside the vendored ring layer —
both backends always compiled, one TU, selected per thread), `runtime_io_common.yo`
(timer epoll arm), the companion issue (fix direction rewritten to the ladder; the
Docker reproducer becomes the acceptance test — the program must COMPLETE on the
fallback), `std/sys/timer.yo` doc comment.

Gates:

- **Forced-epoll corpus**: `YO_IO_BACKEND=epoll yo test` over `tests/async_await`,
  `tests/async/`, `tests/io/`, `tests/net/`, `tests/thread.test.yo`,
  `tests/cross_thread_wake.test.yo`, `tests/spawn_blocking.test.yo` — all green
  (`--parallel 1` per house rules for the heavy ones).
- `bash scripts/tsan-thread-corpus.sh` under `YO_IO_BACKEND=epoll`.
- **Docker acceptance leg** (new CI job, `container: ubuntu:24.04` — default seccomp
  applies): compile a small async program (socket + file + sleep), run it in the
  container, assert rc=0, correct output, and the one-line fallback log on stderr.
  This is the end-to-end proof of the companion issue. **New CI job ⇒ add it to branch
  protection's required-check list by hand** (the list is manual).
- The default-backend fast suite unchanged (the ring path is what 99% of machines run).

### Phase 6 — performance guarantees

Four guarantees, each with a named enforcement mechanism:

- **G1 — zero primary-path regression (hard gate).** The Phase-1 emit-diff rule,
  extended: with the ladder in place, the emitted C for every ring op must be identical
  to the Phase-1 state modulo the one-line backend branch per op-start and the ladder
  in `__yo_io_init` — the ring path executes the same instructions. Plus an A/B
  benchmark run (develop-built vs branch-built `yo`, same box, `--optimize 2`): all
  benchmarks within noise. The suite: TCP echo throughput, UDP round-trip, file
  read/write loop, timer churn (`sleep(1ms)` × N), accept/close churn.
- **G2 — fallback floors + ratchet (merge criterion for Phase 5; local/release-check
  thereafter).** NEW `scripts/bench-io-backends.sh` + benchmark programs (runnable
  `.yo` sources under `scripts/bench/`): runs the suite under `YO_IO_BACKEND=epoll`
  and `=uring` on one box, prints the ratio table for the PR body, and ratchets. The
  ratchet file records the merged floors and only tightens (the
  `hollow_sweep69`/`known-failing.tsv` precedent). Initial floors, deliberately
  conservative: socket echo throughput ≥ 50% of ring; UDP round-trip ≥ 50%; timer
  churn ≥ 90% (both backends wait on the same timerfd); file ops = macOS parity by
  construction (sync-completion both). Not a hard CI gate — shared-runner wall-clock
  variance would make it flaky; it is a merge criterion and a release-check step.
- **G3 — deterministic syscall and behavior budgets (hard CI gate).** The honest
  "guarantee performance" a shared runner can actually enforce. The runtime gains
  optional counters (`#ifdef __YO_IO_STATS`: thread-local per-class syscall counters +
  a loop-tick counter, near-zero cost, off by default), and NEW internal tests assert:
  (a) an N-message TCP echo exchange makes ≤ `4N + c` entering syscalls under epoll
  and ≤ `3N + c` under ring (constants fixed in the test; batching preserved, no
  syscall storms); (b) a loop with one pending socket and no watches performs **zero
  loop ticks in a 200 ms window** — it is blocked in `epoll_wait`/`io_uring_wait`, so
  the DEFER_TASKRUN spin class
  (`issues/fixed/io-uring-defer-taskrun-poll-never-enters-kernel.md`) can never recur
  silently on either backend; (c) a run of N timer ticks performs ≤ `N + c` waits (the
  10 ms-nanosleep tick stays quarantined to poll/fs_event watch loops, where it
  belongs).
- **G4 — explicit selection and observability.** `YO_IO_BACKEND` documented; the
  fallback never silent (one log line naming the errno and, for ENOSYS, Docker's
  default profile); forced-and-failing is a loud error. A user can always answer
  "which backend am I on?" without a debugger.

## 5. Sequencing: the seed lag, and why Phases 3–4 exist

Seeds emit their own runtime: a change to `runtime_io_linux.yo` on develop changes what
**develop-built yo** emits, never what the seed emits. Every liburing consumer is keyed
to one of three unblock points:

| Consumer | Needs liburing because | Unblocked at |
| --- | --- | --- |
| develop-built `yo`, and user programs it compiles | — (emitted C self-contained; Phases 1 and 5 both live entirely in emitted C) | Phase 1 / 5 |
| CI runners **running** the seed / published bundles | `liburing.so.2` is `DT_NEEDED` of every pre-N bundle | seed = N |
| `build-stage1` linking `stage1.c` with `-luring` | `stage1.c` is **seed**-emitted | seed = N |
| `install.sh` seed bootstrap / `--from-source` yo.c | same `DT_NEEDED` / pre-N portable C | release N artifacts |

Deleting Phase 4's sites before the seed bump re-breaks CI in exactly the shapes of
`issues/fixed/musl-job-seed-needs-host-liburing.md` and
`issues/fixed/installer-source-build-never-links-liburing.md`. The two REQUIRED CI check
names containing "yo-self" are untouched throughout. Phase 5's new jobs (forced-epoll
corpus, Docker leg) and Phase 6's budget tests key on **develop-built** binaries and can
land as soon as their code does — no seed lag for them, but every new job must be added
to branch protection by hand.

## 6. Verification matrix

| Gate | Phase 1 | Phase 5 | Phase 6 | Phase 4 |
| --- | --- | --- | --- | --- |
| `yo check ./src` first | ✔ | ✔ | ✔ | — |
| `yo compile src/main.yo --skip-c-compiler` | ✔ | ✔ | ✔ | — |
| Fast suite `yo test ./tests --exclude tests/internal --exclude tests/cli-cases --bail` | ✔ | ✔ | ✔ | ✔ |
| `yo test ./std --bail` | ✔ | ✔ | — | — |
| `yo test ./tests/internal/uring_runtime.test.yo --parallel 1` (new), one file at a time | ✔ | ✔ (budget tests too) | ✔ | — |
| Forced-epoll corpus (`YO_IO_BACKEND=epoll`: async/io/net/thread legs) | — | ✔ | ✔ | — |
| **Emit-diff**: compile three probes (a TCP echo test, a fs walker test, the timer test) with `--emit-c --skip-c-compiler` before/after; the diff outside the two runtime strings must be EMPTY; in Phase 5 additionally identical ring-op C modulo the backend branch | ✔ | ✔ | ✔ | — |
| **Link check**: compiled binary has no undefined `io_uring_*` (`nm -u`), no `liburing` in `ldd` | ✔ | ✔ | — | ✔ (the `yo` binary itself) |
| `bash scripts/tsan-thread-corpus.sh` (default and forced-epoll) | ✔ | ✔ | — | — |
| Docker acceptance leg (container, default seccomp, fallback completes the program) | — | ✔ | ✔ | — |
| `S1=/tmp/yo-s1 P=local bash scripts/bootstrap/gates_fast.sh` and `fixpoint_only.sh` | ✔ | ✔ | ✔ | ✔ |
| `hollow_sweep69.sh` ratchet | ✔ | ✔ | ✔ | ✔ |
| `scripts/bench-io-backends.sh` ratio table + ratchet check | — | ✔ (merge criterion) | ✔ | — |
| test.yml's musl leg (PR CI) | ✔ | ✔ | ✔ | ✔ (green **without** the liburing install only after seed = N) |
| `scripts/check-issue-refs.sh` on the merge result | Phase 0 | ✔ | ✔ | ✔ |

## 7. Measurements to record in the Phase 1 and Phase 5/6 PR bodies

Phase 1:

- `ldd yo-out/<target>/bin/yo` before/after (the `liburing.so.2` line disappears).
- Undefined-symbol count of a compiled user binary before/after.
- `stage1.c` line/size delta (expect the runtime C string to grow ~400–450 lines).
- Fast-suite wall time before/after (expect noise).
- Self-build (`yo build`) time before/after (expect noise).

Phase 5/6 (the `bench-io-backends.sh` table, same box, `--optimize 2`):

| Benchmark | ring | epoll | ratio | floor |
| --- | --- | --- | --- | --- |
| TCP echo throughput (loopback, msgs/s) | | | | ≥ 50% |
| UDP round-trip (µs) | | | | ≥ 50% |
| File read/write loop (MB/s) | | | | macOS-parity note |
| Timer churn (`sleep(1ms)` × 100k, s) | | | | ≥ 90% |
| Accept/close churn (conns/s) | | | | ≥ 50% |
| G3 syscall budgets (echo 4N+c / 3N+c; zero-tick; N+c waits) | | | | exact, CI-enforced |

Plus the one-branch cost check: G1 A/B of the ring path develop-vs-branch, all
benchmarks within noise.

## 8. Risks and mitigations

- **Memory-ordering bugs** (the real risk of vendoring; it is the one thing liburing did
  for us). Mitigation: the protocol is the four-line table in §3.3, single-issuer and
  single-threaded per ring; C11 acquire/release everywhere a ring index changes owner;
  the tsan corpus and `cross_thread_wake`/`thread`/`spawn_blocking` stress tests; the
  emit-diff gate guarantees nothing else moved.
- **UAPI drift.** io_uring UAPI is append-only and stable since 5.1; new features arrive
  as new opcodes/flag bits we do not define until used. Vendored structs are a frozen
  copy, reviewed against `include/uapi/linux/io_uring.h` once.
- **Old-kernel behavior is CI-invisible** (runners are modern Ubuntu). Mitigated by
  Phase 5: the Docker leg exercises the no-io_uring path for real, and the
  forced-epoll corpus exercises the fallback on every PR.
- **musl / `zig cc` compat**: the layer uses `syscall()`, `<sys/syscall.h>`,
  `<stdint.h>`, `mmap` — all already used elsewhere in the emitted C or strictly weaker
  than what liburing itself required. The musl PR leg covers it. The epoll fallback is
  plain libc on top.
- **Emit growth**: ~+400 lines of vendored ring C and ~+700 lines of epoll backend C
  per program, one-time; chunked emission (`--emit-chunks`) unaffected.
- **Epoll-specific: level-triggered retry fairness.** A always-ready socket retried in
  a tight loop could starve the loop. Mitigation: the pending-op machine processes one
  op per event like the macOS backend does, and the loop's task-drain pass interleaves;
  G3's zero-tick and syscall budgets would catch a spin immediately.
- **Epoll-specific: sync-completed file ops can stall the loop on a cold file.** True —
  and identical to macOS today (`runtime_io_macos.yo:1270–1277`); the fallback inherits
  the existing platform floor rather than inventing a worse one. The worker-pool
  upgrade is recorded as a stretch goal (§10) to be justified by measurement, not
  pre-built.
- **Two Linux backends = doubled surface.** Mitigation: the epoll side is a port of a
  shipped design, not a new one; the forced-epoll corpus runs on every PR; the ladder's
  default path is unchanged.
- **Benchmark variance on shared runners.** Why G2 is a merge criterion/ratchet and not
  a CI gate, and why G3's budgets are deterministic counts, not wall-clock.

## 9. Rejected alternatives

1. **Keep liburing, static-link `liburing.a` into bundles.** Fixes only the exit-127
   class; keeps the header/pkg-config traps, the TSan blindness, the version-skew class,
   and the portable-C header requirement. Pays the audit's full tax to avoid owning ~400
   lines.
2. **epoll-based runtime as the primary (drop io_uring).** epoll is readiness-based:
   async `openat`/`statx`/`fsync`/`renameat` would need a thread pool; the runtime's
   CQE shape (16 non-poll ops) would be a rewrite, not a refactor. Rejected **as the
   primary** — and Phase 5 adopts epoll exactly where it belongs: underneath, for the
   environments where io_uring cannot exist (the role it plays under libuv and in Go's
   world).
3. **Vendor liburing's source and build it.** Keeps a second codebase and build step for
   a library ~10× our needed surface (SQPOLL, registered files/buffers, buffer rings,
   personalities). We need the thin core only.
4. **A C-level worker pool for file ops in the epoll fallback (Phase 5).** libuv's
   answer, and the right one if measurements of real fallback workloads show loop
   stalls mattering. Rejected for Phase 5 because the macOS backend already ships
   sync-completion semantics (`runtime_io_macos.yo:1270`) — the fallback should match
   the platform floor, and adding pool machinery (task queue, lifetimes, shutdown)
   before evidence would double the new surface for no proven need. Recorded as the
   stretch goal in §10.

## 10. Non-goals and stretch goals

Non-goals: performance work on the ring path (deferred-submission batching semantics are
measured, not redesigned); adopting registered buffers, multishot accept, zero-copy
send, SQPOLL, or ring-embedded wakers; wasm/macOS/Windows backends; the parallelism
runtime (spawn_blocking uses no ring); per-op dynamic backend switching (the backend is
chosen once per thread); wall-clock performance gates in CI (G3 counts, not clocks).

Stretch goal (post-Phase-6, evidence-gated): a C-level worker pool for file ops on the
epoll fallback, closing the cold-file loop-stall gap with macOS-parity as the baseline
to beat.

## 11. Lifecycle

Phases 1+2 land → this doc tracks the campaign with per-phase "Landed" notes (the
TYPE_SYSTEM_SOUNDNESS.md pattern). Phase 5+6 land with the §7 tables filled in. When
Phase 4 lands, add the closing banner with the measured outcomes and `git mv` to
`reference/` — the landed design "the Linux async runtime is self-contained, with an
epoll fallback" stays authoritative, superseding the liburing-trap sections of
`PORTABLE_C_DISTRIBUTION.md`. Phase 5 closes the companion issue (moved to `fixed/`
with the Docker acceptance leg as its regression test). Update `plans/README.md` and
every `grep -rn "DROP_LIBURING.md"` reference at each move.
