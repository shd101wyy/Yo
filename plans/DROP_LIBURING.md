# Drop the liburing dependency — vendor the io_uring ring layer

**Status:** ACTIVE — proposed 2026-09-26. Phase 0 is this document plus its companion
issue (`issues/io-uring-init-failure-exits-the-process.md`); Phases 1–5 are open. This is
both the decision record and the implementation plan. Seed at writing: `v0.2.43`
(`.github/workflows/release.yml`); the first liburing-free release is therefore
**≥ v0.2.44** and is referred to below as *release N*.

## 1. The decision

**Keep io_uring (the kernel interface). Drop liburing (the library).**

The Linux async runtime already *is* our own runtime — futures, deferred submission
batching, the eventfd wake channel, cancellation by type-tagged `cancel_fn`, timerfd
timers. liburing supplies only the thin ring plumbing under it: ring setup/mmap, `get_sqe`
index math, `submit`/`enter`, and CQ peek/wait. That is ~10 linked functions plus header
inlines, replaceable by roughly 400 lines of pure C11 emitted inline. The macOS backend
(`runtime_io_macos.yo`, 2,057 lines) and the Windows backend (`runtime_io_windows.yo`,
4,914 lines) are already hand-rolled syscall-level runtimes with no third-party library;
after this plan the Linux backend joins them.

io_uring itself is not on trial here: it is what makes async `openat`/`statx`/`fsync`/
`renameat` possible at all (epoll is a readiness API and cannot express them), and the
runtime's op set, batching and wake design are unchanged. The audit (§2) found that every
historical failure blamed on "the async runtime" was in fact a failure of **packaging the
library** — dynamic `DT_NEEDED`, header/pkg-config skew, sanitizer blindness — which is
exactly the part vendoring removes.

Precedent: libuv implemented io_uring support the same way (direct
`io_uring_setup`/`io_uring_enter` syscalls, no liburing dependency) precisely so the
dependency does not land in every downstream binary — Node ships it to millions of
machines. We emit C into every user program; the same argument applies to us twice over.

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
  kernel-exploit bounties targeted it. This does **not** argue against liburing vs DIY
  (it is io_uring itself); it argues for the graceful-degradation fix of Phase 5, filed
  as the companion issue.
- **Go declined io_uring for its netpoller** (golang/go#31908, open since 2019) partly
  for these sandbox reasons; Go's answer was to keep epoll. Yo's runtime is CQE-shaped,
  so our answer is io_uring plus degradation, not epoll.
- **libuv** (Node): direct syscalls, no liburing, runtime detection, fallback. The model
  this plan follows.

## 3. Target design

### 3.1 Namespace

All vendored symbols are namespaced — `__yo_uring_*` functions,
`__YO_IORING_*`/`__YO_NR_*` constants, `struct __yo_uring_sqe/cqe/params/ring` — so the
emitted translation unit can never collide with user C interop that itself includes
`<liburing.h>`, and the `__yo_` prefix stays filtered out of `yo doc` output.

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
  `<stdint.h>` only: compatible with clang, gcc and `zig cc`, glibc and musl.

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
  becomes what it always should have been: a kernel-capability question (Phase 5 gives
  it a real answer).
- The sleep stub's `-ENOSYS` degrade arm — subsumed by Phase 5's general degrade.
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
guaranteed kernel support; now the failure is honest and in one place.

## 4. Phases

### Phase 0 — this PR

This document, the `plans/README.md` index line, and
`issues/io-uring-init-failure-exits-the-process.md`. Docs-only.

### Phase 1 — vendor the ring layer in the emitted Linux runtime

The compiler change. One PR; behavior-preserving by construction (the emit-diff gate in
§6 enforces it outside the two runtime strings).

Files:

- `src/codegen/async/runtime_io_linux.yo` — insert the vendored layer (UAPI structs,
  constants, ring struct, the ~10 functions, prep helpers; pure C, no interpolations,
  per the file's header comment) at the top of the async section; delete the
  `__has_include`/`#else` structure including the whole stub arm; rename all
  `io_uring_*` references to `__yo_uring_*`; retarget the TSan shims. `__yo_io_init`'s
  `exit(1)` on failure **stays this phase** — degradation is Phase 5, and this phase
  must not change kernel-failure behavior.
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
  pkg-config-for-liburing from prerequisites; state the kernel ≥ 5.6 floor.
- `docs/en-US/ASYNC_AWAIT.md` + `docs/zh-CN/ASYNC_AWAIT.md` — update liburing mentions.
- `docs/en-US/STD_SYS_MODULE.md` + `docs/zh-CN/STD_SYS_MODULE.md` — same.
- `plans/reference/PORTABLE_C_DISTRIBUTION.md` — annotate the liburing-trap sections as
  superseded by this plan (they document a prerequisite that Phase 1 removes).

### Phase 3 — release N ships; the seed bumps

Nothing manual beyond the standing release curation. Release N (≥ v0.2.44) is the first
built from Phase 1+2: its bundles and portable-C artifacts are liburing-free. The
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

### Phase 5 — graceful degradation (follow-up PR; the companion issue)

`__yo_io_init` failure stops being `exit(1)`. Record the init errno once
(thread-local); every `__yo_async_*_start` then returns an already-completed future
carrying that errno — the degrade shape `std/sys/timer.yo`'s sleep stub has always
documented, generalized to the whole op set — with one clear diagnostic line naming the
errno and its likely cause (ENOSYS → kernel < 5.6 or seccomp-blocked, naming Docker's
default profile; EPERM → hardened/sandboxed kernel; ENOMEM → RLIMIT_MEMLOCK, pointing
at `issues/fixed/every-thread-creates-an-io-uring-ring-and-thread-churn-runs-out-of-memory.md`).
An epoll/poll-based degraded backend for blocked environments is explicitly NOT in
scope (§10).

## 5. Sequencing: the seed lag, and why Phases 3–4 exist

Seeds emit their own runtime: a change to `runtime_io_linux.yo` on develop changes what
**develop-built yo** emits, never what the seed emits. Every liburing consumer is keyed
to one of three unblock points:

| Consumer | Needs liburing because | Unblocked at |
| --- | --- | --- |
| develop-built `yo`, and user programs it compiles | — (emitted C self-contained) | Phase 1 |
| CI runners **running** the seed / published bundles | `liburing.so.2` is `DT_NEEDED` of every pre-N bundle | seed = N |
| `build-stage1` linking `stage1.c` with `-luring` | `stage1.c` is **seed**-emitted | seed = N |
| `install.sh` seed bootstrap / `--from-source` yo.c | same `DT_NEEDED` / pre-N portable C | release N artifacts |

Deleting Phase 4's sites before the seed bump re-breaks CI in exactly the shapes of
`issues/fixed/musl-job-seed-needs-host-liburing.md` and
`issues/fixed/installer-source-build-never-links-liburing.md`. The two REQUIRED CI check
names containing "yo-self" are untouched throughout.

## 6. Verification matrix

| Gate | Phase 1 | Phase 4 |
| --- | --- | --- |
| `yo check ./src` first | ✔ | — |
| `yo compile src/main.yo --skip-c-compiler` | ✔ | — |
| Fast suite `yo test ./tests --exclude tests/internal --exclude tests/cli-cases --bail` | ✔ | ✔ |
| `yo test ./std --bail` | ✔ | — |
| `yo test ./tests/internal/uring_runtime.test.yo --parallel 1` (new), one file at a time | ✔ | — |
| **Emit-diff**: compile three probes (a TCP echo test, a fs walker test, the timer test) with `--emit-c --skip-c-compiler` before/after; the diff outside the two runtime strings must be EMPTY | ✔ | — |
| **Link check**: compiled binary has no undefined `io_uring_*` (`nm -u`), no `liburing` in `ldd` | ✔ | ✔ (the `yo` binary itself) |
| `bash scripts/tsan-thread-corpus.sh` | ✔ | — |
| `S1=/tmp/yo-s1 P=local bash scripts/bootstrap/gates_fast.sh` and `fixpoint_only.sh` | ✔ | ✔ |
| `hollow_sweep69.sh` ratchet | ✔ | ✔ |
| test.yml's musl leg (PR CI) | ✔ | ✔ (green **without** the liburing install only after seed = N) |
| `scripts/check-issue-refs.sh` on the merge result | Phase 0 | — |

## 7. Measurements to record in the Phase 1 PR body

- `ldd yo-out/<target>/bin/yo` before/after (the `liburing.so.2` line disappears).
- Undefined-symbol count of a compiled user binary before/after.
- `stage1.c` line/size delta (expect the runtime C string to grow ~400–450 lines).
- Fast-suite wall time before/after (expect noise).
- Self-build (`yo build`) time before/after (expect noise).

## 8. Risks and mitigations

- **Memory-ordering bugs** (the real risk; it is the one thing liburing did for us).
  Mitigation: the protocol is the four-line table in §3.3, single-issuer and
  single-threaded per ring; C11 acquire/release everywhere a ring index changes owner;
  the tsan corpus and `cross_thread_wake`/`thread`/`spawn_blocking` stress tests; the
  emit-diff gate guarantees nothing else moved.
- **UAPI drift.** io_uring UAPI is append-only and stable since 5.1; new features arrive
  as new opcodes/flag bits we do not define until used. Vendored structs are a frozen
  copy, reviewed against `include/uapi/linux/io_uring.h` once.
- **Old-kernel behavior is CI-invisible** (runners are modern Ubuntu). The flag-retry
  path is preserved verbatim; floors are documented (§3.5) and the failure mode after
  Phase 5 is an errno, not a death.
- **musl / `zig cc` compat**: the layer uses `syscall()`, `<sys/syscall.h>`,
  `<stdint.h>`, `mmap` — all already used elsewhere in the emitted C or strictly weaker
  than what liburing itself required. The musl PR leg covers it.
- **Emit growth**: ~+400 lines of emitted C per program, one-time; chunked emission
  (`--emit-chunks`) unaffected.

## 9. Rejected alternatives

1. **Keep liburing, static-link `liburing.a` into bundles.** Fixes only the exit-127
   class; keeps the header/pkg-config traps, the TSan blindness, the version-skew class,
   and the portable-C header requirement. Pays the audit's full tax to avoid owning ~400
   lines.
2. **epoll-based runtime (drop io_uring).** epoll is readiness-based: async
   `openat`/`statx`/`fsync`/`renameat` would need a thread pool; the runtime's CQE shape
   (16 non-poll ops) would be a rewrite, not a refactor. Go's epoll answer fits Go's
   goroutine netpoller, not our op-based runtime. A *fallback* remains possible after
   Phase 5 if users actually hit blocked environments.
3. **Vendor liburing's source and build it.** Keeps a second codebase and build step for
   a library ~10× our needed surface (SQPOLL, registered files/buffers, buffer rings,
   personalities). We need the thin core only.

## 10. Non-goals

Performance work (deferred-submission batching semantics are measured, not redesigned);
adopting registered buffers, multishot accept, zero-copy send, SQPOLL, or ring-embedded
wakers; wasm/macOS/Windows backends; the parallelism runtime (spawn_blocking uses no
ring); an epoll fallback (post-Phase-5 material only, and only on evidence).

## 11. Lifecycle

Phase 1+2 land → this doc tracks the campaign with per-phase "Landed" notes (the
TYPE_SYSTEM_SOUNDNESS.md pattern). When Phase 4 lands, add the closing banner with the
measured outcomes (§7) and `git mv` to `reference/` — the landed design "the Linux async
runtime is self-contained" stays authoritative, superseding the liburing-trap sections of
`PORTABLE_C_DISTRIBUTION.md`. Phase 5 closes the companion issue and moves it to
`fixed/` with its regression test. Update `plans/README.md` and every
`grep -rn "DROP_LIBURING.md"` reference at each move.
