# No libc by default: a Yo program links nothing it did not bring

**Status: BACKLOG — audit + design, written 2026-10-22 at the maintainer's
request.** The goal is Zig's default, not Zig's escape hatch: a program
compiled for a hosted Linux target links **no libc** unless it asks to
(`--libc`), makes raw syscalls through an emitted OS seam, owns its
startup code, allocator, formatting, math and DNS, and still runs the full
language — `io.async` included — on the real kernel. This document audits
every libc dependency the pipeline has today, answers the first design
question asked of it (§2: does the async runtime have to move out? — no),
decides the design space (§3), and lays out the phases with gates (§4).

**It assumes the
[`VALUES_BY_DEFAULT`](../VALUES_BY_DEFAULT.md) campaign is FINISHED** — the
end-state language (values by default, unique ownership, `Rc`/`Arc`, `Weak`
per decision 48, references with origins, `Drop`, explicit `.clone()`) is
the baseline this plan builds on, and every Yo snippet below is post-VBD
spelling. Nothing in this plan should start before that: decision 48
deletes the cycle collector, and porting the collector's C to a new OS seam
only to delete it one release later is wasted motion.

Companion reading: [`ZIG_ADOPTION_CANDIDATES.md`](ZIG_ADOPTION_CANDIDATES.md)
§0 (what Yo already shares with Zig — `zig cc` cross-compilation is listed
there as landed); [`FIXED_REGION_ALLOCATOR.md`](../reference/FIXED_REGION_ALLOCATOR.md)
("the first building block of an embedded/freestanding story", §6 there);
[`THREAD_LOCAL_STORAGE.md`](../reference/THREAD_LOCAL_STORAGE.md) (the TLS
contract phase P5 extends to a libc-free startup);
[`TARGET_TRIPLES.md`](../reference/TARGET_TRIPLES.md) (the vocabulary D1
does not touch).

## 0. What "like Zig" means, precisely

Zig's headline is not "can target freestanding"; it is that **hosted Linux
binaries link no libc by default**:

| Zig behaviour | Detail |
| --- | --- |
| No libc by default on Linux/Windows | `zig build-exe hello.zig` produces a static ELF that issues raw syscalls (inline-asm syscall wrappers per arch in `std.os.linux`); `ldd` reports "not a dynamic executable" and `nm` shows no libc symbols. |
| libc is an opt-in | `-lc` links libc (Zig builds it from bundled sources: musl, glibc stubs, mingw-w64); importing a C library pulls it in automatically. |
| The std is dual-mode | Every OS-facing std function has two bodies — raw syscall and libc call — selected at compile time on `builtin.link_libc`. |
| The runtime is owned | `std.start` is the crt (auxv parse, TLS block init, stack probing); compiler-rt, `memcpy`/`memset`, math (musl-derived), float printing and parsing, and a DNS client are all in std. |
| macOS is the exception | libSystem is always linked — Apple does not commit to the raw syscall ABI. Zig accepts this; so does this plan (D8). |

Yo wants the first four rows. The fifth is a concession, not a failure.

## 1. The audit: where Yo depends on libc today

Verified on the 2026-10-22 tree (develop `95162303d`) by grep and
measurement; a claim marked *(verify)* was not run to ground. The
dependency has four layers plus startup; they are separable, and §2 builds
on that.

### 1.1 Layer A — the emitted runtime C (`src/codegen/**`)

The runtime templates are already target-selected at emit time
([`TARGET_AWARE_CODEGEN.md`](../archive/TARGET_AWARE_CODEGEN.md): one
platform's runtime per compile) and already self-vendor the hard parts —
the io_uring ring layer (`DROP_LIBURING.md`), the TLSF fixed allocator,
RC/GC. What they still take from libc:

| Dependency | Sites | Notes |
| --- | --- | --- |
| The syscall trampoline | 6 `syscall(...)` calls in `async/runtime_io_linux.yo`, 2 in `async/runtime_io_common.yo` | The io_uring layer already speaks raw `__NR_*` numbers (`__NR_io_uring_setup` 425 etc. with `#ifndef` fallbacks); only the variadic libc `syscall()` function and the TLS `errno` it reports through are libc. |
| `errno` | 10 files under `src/codegen/` | A TLS variable libc owns. |
| Synchronous metadata ops | `async/runtime_io_common.yo`, `runtime_io_linux.yo`: `openat`/`open`, `read`, `write`, `pread`/`pwrite`, `fstat`/`stat`/`lstat`, `unlink`, `mkdir`, `rename`, `fsync`, `ftruncate`, `getdents` via `dirent.h`, `fcntl`, `ioctl`, `isatty`, `termios`, `umask`, `chmod`, `symlink`/`readlink`, `statvfs`, `inotify`, `eventfd`, `signalfd` | ~40 call sites; every one has a direct syscall (`statx`, `getdents64`, …). These are the ops the io_uring plan deliberately runs as plain syscalls. |
| Threads & startup | `functions/generation.yo:1691` — the main wrapper's big-stack thread is `pthread_attr_setstacksize` + `pthread_create` + `pthread_join`; `parallelism/runtime.yo` (workers); `async/runtime_core.yo`, `types/generation.yo` (TLS keys, cleanup) | libc pthreads are on the startup path of **every** program, including single-threaded ones. |
| `getaddrinfo` | `async/runtime_io_common.yo` (2), `async/runtime_io_windows.yo` (2) | DNS; the one dependency that is a *service*, not a syscall (§1.2, D6). |
| Panic/trap printing | `fflush(stdout); fprintf(stderr, …)` woven through every guard in `c/collection.yo`, `__yo_abort`, `async/runtime_core.yo` | ~25 files reference `abort`. All replaceable with a raw `write(2)` and a mini formatter. |
| `snprintf` | `c/collection.yo`, `async/runtime_io_*`, `exprs/ptr_fns.yo`, `c/allocator_fixed.yo` | Runtime-internal formatting (error strings, sizes). |
| Time | `clock_gettime`, `nanosleep` in the three native I/O runtimes + `types/generation.yo` | Direct syscalls exist (`clock_gettime` vDSO-less form, `clock_nanosleep`). |
| Allocator | `--allocator system` (the default) binds `__yo_malloc` to libc `malloc`/`free` via `stdlib.h` | The default allocator IS libc. `--allocator fixed` already needs none; mimalloc needs `mmap` and threads *(verify: its prim layer's exact surface)*. |
| Atomics/compiler-rt | The RC runtime uses C11/`__atomic_`/`__sync_` intrinsics (`functions/declarations.yo:913` special-cases their names) | On x86_64/aarch64 the sizes Yo emits are lock-free inline ops; whether any corpus site still links `libatomic`/compiler-rt symbols under `-nostdlib` is a P0 audit item. The C compiler also emits `memcpy`/`memset` calls it is always free to emit — freestanding C must provide them. |

Header inventory across `src/codegen/**` (site counts): `unistd.h` 7,
`fcntl.h` 7, `time.h` 6, `sys/socket.h` 6, `arpa/inet.h` 6, `errno.h` 5,
`sys/stat.h` 5, `string.h` 4, `sys/syscall.h` 3, plus singles (`stdio.h`,
`stdlib.h`, `signal.h`, `poll.h`, `termios.h`, `dirent.h`, `sys/mman.h`,
`netdb.h`, …). Windows templates include Win32 headers (not CRT) plus the
CRT for printf-family/malloc; wasm templates assume wasi-libc / Emscripten.

### 1.2 Layer B — std/ (`std/libc/**` and its importers)

`std/libc/` is 21 modules of `c_include` bindings (`stdio`, `stdlib`,
`string`, `math`, `time`, `errno`, `fcntl`, `unistd`, `signal`, `dirent`,
`ctype`, `float`, `limits`, `stdint`, `stdatomic`, `wctype`, `sys/…`,
`windows`, `darwin`, `dyld`). **~20 std modules import them** — this is the
widest layer, and the one that makes "just delete libc" impossible today:
`fmt`, `string`, `log`, `math`, `time/datetime`, `env`, `fs/file`,
`fs/dir`, `fs/temp`, `process`, `sync/once`, `sync/atomic`, `arena`,
`testing/bench`, `sys/errors`, and the collections' test files.

The load-bearing members:

- **Number formatting is libc's.** Every `to_string()` goes through
  `_snprintf_to_string` (`std/fmt/to_string.yo:85`), floats via `%g` —
  whose non-portability the file's own header documents ("`f64`/`f32`
  `to_string()` is not yet portable: it hands back the host C library's
  `%g` output", `to_string.yo:25`). Owning this is a fix the tree already
  wants, independent of this campaign.
- **Float parsing is libc's.** `strtod` (`std/libc/stdlib.yo:74`) backs
  string→float.
- **Math is a libm veneer.** `std/math.yo:56` — `sqrt : _c_sqrt`,
  `floor : _c_floor`, `pow : _c_pow`, … — and `-lm` sits on every POSIX
  link line (`src/main.yo:7880`).
- **DNS is `getaddrinfo`** (Layer A's sites back it).
- **The calendar is libc's** — `std/time/datetime.yo` via `std/libc/time`
  (`gmtime`-family; timezone data is a libc/NSS service).
- Already syscall-shaped: `std/crypto/random.yo` binds Linux `getrandom`
  (syscall 318 — no libc needed), `arc4random_buf` on macOS, `BCryptGenRandom` on Windows.

### 1.3 Layer C — the driver and the link line

`-lm -pthread` on every POSIX link (`src/main.yo:7749`, `:7880`); the
system allocator default; sanitizer runtimes (ASan/LSan/TSan intercept
libc and need it to exist); static-musl release bundles (libc statically
included). Cross-emission is host-independent, so none of this constrains
codegen — only the final C compile and link.

### 1.4 Layer D — startup

The C compiler's crt provides `_start`, TLS initialization and `errno`;
Yo's main wrapper then re-enters libc pthreads for the 1 GiB main stack
(`functions/generation.yo:1691`, `YO_MAIN_STACK_MB`). Without libc, Yo owns
all three.

### 1.5 Measured baselines (2026-10-22, this repo, `yo` 0.2.68, zig 0.16.0)

| Build of a hello-world | Size | Notes |
| --- | --- | --- |
| Default (`--allocator system`, host clang) | 62 KB dynamic ELF | Requires host glibc at runtime. |
| Static musl (`zig cc -target x86_64-linux-musl`) | 1,380 KB static ELF | libc carried in every binary. |
| No-libc (this plan's P9 outcome) | goal ≤ ~150 KB static *(estimate)* | Runtime C + mimalloc + own fmt; measured at P0, not promised here. |

Also measured the same day: cross-compile through `--cc zig` works
end-to-end (aarch64-linux-musl static ELF and x86_64-windows-gnu PE from
an x86_64 Linux host) once Zig's own triple spellings are used — the
driver gap is one `zig_triple()` mapping; zig rejects
`aarch64-unknown-linux-musl`/`x86_64-w64-mingw32` (`UnknownOperatingSystem`).
A no-libc default makes that path simpler still: there is no libc for the
toolchain to vendor at all.

## 2. The first question: does the async runtime (or any runtime) move out?

**No. The runtime stays exactly where it is — emitted, target-selected C
inside every program. What changes is the floor under it.**

Three properties the tree already has make this true:

1. **Emission is target-selected, not host-selected**
   (TARGET_AWARE_CODEGEN): one platform's runtime per compile, chosen by
   `--target`. A no-libc mode is one more axis of the same choice, not a
   relocation.
2. **The hard parts are already vendored**: the io_uring ring layer is Yo's
   own C (no liburing), TLSF is Yo's own C, RC/GC are Yo's own C. None of
   it came from libc; none of it leaves.
3. **The libc seam is narrow and enumerable** — §1.1's table is the whole
   of it under the async runtime: the `syscall()` trampoline, `errno`, the
   ~40 synchronous metadata-op call sites, `clock_gettime`/`nanosleep`,
   pthreads, and panic printing. Each has a direct replacement through an
   emitted `__yo_os` layer (P0) — this is Zig's `std.os` shape: the async
   engine sits on an OS seam, and the seam has two implementations, raw
   syscall and libc, selected by the link mode.

What **does** move out of the default picture is not the runtime but the
libc *services* std consumes (§1.2): `snprintf` formatting, `strtod`
parsing, libm, `getaddrinfo`, pthreads, libc malloc, the glibc calendar.
Each is either replaced by an owned implementation (P1–P8) or opts the
artifact into `--libc` (D1). And `std/libc/` itself — the `c_include`
bindings — remains available unchanged in libc mode; in no-libc mode it is
the FFI surface D10 governs.

Concretely, per class of call site:

| Class | Today | Under no-libc | Phase |
| --- | --- | --- | --- |
| io_uring enter/setup/register | libc `syscall()` + `errno` | `__yo_os` inline-asm syscall + `__yo_errno` | P0/P4 |
| Metadata ops (open/stat/dirent/…) | libc wrappers | `__yo_os` direct syscalls (`statx`, `getdents64`, …) | P4 |
| Timers | `clock_gettime`, `nanosleep` | `clock_gettime`/`clock_nanosleep` syscalls | P4 |
| Main-thread big stack | `pthread_create`/`join` | own crt0 + `clone` with a sized stack + futex join | P5 |
| Parallelism workers/sync | pthreads | `clone`/`futex` | P6 |
| Allocation (default) | libc malloc | mimalloc over `__yo_os` pages | P1 |
| Panics/traps | `fprintf`/`fflush`/`abort` | raw `write` + own formatter + `__yo_os_exit` | P2 |
| `to_string`/parse | `snprintf`/`strtod` | own integer formatter, ryu float print, own float parse | P3 |
| Math | libm | vendored musl libm subset | P8 |
| DNS | `getaddrinfo` | own async resolver | P7 |
| Calendar/TZ | libc `gmtime`-family | own civil-calendar math (UTC default) | P8 |

The macOS runtimes keep libSystem entirely (D8); the Windows runtime's
CRT call sites (printf-family traps, malloc under system allocator) follow
the same replacements only if/when P10 opts Windows into CRT-less.

## 3. Design decisions

Each states the choice and a recommendation; the numbered open ones move
to `issues/questions/` when this plan starts.

**D1 — No-libc is a link mode, not a target triple.** The Rust-triple
vocabulary (`TARGET_TRIPLES.md`) is untouched; a linux triple's env word
(`gnu`/`musl`) keeps describing the ABI the binary interoperates with
*when libc is linked*. The mode is `yo compile --libc` (opt-in first as
`--no-libc`, flipping at P9) and `build.executable({ libc : true })`.
*Rejected:* a new env word (`x86_64-unknown-linux-none`) — it breaks the
no-aliases grammar, invents a triple no C toolchain understands, and makes
"link libc" a spelling problem instead of a link line.
*Recommendation:* link mode.

**D2 — The default allocator under no-libc.** libc malloc cannot be the
default once libc is gone. Candidates: (a) mimalloc over `__yo_os` page
allocation (already the Windows legs' flavor, already vendored, already
beaten glibc malloc in this repo's measurements); (b) `--allocator fixed`
(right allocator, wrong default — one static region sized at compile time
is an embedded answer, not a hosted one); (c) the `SmpAllocator` of
[`ZIG_STYLE_ALLOCATORS.md`](ZIG_STYLE_ALLOCATORS.md) A5 — whose go/no-go
explicitly names "a freestanding target that needs it" as its trigger.
*Recommendation:* mimalloc-backed default in no-libc mode from day one;
A5's go/no-go stays exactly where it is, and this campaign is its trigger
— if a Yo-written allocator wins on the compiler's own profile it can
replace mimalloc under the same seam. `fixed` remains the embedded choice
and needs nothing from libc at all.

**D3 — Sanitizers imply libc.** ASan/LSan/TSan runtimes intercept libc;
without libc there is nothing to intercept and no runtime to link.
*Recommendation:* `--sanitize address|thread|leak` (and `yo test` under
them) silently implies `--libc` and says so in the build log; UBSan's
runtime is toolchain-level and is audited in P0 *(verify: it links
no-libc)*. The `--allocator debug` leak oracle (ZIG_ADOPTION Z11) becomes
the no-libc mode's memory-safety instrument, which is an argument for
landing Z11 before P9.

**D4 — Own float print and parse, now.** Shortest-round-trip printing:
ryu `d2s`/`f2s` (MIT, ~small, the industry answer) plus an owned
fixed-precision exp/dec formatter for `{:.N}`-style output; parsing:
eisel-lemire-style fast path with a slow-path fallback (or vendored musl
`strtod`, MIT — one license, one supplier). This deletes the `%g`
portability bug (`to_string.yo:25`) rather than carrying it into a
libc-free world where there is no `%g` to delegate to. *Recommendation:*
ryu + own formatter, musl `strtod` vendored for parsing (correctness
first; eisel-lemire later as an optimization with differential gates).

**D5 — Vendor a musl libm subset.** `std/math.yo`'s `f64` surface binds
libm; musl's libm is MIT, already the reference implementation Zig derived
from, and drops into the emitted runtime the way mimalloc and the io_uring
layer did. libc mode keeps `-lm`. *Recommendation:* vendor the ~40
functions std/math actually re-exports, not all of libm.

**D6 — DNS becomes std's own, asynchronously.** `getaddrinfo` is the one
libc dependency that is a service (NSS, `/etc/nsswitch.conf`, possible
sssd/ldap in enterprise setups). Zig answered by writing a DNS client in
std; Yo's answer fits its model better: an async resolver
(`std/net/dns`) — parse `/etc/resolv.conf` and `/etc/hosts`, issue
UDP (TCP fallback) queries from `io.async`, cache per TTL. `--libc`
keeps `getaddrinfo` for sites that need NSS.
*Recommendation:* own async resolver as the no-libc default; document the
NSS caveat next to `--libc`.

**D7 — Threads and TLS are owned.** `clone` + `futex` for the
parallelism runtime and the main-thread big stack; static TLS block
initialized by Yo's own crt0 (the `THREAD_LOCAL_STORAGE.md` contract,
extended to "no dynamic loader in the picture"); `__yo_errno` as a TLS
variable the seam owns. This is the deepest phase (P5/P6) and the last to
land — everything before it works single-threaded.

**D8 — Per-OS stance.** Linux: the campaign (both envs, both Tier-1
arches x86_64/aarch64 first). macOS: **always libSystem**, exactly as
Zig concedes — no mode flag even offered. Windows: CRT-less default is
*possible* (the I/O runtime is already Win32; only CRT printf/malloc call
sites remain) but is P10, decided by measurement after Linux lands.
wasm: `wasm32-wasip1` keeps wasi-libc (that IS its libc);
`wasm32-unknown-emscripten` keeps Emscripten's runtime.

**D9 — The compiler, the seed chain and the portable C stay hosted.** The
`yo` binary itself links libc forever after the flip (it shells out, uses
pkg-config/OpenSSL, spawns Z3): the repo's own `build.yo` opts into
`libc : true` at P9 — Generation A passes the raw `--libc` flag (the seed
knows nothing of it), and the `std/build.yo` API field is Generation B
once `SEED_VERSION` carries it (the standing build-builtin rule).
`scripts/make-portable-c.sh`'s single-file `yo.c` bootstrap is unchanged:
it compiles the *compiler*, which is a hosted program. The verifier, LSP
and `yo test` runner all run in the hosted compiler process.

**D10 — C interop pulls libc in automatically.** A module that
`c_include`s a real header, or declares `extern("c")` functions beyond
the `__yo_os` seam, opts its artifact into `--libc` automatically (Zig's
behaviour), with one build-log line saying so. `std/libc/**` therefore
stays the libc-mode FFI surface, unchanged; in no-libc mode importing it
is the auto-opt-in.

## 4. The plan

Phases are ordered so the tree stays green throughout: every phase is
behind the opt-in `--no-libc` flag until P9 flips the default. Sizes are
first-cut estimates for sequencing only.

| Phase | Deliverable | Gate | Size |
| --- | --- | --- | --- |
| P0 | The `__yo_os` seam: `src/codegen/c/os_linux.yo` emits per-arch (x86_64, aarch64) inline-asm syscall wrappers, `__yo_errno`, freestanding `memcpy`/`memmove`/`memset`/`strlen`/`strcmp`; `yo compile --no-libc` links `-nostdlib -static`; the compiler-rt/libatomic audit (which symbols the corpus actually needs, provided or linked). | A hello-world runs no-libc on both arches; `ldd` = "not a dynamic executable"; `nm` shows zero libc symbols; a `tests/internal` file drives the compile in-process; a cli-case pins the flag's diagnostics. | M |
| P1 | The allocator: mimalloc's page allocation over `__yo_os` (`mmap`/`munmap`/`mprotect` syscalls) in no-libc mode. | The RC/GC corpus subset under `--no-libc --allocator mimalloc` green and leak-clean (`--allocator debug` oracle); `--allocator fixed` needs no change (already libc-free). | S |
| P2 | Traps and panic output: `__yo_os` `write` + an owned mini formatter replace every `fflush`/`fprintf`/`abort` in `c/collection.yo`, `__yo_abort`, `runtime_core.yo`; `__yo_os_exit`. | A trap corpus (index OOB, div-by-zero, overflow, panic, async abort) prints **byte-identical** stderr/stdout ordering in both modes. | S |
| P3 | Formatting and parsing: owned integer `to_string`; ryu float print + owned fixed-precision formatter; vendored musl `strtod` for parse; `std/fmt/to_string.yo` and `std/string` parse rewritten off `std/libc/stdio`/`stdlib`. | Differential corpus vs libc (`print → parse` round-trips, ±0 ULP for shortest form); goldens updated; output byte-identical across linux-x64/linux-arm64 hosts (the `%g` wart's fix is proven here); `yo test ./std` green. | M–L |
| P4 | The syscall swap: every libc call site in `runtime_io_common.yo` and `runtime_io_linux.yo`'s non-uring path moves to `__yo_os` (`openat`, `statx`, `getdents64`, `fcntl`, `ioctl`, `termios`, `signalfd`, `inotify`, socket family, `epoll_pwait2`, `send`/`recv`, …); `clock_gettime`/`clock_nanosleep`. | The fast language suite (fs/net/process-heavy files first) green under `--no-libc`; stdout byte-identical to the libc build on the same corpus; `tests/internal/uring_runtime.test.yo` extended with no-libc spellings. | M–L |
| P5 | Startup and TLS: own crt0 (`_start`: stack/auxv parse — `AT_PAGESZ`, `AT_RANDOM`, `AT_HWCAP` — TLS block init + TP register, then the existing main wrapper); the big-stack main thread via `clone` with a sized stack; futex join; thread-exit hooks. | The async suite green no-libc; `YO_MAIN_STACK_MB` honored (a deep-recursion probe passes); no `pthread_*` symbol in `nm`. | L |
| P6 | Parallelism: `clone`/`futex` mutex+cond replacing pthreads in `parallelism/runtime.yo`; CPU count via `sched_getaffinity`; the GC/sync primitives of `types/generation.yo` off pthread TLS keys. | Parallelism tests green no-libc; TSan legs run in libc mode only (D3), documented. | M |
| P7 | DNS: `std/net/dns` — the async resolver of D6; `std/net`'s no-libc arm uses it; `--libc` keeps `getaddrinfo`. | `std/net` + `std/http` tests against a local server green in both modes; a resolv.conf fixture corpus; the NSS caveat documented in both `docs/` languages. | M–L |
| P8 | Math and calendar: vendored musl libm subset (D5); `std/time/datetime.yo` on own civil-calendar math (days-from-civil family), UTC by default, TZ per Q5. | Differential tests vs libm over a value corpus (±0 ULP except documented libm-vs-musl divergences); datetime goldens; `yo test ./std` green. | M |
| P9 | **The flip.** Linux targets default to no-libc; `--libc` opts in; `build.executable({ libc : true })` (Generation B) and the repo's own `build.yo` opting in (Generation A: raw flag). Full Generation A sweep: `tests/`, both `docs/` languages, cli-cases goldens, the skills' copy, `docs/en-US/BUILD_SYSTEM.md`'s cross-compilation note. | Develop's battery green with a new no-libc leg (§5); `yo test ./tests --exclude …` green on a no-libc-built runner compiler *(stretch — the runner itself is hosted per D9; the default is about emitted programs)*; release Linux bundles switch to no-libc builds with musl kept as the `--libc` artifact. | M |
| P10 (optional, later) | Windows CRT-less default; freestanding/embedded profile (`*-none` style targets, no OS) as a consumer of the same seam. | Decided by measurement and by the first embedded consumer (FIXED_REGION_ALLOCATOR P4's trigger). | — |

Ordering inside P0–P8 is load-bearing only in one direction: P0 first
(everything sits on the seam), P5/P6 last-but-one (threads), P9 only when
P0–P8 hold on the fast suite. P3 can start any time — it is a libc-mode
win too (the `%g` fix, `yo test ./std` gates it independently).

## 5. CI and measurement gates

- **A no-libc battery leg** (from P4, promoted at P9): compile and run the
  language corpus with `--no-libc` on linux-x64 + linux-arm64, and
  byte-compare every test's stdout against the libc build of the same
  corpus — divergence is a failure, not a diff to bless.
- **Link assertions** in that leg: `ldd` reports statically linked; `nm`
  carries no `libc`/`pthread`/`libm` symbols; the SECCOMP-style check that
  only expected syscalls appear *(verify: worth a `strace -c` profile
  pinned per corpus)*.
- **Size and startup gates**: hello-world ≤ 150 KB static (measured at P0,
  recalibrated once); suite-compiler startup within noise of the musl
  build. The §1.5 table is the "before".
- **Differential gates** per phase: traps (P2), fmt/parse (P3), syscalls
  (P4), math/datetime (P8) — each a corpus run in both modes with
  byte-identical output.
- **Sanitizer legs unchanged**: ASan/TSan/LSan legs keep libc (D3); the
  `--allocator debug` oracle covers no-libc memory safety.
- The seed-cross-emit and suite-cross-emit jobs are unaffected (emit is
  link-mode-independent); the release `musl-bundle` job becomes the
  `--libc` artifact at P9, with a new no-libc bundle as the default asset.

## 6. Non-goals

- **macOS**: libSystem always; not a mode, not a flag.
- **The `yo` compiler binary, the seed chain, the portable-C bootstrap,
  the verifier, the LSP**: hosted programs, `--libc` (D9).
- **glibc-symbol compatibility for no-libc binaries**: a no-libc binary
  that wants to interpose/expose C ABI symbols opts into `--libc`; the
  two modes are distinct products, not a compatibility ladder.
- **Replacing `std/libc/`'s FFI role**: it stays exactly as it is, as the
  libc-mode C surface (D10).
- **Optimizing the syscall paths beyond parity**: vDSO, `statx` batching
  and the like are follow-ups once the corpus is green; P4's gate is
  byte-identical behavior, not speed.

## 7. Interplay with VALUES_BY_DEFAULT (and the other campaigns)

- **This plan starts after VBD completes** (the status header's one hard
  sequencing constraint). Decision 48 deletes the cycle collector in
  stages (`WEAK_AND_UNCOLLECTED_RC.md`): porting collector C onto the
  `__yo_os` seam before W6 deletes it would be paying P4 effort for code
  with a death sentence. Post-48, the RC runtime a no-libc build must
  carry is the *lightweight* one plus `Weak` — materially less C.
- VBD's ownership machinery (moves, `Drop`, explicit `.clone()`, `Rc`/
  `Arc`) is evaluator/codegen territory and is **unaffected** by the link
  mode: the emitted C is identical modulo the seam's syscall spellings.
  The one std-level touchpoint is `Drop`-based resource types over
  fds/sockets — they ride `__yo_os` like everything else.
- [`ZIG_STYLE_ALLOCATORS.md`](ZIG_STYLE_ALLOCATORS.md) A5 (`SmpAllocator`)
  gains its trigger here (D2); [`STRING_VALUE_SEMANTICS.md`](../STRING_VALUE_SEMANTICS.md)
  lands inside VBD and its `String` implementation is covered by P3.
- ZIG_ADOPTION **Z11** (`--allocator debug`) becomes the no-libc leak
  oracle — landing it before P9 is a soft prerequisite (D3).
  **Z19** (`yo targets`) is the natural place to show the two link modes
  per triple once they exist.
- SAFE_MODE's guards print through P2's owned panic path; their emission
  is otherwise mode-independent.

## 8. Open questions (each moves to `issues/questions/` when P0 starts)

| # | Question | Recommendation |
| --- | --- | --- |
| Q1 | Link-mode flag vs triple vocabulary (D1) | Flag; triples unchanged. |
| Q2 | Default allocator under no-libc (D2) | mimalloc over the seam; A5 stays a go/no-go. |
| Q3 | Sanitizer stance (D3) | `--sanitize address\|thread\|leak` implies `--libc`; UBSan audited in P0. |
| Q4 | Float print/parse supplier (D4) | ryu + owned fixed-precision; musl `strtod` vendored. |
| Q5 | Timezones after P8 | UTC-only default; vendored tzdata (`/usr/share/zoneinfo` TZif parsing) as a later opt-in — decide at P8, not now. |
| Q6 | Does `yo test` default to no-libc at P9 | Yes on Linux (test binaries are emitted programs); sanitizer invocations keep libc via Q3. |
| Q7 | `c_include` auto-opt-in wording (D10) | Automatic, one build-log line; an explicit `libc : false` with C imports is an error naming the conflict. |

## Maintenance

As in the Zig/Rust adoption docs: a phase lands by moving its row out of
§4 with a dated pointer here; a decision that changes gets its D-number
amended in place; the *(verify)* marks are re-checked before the phase
that depends on them starts. The audit tables in §1 are the 2026-10-22
snapshot and are regenerated (the same greps) at P0 kickoff.
