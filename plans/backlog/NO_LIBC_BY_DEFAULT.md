# No libc by default: a Yo program links nothing it did not bring

**Status: BACKLOG — audit + design, written 2026-10-22 at the maintainer's
request.** The goal is Zig's default, not Zig's escape hatch: a program
compiled for a hosted Linux target links **no libc** unless it asks to
(`--libc on`, or by referencing a libc symbol, D10), makes raw syscalls
through an emitted OS seam, owns its startup code, allocator, formatting,
math and DNS, and still runs the full language — `io.async` included — on
the real kernel. This document audits
every libc dependency the pipeline has today, answers the first design
question asked of it (§2: does the async runtime have to move out? — no),
decides the design space (§3), and lays out the phases with gates (§4).

**It assumes the
[`VALUES_BY_DEFAULT`](../VALUES_BY_DEFAULT.md) campaign is FINISHED** — the
end-state language (values by default, unique ownership, `Rc`/`Arc`, `Weak`
per decision 48, references with origins, `Drop`, explicit `.clone()`) is
the baseline this plan builds on, and every Yo snippet below is post-VBD
spelling. Nothing that touches the emitted runtime (every phase but P3 and
P7) starts before that: decision 48 deletes the cycle collector, and
porting the collector's C to a new OS seam only to delete it one release
later is wasted motion. **P3 and P7 are the exception:** both are std-only,
need no OS seam, fix open S2 bugs in libc mode too (§4), and may start now.

Companion reading: [`ZIG_ADOPTION_CANDIDATES.md`](ZIG_ADOPTION_CANDIDATES.md)
§0 (what Yo already shares with Zig — `zig cc` cross-compilation is listed
there as landed); [`FIXED_REGION_ALLOCATOR.md`](../reference/FIXED_REGION_ALLOCATOR.md)
("the first building block of an embedded/freestanding story"; its §6
already records the main-wrapper, unconditional-header and
`__yo_panic_write` items this plan builds on in P0, P0b and P2);
[`THREAD_LOCAL_STORAGE.md`](../reference/THREAD_LOCAL_STORAGE.md) (the TLS
contract phase P0b extends to a libc-free startup);
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
measurement, re-checked at review; file:line anchors on develop
`265faa941` (2026-10-23). A claim marked *(verify)* was not run to ground. The
dependency has four layers plus startup; they are separable, and §2 builds
on that.

### 1.1 Layer A — the emitted runtime C (`src/codegen/**`)

The runtime templates are already target-selected at emit time
([`TARGET_AWARE_CODEGEN.md`](../archive/TARGET_AWARE_CODEGEN.md): one
platform's runtime per compile) and already self-vendor the hard parts —
the io_uring ring layer (`DROP_LIBURING.md`), the TLSF fixed allocator,
RC (the cycle collector is gone on this plan's post-decision-48 baseline;
`Weak` replaces it). What they still take from libc:

| Dependency | Sites | Notes |
| --- | --- | --- |
| The syscall trampoline | 5 `syscall(...)` calls in `async/runtime_io_linux.yo`, 2 in `async/runtime_io_common.yo` | The io_uring layer already speaks raw `__NR_*` numbers (`__NR_io_uring_setup` 425 etc. with `#ifndef` fallbacks); only the variadic libc `syscall()` function and the TLS `errno` it reports through are libc. |
| `errno` | 10 files under `src/codegen/` | A TLS variable libc owns. |
| Synchronous metadata ops | `async/runtime_io_common.yo`, `runtime_io_linux.yo`: `openat`/`open`, `read`, `write`, `pread`/`pwrite`, `fstat`/`statx`, `unlinkat`, `mkdirat`, `renameat`, `fsync`, `ftruncate`, `getdents` (a `readdir`/`DIR*` path via `dirent.h`, beside an already-raw `SYS_getdents64` trampoline call), `fcntl`, `ioctl`, `isatty`, `termios`, `umask`, `symlinkat`/`readlinkat`, `statvfs`, `inotify`, `eventfd` | ~55 call sites; every one has a direct syscall (`statx`, `getdents64`, …). These are the ops the io_uring plan deliberately runs as plain syscalls. |
| Threads & startup | `functions/generation.yo:1675`–`1697` — the main wrapper reads `getenv("YO_MAIN_STACK_MB")` + `atol`, then runs the big-stack thread with `pthread_attr_init`/`pthread_attr_setstacksize` + `pthread_create` + `pthread_join`; `types/generation.yo`'s `__yo_raw_*` thread/mutex/cond macros (`pthread_*` on POSIX), which `parallelism/runtime.yo`'s workers consume; `functions/gc_runtime.yo:756`–`788` (a `pthread_key_create`/`pthread_once` key whose destructor runs `__yo_cleanup_thread_gc`, which also calls `__yo_async_thread_exit_hook` — async pool teardown that outlives the collector) | libc pthreads are on the startup path of **every** program, including single-threaded ones. (`async/runtime_core.yo:693`'s `pthread_threadid_np` is macOS-only, outside this campaign.) |
| `getaddrinfo` | `async/runtime_io_common.yo` (2), `async/runtime_io_windows.yo` (2) | DNS; the one dependency that is a *service*, not a syscall (§1.2, D6). |
| Panic/trap printing | `fflush(stdout); fprintf(stderr, …)` woven through every guard in `c/collection.yo`, `__yo_abort`, `async/runtime_core.yo`, and the all-allocator OOM hook `__yo_alloc_fail` (`c/collection.yo:264`, `c/allocator_fixed.yo`) | ~30 files reference `abort`. All replaceable with a raw `write(2)` and a mini formatter. |
| `snprintf` | `async/runtime_io_common.yo`, `async/runtime_io_windows.yo`, `exprs/ptr_fns.yo`, `c/allocator_fixed.yo` | Runtime-internal formatting (error strings, sizes). |
| Time | `clock_gettime`, `nanosleep` in the three native I/O runtimes + `types/generation.yo` | Direct syscalls exist (`clock_gettime` vDSO-less form, `clock_nanosleep`). |
| Allocator | `--allocator system` (the default) binds `__yo_malloc` to libc `malloc`/`free` via `stdlib.h` | The default allocator IS libc. `--allocator fixed` already needs none. mimalloc (`vendor/mimalloc` at `34fbd7e7c`) takes more of libc on Linux than its page calls: beside `mmap`/`munmap`/`mprotect`/`madvise` + `sysconf`, `include/mimalloc/atomic.h:18`–`19` sets `MI_USE_PTHREADS` on every non-Windows, non-WASI target, so its `mi_lock_t` is a `pthread_mutex_t` (`atomic.h:451`) and its thread-done hook is a `pthread_key_create`/`pthread_setspecific` key with a destructor (`src/prim/unix/prim.c`); `prim.c` also calls libc's variadic `syscall()` (`SYS_open`/`read`/`close`/`access`/`getrandom`/…), reads `extern char** environ`, and calls `clock_gettime`, `getrusage` and `prctl`. (`pthread_self` is macOS-only, `prim-tls.h:131`.) |
| Atomics/compiler-rt | The RC runtime uses C11/`__atomic_`/`__sync_` intrinsics (`functions/declarations.yo:913` special-cases their names) | On x86_64/aarch64 the sizes Yo emits are lock-free inline ops; whether any corpus site still links `libatomic`/compiler-rt symbols under `-nostdlib` is a P0 audit item. The C compiler also emits `memcpy`/`memset` calls it is always free to emit — freestanding C must provide them. |

Header inventory across `src/codegen/**` (site counts): `unistd.h` 7,
`fcntl.h` 7, `time.h` 6, `sys/socket.h` 6, `arpa/inet.h` 6, `errno.h` 5,
`sys/stat.h` 5, `string.h` 4, `sys/mman.h` 4, `sys/syscall.h` 3, plus a
tail of twos and singles (`stdlib.h`, `signal.h`, `poll.h`, `stdio.h`,
`termios.h`, `dirent.h`, `netdb.h`, …). Windows templates include Win32
headers plus a substantial CRT surface: `async/runtime_io_windows.yo`'s
file-descriptor model is the CRT's POSIX-fd emulation (`<io.h>`;
`_get_osfhandle` ×28, `_close`, `_read`, `_write`, `_open`,
`_open_osfhandle`, `_isatty`, `_wmkdir`, `_wstat64`, `_wrename`,
`_wunlink` — about 55 sites), worker threads start through `_beginthreadex`
(`types/generation.yo:652`), plus the printf family and malloc. wasm
templates assume wasi-libc / Emscripten.

### 1.2 Layer B — std/ (`std/libc/**` and its importers)

`std/libc/` is 21 modules of `c_include` bindings (`stdio`, `stdlib`,
`string`, `math`, `time`, `errno`, `fcntl`, `unistd`, `signal`, `dirent`,
`assert`, `ctype`, `float`, `limits`, `stdint`, `stdatomic`, `wctype`,
`sys/…`, `windows`, `darwin`, `dyld`). **17 top-level std modules (31
files) import them** — this is the widest layer, and the one that makes
"just delete libc" impossible today: `allocator`, `arena`, `collections`
(`array_list`, `deque` and two test files), `crypto/random`,
`encoding/json`, `encoding/toml`, `env`, `fmt` (`index`, `to_string`),
`fs/file`, `fs/dir`, `fs/temp`, `log`, `math`, `net` (`addr`, `tcp`,
`udp`), `process`, `string` (`string`, `string_builder`), `sync/once`,
`sync/atomic`, `sys/constants`, `sys/errors`, `testing/bench`,
`time/datetime` and `time/duration`. Many of these imports are
header-only — constants and freestanding C11 headers (`SIZE_MAX` from
`<stdint.h>` in `std/allocator.yo:27`, which 25 std files import; `E*`
values in `sys/errors`; `O_*` in `sys/constants`) — which link nothing;
D10 is worded so they never pull libc in.

The load-bearing members:

- **Console output is libc's.** `std/fmt/index.yo:28` imports `fwrite`,
  `stdout` and `stderr`: every `print`/`println` is a libc `FILE*` write,
  line-buffered on a terminal (an ordering P2's gate relies on).
- **Number formatting is libc's.** Every `to_string()` goes through
  `_snprintf_to_string` (`std/fmt/to_string.yo:85`), floats via `%g`,
  which keeps 6 significant digits and so does not round-trip:
  `issues/json-stringify-renders-numbers-with-percent-g-and-loses-them.md`
  (S2; 123456789 renders `1.23457e+08`) and
  `issues/stddoc-str-string-builder-write-f64-truncates.md` (S2; an
  unchecked `snprintf` into a 64-byte buffer) are both open. Owning this is
  a fix the tree already wants, independent of this campaign. (Non-finite
  values are already normalized to `NaN`/`inf`/`-inf` before `%g`,
  `_non_finite_str` at `to_string.yo:198`, fixed 2026-09-15; the module
  header at `to_string.yo:25`–`31` that still calls that OPEN is stale, a
  separate cleanup.)
- **Float parsing is libc's.** `atof` (`std/string/string.yo:3083`, after
  a Yo-side grammar check; `std/encoding/json.yo:943`, which also uses
  `strtoll`) backs string→float. `strtod` is bound in
  `std/libc/stdlib.yo:74` but unused outside `std/libc`. `snprintf` also
  formats in `encoding/toml`, `time/duration`, `string/string_builder` and
  `net` (`addr`, `tcp`, `udp`) — P3's rewrite targets beside `fmt` and
  `encoding/json`.
- **Math is a libm veneer.** `std/math.yo:56` — `sqrt : _c_sqrt`,
  `floor : _c_floor`, `pow : _c_pow`, … — and `-lm` sits on every POSIX
  link line (`src/main.yo:8013`).
- **DNS is `getaddrinfo`/`getnameinfo`**, already behind a typed std
  surface: `std/net/dns.yo` (`lookup_host`) over `std/sys/dns.yo` (Layer
  A's sites back it). It blocks the single-threaded event loop
  (`issues/stddoc-io-dns-resolution-blocks-the-event-loop.md`, S2, whose
  own fix sketch 2 is D6's resolver) and returns duplicate addresses
  (`issues/stddoc-io-dns-lookup-host-returns-duplicate-addresses.md`, S2).
- **The local UTC offset is libc's.** `_local_utc_offset`
  (`std/time/datetime.yo:199`) calls `localtime_r` (`_localtime64_s` on
  Windows), which reads `TZ`/`/etc/localtime`; the civil-calendar math is
  already Yo's (`_days_from_civil`, `datetime.yo:122`). datetime's
  `snprintf` use is P3's.
- Already syscall-shaped: `std/crypto/random.yo`'s Linux arm calls
  `getrandom` — today glibc's wrapper function (the `__yo_getrandom`
  builtin lowers to a plain C call), but a 1:1 raw syscall (318 on
  x86_64, 278 on aarch64) with no libc *service* behind it —
  `arc4random_buf` on macOS, `BCryptGenRandom` on Windows.

### 1.3 Layer C — the driver and the link line

`-lm -pthread` on every POSIX link (`src/main.yo:8013`–`8014`); the
system allocator default; sanitizer runtimes (ASan/LSan/TSan intercept
libc and need it to exist); static-musl release bundles (libc statically
included). Cross-emission is host-independent, so none of this constrains
codegen — only the final C compile and link.

### 1.4 Layer D — startup

The C compiler's crt provides `_start`, TLS initialization and `errno`;
Yo's main wrapper then re-enters libc pthreads for the 1 GiB main stack
(`functions/generation.yo:1691`, `YO_MAIN_STACK_MB`). Without libc, Yo owns
all three.

### 1.5 Measured baselines (2026-10-23 at review, this repo, `yo` 0.2.68, zig 0.16.0)

A `println("Hello, world!")` program, x86_64. The original 2026-10-22
table compared a static-musl binary *with DWARF debug info* (`zig cc`
keeps it at `-O2`) against a stripped-size goal; every row below states
its debug-info status.

| Build of a hello-world | Size | Notes |
| --- | --- | --- |
| Default (`yo compile`, `--allocator system`, host clang) | 33,648 B dynamic ELF; **26,744 B stripped** | Requires host glibc at runtime. |
| Static musl (`--emit-c`, then `zig cc -O2 -target x86_64-linux-musl -static … -lm`) | 1,412,216 B with debug info; **29,672 B stripped** | The libc it carries costs only a few KB once stripped. |
| No-libc (this plan's P9 outcome) | measured at P2 (the first phase where a no-libc hello-world runs) | The §5 gate is "stripped no-libc hello-world no larger than stripped static musl". |

**Binary size is not this plan's motivation**: static musl already
produces a ~30 KB self-contained hello-world. The motivation is owning the
floor — no libc ABI/version coupling, no NSS or locale behaviour leaking
into std, one implementation of formatting, parsing and math on every
Linux host, and a seam a freestanding target can reuse (P10).

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
   own C (no liburing), TLSF is Yo's own C, RC (and `Weak`) is Yo's own
   C. None of it came from libc; none of it leaves.
3. **The libc seam is narrow and enumerable** — §1.1's table is the whole
   of it under the async runtime: the `syscall()` trampoline, `errno`, the
   ~55 synchronous metadata-op call sites, `clock_gettime`/`nanosleep`,
   pthreads, the main wrapper's `getenv`, and panic printing. Each has a
   direct replacement through an emitted `__yo_os` layer (P0) — this is Zig's `std.os` shape: the async
   engine sits on an OS seam, and the seam has two implementations, raw
   syscall and libc, selected by the link mode.

What **does** move out of the default picture is not the runtime but the
libc *services* std consumes (§1.2): `fwrite` console output, `snprintf`
formatting, `atof`/`strtoll` parsing, libm, `getaddrinfo`/`getnameinfo`,
pthreads, libc malloc, the `localtime_r` UTC offset. Each is either
replaced by an owned implementation (P1–P8) or, when a program references
the libc symbol itself, opts the artifact into libc (D10). And `std/libc/`
itself — the `c_include` bindings — remains available unchanged in libc
mode; in no-libc mode it is the FFI surface D10 governs.

Concretely, per class of call site:

| Class | Today | Under no-libc | Phase |
| --- | --- | --- | --- |
| io_uring enter/setup/register | libc `syscall()` + `errno` | `__yo_os` inline-asm syscall + a seam-owned errno slot (`__yo_os_errno`, D7) | P0/P4 |
| Metadata ops (open/stat/dirent/…) | libc wrappers | `__yo_os` direct syscalls (`statx`, `getdents64`, …) | P4 |
| Timers | `clock_gettime`, `nanosleep` | `clock_gettime`/`clock_nanosleep` syscalls | P4 |
| Startup + main-thread big stack | libc crt + `getenv` + `pthread_create`/`join` | own crt0 (auxv, static TLS), own `getenv` over envp, `main` run on an `mmap`'d stack of `YO_MAIN_STACK_MB` (a stack switch, no thread) | P0b |
| Thread exit | `gc_runtime.yo`'s pthread key destructor (runs `__yo_async_thread_exit_hook`) | P5's own thread-exit hook | P5 |
| Parallelism workers/sync | pthreads (`__yo_raw_*` macros) | `clone`/`futex` | P5/P6 |
| Allocation (default) | libc malloc | mimalloc over `__yo_os` pages | P1 |
| Panics/traps/OOM | `fprintf`/`fflush`/`abort`, `__yo_alloc_fail` | `__yo_panic_write` (FIXED_REGION §6 item 6) over raw `write` + own formatter + `__yo_os_exit` | P2 |
| Console output (`std/fmt`) | libc `fwrite` on `stdout`/`stderr` | an owned buffered writer over `__yo_os` `write`, same line-buffering | P2 |
| `to_string`/parse | `snprintf`/`atof`/`strtoll` | own integer formatter, ryu float print, own float parse | P3 |
| Math | libm | vendored musl libm subset (both modes, D5) | P8 |
| DNS | `getaddrinfo`/`getnameinfo` (blocking) | own async resolver behind the existing `std/net/dns` (both modes, D6) | P7 |
| Local UTC offset/TZ | libc `localtime_r` (UTC offset) | UTC default; TZif per Q5 | P8 |

The other std importers of libc *functions* (`env`, `fs`, `process`,
`arena`, `log`, `crypto/random`) move onto the seam in P4b.

The macOS runtimes keep libSystem entirely (D8); the Windows runtime's CRT
surface (the POSIX-fd emulation layer, `_get_osfhandle` and friends at
about 55 sites; `_beginthreadex`; the printf family; malloc under the
system allocator, §1.1) follows the same replacements only if/when P10
opts Windows into CRT-less.

## 3. Design decisions

Each states the choice and a recommendation; the numbered open ones move
to `issues/questions/` when this plan starts.

**D1 — No-libc is a link mode, not a target triple.** The Rust-triple
vocabulary (`TARGET_TRIPLES.md`) is untouched; a linux triple's env word
(`gnu`/`musl`) keeps describing the ABI the binary interoperates with
*when libc is linked*. The knob follows the landed `--cycle-collector`
precedent (decision 48 W1, #1536): `yo compile --libc auto|on|off` and
`build.executable({ libc : LibcMode.Auto })`, a `?=`-defaulted enum field
lowered as one more trailing `__yo_build_executable` argument (an older
seed's builtin ignores it, `std/build.yo:339`), landing in one PR with the
flag. `auto` means "no libc unless D10 fires"; `on` always links libc;
`off` never does (and a referenced libc symbol is an error, Q7). The
default is `on` until P9 flips it to `auto` on Linux targets — a default
change, so no `--no-libc` spelling ever exists to retire.
*Rejected:* a triple. `x86_64-unknown-linux-none` is a real Rust triple
(Tier 3, "64-bit Linux with no libc", 2024) and Zig spells the same ABI
`x86_64-linux-none`, so adopting it would neither invent a triple nor add
an alias — `TARGET_TRIPLES.md` would only gain `none` in the linux env set.
The real trade-off: no-libc is a per-artifact property under D10's
automatic opt-in, which cannot rewrite a triple the user passed; keeping
the env word as "the libc ABI, when linked" lets one triple build both
modes; and a link mode adds no rows to the triple table.
*Recommendation:* link mode. `-linux-none` may later be accepted as the
triple spelling of `--libc off` if a consumer asks for it.

**D2 — The default allocator under no-libc.** libc malloc cannot be the
default once libc is gone. Candidates: (a) mimalloc over `__yo_os` page
allocation (already the Linux release bundles' flavor — Windows and macOS
bundles ship `system` on measured wall time,
[`WINDOWS_ALLOCATOR_DECISION.md`](../reference/WINDOWS_ALLOCATOR_DECISION.md)
— already vendored, already beaten glibc malloc in this repo's
measurements); (b) `--allocator fixed`
(right allocator, wrong default — one static region sized at compile time
is an embedded answer, not a hosted one); (c) the `SmpAllocator` of
[`ZIG_STYLE_ALLOCATORS.md`](ZIG_STYLE_ALLOCATORS.md) A5 — whose go/no-go
explicitly names "a freestanding target that needs it" as its trigger.
*Recommendation:* mimalloc-backed default in no-libc mode from day one —
which is more than a page-allocation swap: mimalloc's lock is a
`pthread_mutex_t` and its thread-done hook a pthread key on Linux (§1.1),
so its threaded half rides P5's futex lock and thread-exit hook;
A5's go/no-go stays exactly where it is, and this campaign is its trigger
— if a Yo-written allocator wins on the compiler's own profile it can
replace mimalloc under the same seam. `fixed` remains the embedded choice
and needs nothing from libc at all.

**D3 — Sanitizers imply libc.** ASan/LSan/TSan runtimes intercept libc;
without libc there is nothing to intercept and no runtime to link.
*Recommendation:* `--sanitize address|thread|leak` (and `yo test` under
them) implies `--libc on` and says so in one build-log line (D10's
wording); UBSan's runtime is toolchain-level and is audited in P0
*(verify: it links no-libc)*. The `--allocator debug` leak oracle
(ZIG_ADOPTION Z11) has landed by the time this plan starts (v0.2.70, W6's
precondition, `plans/handover/VBD_RELEASE_SCHEDULE.md`) and becomes the
no-libc mode's memory-safety instrument — but Z11 is specified as "a
tracking allocator over the system one", i.e. over libc malloc, so P1
gives it a seam-backed backing (tracking over mimalloc or `__yo_os`
pages). Until then the landed, libc-free `--allocator fixed --debug-heap`
oracle ([`FIXED_REGION_ALLOCATOR.md`](../reference/FIXED_REGION_ALLOCATOR.md))
is usable from P0.

**D4 — Own float print and parse, now.** Shortest-round-trip printing:
ryu `d2s`/`f2s` (Apache-2.0, ~small, the industry answer) plus an owned
fixed-precision exp/dec formatter for `{:.N}`-style output; parsing:
eisel-lemire-style fast path with a slow-path fallback (or vendored musl
`strtod`, MIT — one license, one supplier), replacing the `atof`/`strtoll`
call sites (§1.2). This fixes `%g`'s 6-significant-digit lossiness — the
open S2s `issues/json-stringify-renders-numbers-with-percent-g-and-loses-them.md`
and `issues/stddoc-str-string-builder-write-f64-truncates.md` — rather
than carrying it into a libc-free world where there is no `%g` to delegate
to. *Recommendation:* ryu + own formatter, musl `strtod` vendored for
parsing (correctness
first; eisel-lemire later as an optimization with differential gates).

**D5 — Vendor a musl libm subset.** `std/math.yo`'s `f64` surface binds
libm; musl is MIT (libm's Sun/FreeBSD-derived files keep their upstream
BSD notices), already the reference implementation Zig derived
from, and drops into the emitted runtime the way mimalloc and the io_uring
layer did. **`std/math` uses the vendored subset in both link modes**;
`-lm` stays on libc-mode link lines only for user C code. That keeps §5's
byte-identity between modes sound for math output, and gives every Linux
host (glibc or musl) the same results. *Recommendation:* vendor the ~55
functions std/math actually re-exports, not all of libm.

**D6 — DNS becomes std's own, asynchronously.** `getaddrinfo` (and
`getnameinfo`, reverse lookup) is the one libc dependency that is a
service (NSS, `/etc/nsswitch.conf`, possible sssd/ldap in enterprise
setups). The std surface already exists — `std/net/dns.yo`
(`lookup_host`) over `std/sys/dns.yo` — and today it blocks the
single-threaded event loop
(`issues/stddoc-io-dns-resolution-blocks-the-event-loop.md`, S2, which
waits on the open `spawn_blocking` decision and whose fix sketch 2 is this
resolver) and returns duplicate addresses
(`issues/stddoc-io-dns-lookup-host-returns-duplicate-addresses.md`, S2).
Zig answered by writing a DNS client in std; Yo's answer fits its model
better: replace the implementation behind the existing `std/net/dns` +
`std/sys/dns` surface with an async resolver — parse `/etc/resolv.conf`
and `/etc/hosts`, issue UDP (TCP fallback) queries over the existing
runtime sockets from `io.async`, PTR queries for reverse lookup, cache per
TTL, deduplicate results.
*Recommendation:* the owned async resolver is the default **in both link
modes** (macOS included, D8 — its scoped resolvers are a P7 *(verify)*
item), so it fixes the blocking S2 everywhere;
`getaddrinfo` stays only as an explicit NSS opt-in, with the NSS caveat
documented next to it.

**D7 — Startup, threads and TLS are owned.** Yo's own crt0 (`_start`,
argc/argv/envp/auxv parse) initializes the static TLS block (the
`THREAD_LOCAL_STORAGE.md` contract, extended to "no dynamic loader in the
picture") and runs `main` on an `mmap`'d stack of `YO_MAIN_STACK_MB` — a
stack switch, not a thread. That startup is **P0b, before every other
phase**: errno, mimalloc's TLS and every no-libc gate need it. `clone` +
`futex` then serve the parallelism runtime and the thread-exit hook (P5/P6),
the deepest and last phases; everything between P0b and P5 runs
single-threaded. The existing `__yo_errno()` builtin (`BF_YO_ERRNO`,
`src/expr.yo:235`) keeps its Yo signature; in no-libc mode its lowering
(`src/codegen/exprs/inline_fns.yo:703`, today the C macro `errno`) reads a
seam-owned TLS slot with a distinct C name (`__yo_os_errno`), which the
seam's syscall wrappers set from the negative return.

**D8 — Per-OS stance.** Linux: the campaign (both envs, both Tier-1
arches x86_64/aarch64 first). macOS: **always libSystem**, exactly as
Zig concedes — no mode flag even offered. Windows: CRT-less default is
*possible* but large — the I/O runtime's fd model is the CRT's
POSIX-fd emulation (about 55 `_get_osfhandle`-family sites),
`_beginthreadex` starts threads, plus the printf family and malloc (§1.1)
— and is P10, decided by measurement after Linux lands.
wasm: `wasm32-wasip1` keeps wasi-libc (that IS its libc);
`wasm32-unknown-emscripten` keeps Emscripten's runtime.

**D9 — The compiler, the seed chain and the portable C stay hosted.** The
`yo` binary itself links libc forever after the flip (it shells out, uses
pkg-config/OpenSSL, spawns Z3); `src/` references libc functions, so D10's
automatic opt-in already covers it. The repo's own `build.yo` may also
spell `libc : LibcMode.On` once `SEED_VERSION` carries the field, for
explicitness only. The Linux release bundles ARE this compiler
(`release.yml`'s `musl-bundle`, the installed seed), so they stay static
musl.
`scripts/make-portable-c.sh`'s single-file `yo.c` bootstrap is unchanged:
it compiles the *compiler*, which is a hosted program. The verifier, LSP
and `yo test` runner all run in the hosted compiler process.

**D10 — C interop pulls libc in automatically, by symbol.** Under
`--libc auto`, an artifact opts into libc when the linked program
*references* a libc function or object — a `c_include` member of fn or
extern-object kind, or an `extern("c")` function beyond the `__yo_os`
seam (Zig's behaviour) — with one build-log line naming the first such
symbol. Importing a header is not enough: header-only constants, macros
and types, and the freestanding C11 headers (`<stdint.h>`, `<limits.h>`,
`<float.h>`, `<stdatomic.h>`), never trigger it — an include-based rule
would let `std/allocator.yo`'s `SIZE_MAX` import alone re-link libc into
nearly every program, making P9 a no-op and every no-libc gate vacuous.
Std itself never triggers it once P4b lands. `std/libc/**` stays the
libc-mode FFI surface, unchanged.

## 4. The plan

Phases are ordered so the tree stays green throughout: every phase is
behind `--libc off` (or `auto`, opt-in) until P9 flips the default from
`on` to `auto`. Sizes are first-cut estimates for sequencing only. "Link
assertions" in a gate means §5's mechanical definition.

| Phase | Deliverable | Gate | Size |
| --- | --- | --- | --- |
| P0 | The `__yo_os` seam: `src/codegen/c/os_linux.yo` emits per-arch (x86_64, aarch64) inline-asm syscall wrappers, the seam-owned errno slot `__yo_os_errno` and `__yo_errno()`'s no-libc lowering (D7), freestanding `memcpy`/`memmove`/`memset`/`strlen`/`strcmp`; `collection.yo`'s unconditional `<unistd.h>`/`<sys/stat.h>`/`<sys/random.h>`/pthread includes become link-mode-gated (FIXED_REGION §6 item 2); `--libc auto\|on\|off` and `build.executable({ libc : LibcMode })` in one PR (D1, default `on`); `--libc off` links `-nostdlib -static`; the compiler-rt/libatomic audit (which symbols the corpus actually needs, provided or linked). | A freestanding seam probe — its own `_start`, bypassing the main wrapper and the allocator — issues `write` and `exit_group` through the seam on both arches and passes the link assertions; a `tests/internal` file drives the compile in-process; a cli-case pins the flag's diagnostics. | M |
| P0b | Startup and TLS (D7): own crt0 (`_start`: argc/argv/envp + auxv parse — `AT_PAGESZ`, `AT_RANDOM`, `AT_HWCAP` — static TLS block init + TP register); a no-libc main path with an own `getenv` over envp and `main` run on an `mmap`'d stack of `YO_MAIN_STACK_MB` (a stack switch, no thread; FIXED_REGION §6 item 1). | A program under `--libc off --allocator fixed` that touches TLS and errno runs on both arches and passes the link assertions; `YO_MAIN_STACK_MB` honored (a deep-recursion probe passes). | M |
| P1 | The allocator, single-threaded half: mimalloc over `__yo_os` in no-libc mode — page calls (`mmap`/`munmap`/`mprotect`/`madvise`) plus its other libc uses (`syscall()`, `environ`, `clock_gettime`, `getrusage`, `prctl`, §1.1), with its `pthread_mutex_t` lock and thread-done key shimmed for one thread; Z11's `--allocator debug` gains a seam-backed backing (tracking over mimalloc or `__yo_os` pages, D3). | The RC corpus subset under `--libc off --allocator mimalloc` green and leak-clean under the seam-backed `--allocator debug`, cross-checked against the libc-free `--allocator fixed --debug-heap` oracle and `--sanitize leak` in libc mode; `--allocator fixed` needs no change (already libc-free). | M |
| P2 | Console and panic output: one panic sink, FIXED_REGION §6 item 6's `__yo_panic_write(const char*, size_t)` (over `__yo_os` `write` in no-libc mode, over stdio in libc mode) + an owned mini formatter replace every `fflush`/`fprintf`/`abort` in `c/collection.yo`, `__yo_abort`, `runtime_core.yo` and `__yo_alloc_fail`; `__yo_os_exit`; `std/fmt`'s `print`/`println` move from `fwrite` to an owned buffered writer over the seam that keeps today's line-buffering. | A trap corpus (index OOB, div-by-zero, overflow, panic, a panic inside an async task, OOM) prints **byte-identical** stderr/stdout ordering in both modes; the first no-libc hello-world runs on both arches, passes the link assertions, and records the §5 size baseline. | M |
| P3 | Formatting and parsing: owned integer `to_string`; ryu float print + owned fixed-precision formatter; vendored musl `strtod` for parse; `std/fmt/to_string.yo`, `std/string`, `std/string/string_builder.yo`, `std/encoding/json.yo`/`toml.yo`, `std/time/duration.yo` and `std/net/{addr,tcp,udp}.yo` rewritten off `std/libc/stdio`/`stdlib`. **Std-only: may start now, in libc mode** — it closes the S2s `issues/json-stringify-renders-numbers-with-percent-g-and-loses-them.md` and `issues/stddoc-str-string-builder-write-f64-truncates.md`. | A round-trip corpus (`parse(to_string(x)) == x` for every finite f32/f64 in the corpus, shortest form); a differential corpus vs libc for integers and fixed-precision output; goldens updated; if cross-libc identity is wanted, Linux output compared against Windows/macOS output; `yo test ./std` green. | M–L |
| P4 | The syscall swap: every libc call site in `runtime_io_common.yo` and `runtime_io_linux.yo`'s non-uring path moves to `__yo_os` (`openat`, `statx`, `getdents64`, `fcntl`, `ioctl`, `termios`, `inotify`, socket family, `epoll_pwait2`, `send`/`recv`, …); `clock_gettime`/`clock_nanosleep`. | The fast language suite (fs/net/process-heavy files first) green under `--libc off`, with the leg asserting the D10 auto-opt-in did not fire for any file it counts green; stdout byte-identical to the libc build on the same corpus; `tests/internal/uring_runtime.test.yo` extended with no-libc spellings. | M–L |
| P4b | std off `std/libc` *functions* (D10): `env` (`getenv`/`setenv`/`environ`/`getcwd`/`realpath`/…), `fs/*`, `process`, `arena` (`atexit`), `log` (`fwrite`/`getenv`, onto P2's writer) and `crypto/random` (its `getrandom` becomes a raw syscall) move onto the seam. `net`, `encoding`, `testing/bench` and `time/duration` use only `snprintf`/`atof`/`strtoll`, which P3 removes; `memcpy`/`memmove`/`memset` (collections, `arena`, `fs/temp`) resolve to the seam's own (P0); `sync`, `sys/errors` and `sys/constants` are header-only and stay. | No libc function is reachable from the prelude or std under `--libc off`; `yo test ./std` green under `--libc off`, with the auto-opt-in asserted not to fire. | M–L |
| P5 | Threads and thread exit: `clone` with a sized stack + futex join replacing `__yo_raw_thread_create`/join on Linux; a seam futex lock (P6's mutex/cond build on it); an own thread-exit hook that keeps `__yo_async_thread_exit_hook` (async pool teardown, today run by `gc_runtime.yo`'s pthread key destructor, whose collector half is gone after W6b); mimalloc's threaded half onto the seam's futex lock and this hook (D2). | The async suite green no-libc; the threaded RC/allocator corpus leak-clean; link assertions (no `pthread_*` reference survives). | L |
| P6 | Parallelism: `clone`/`futex` mutex+cond replacing pthreads in the mutex/cond/thread primitives of `types/generation.yo` (the `__yo_raw_*` macros `parallelism/runtime.yo` consumes); CPU count via `sched_getaffinity`. | Parallelism tests green no-libc; TSan legs run in libc mode only (D3), documented. | M |
| P7 | DNS (D6): the async resolver replaces the implementation behind the existing `std/net/dns` + `std/sys/dns` surface, forward and reverse (`getnameinfo`) lookup, in **both** link modes; `getaddrinfo` stays only as an explicit NSS opt-in. **Std-only over the existing runtime sockets: may start now** — it closes `issues/stddoc-io-dns-resolution-blocks-the-event-loop.md` and `issues/stddoc-io-dns-lookup-host-returns-duplicate-addresses.md` (both S2). | `std/net` + `std/http` tests against a local server green in both modes; a resolv.conf/hosts fixture corpus; a lookup does not block the event loop (a concurrent timer probe); no duplicate addresses; the NSS caveat documented in both `docs/` languages. | M–L |
| P8 | Math and the local UTC offset: vendored musl libm subset used by `std/math` in both modes (D5); `std/time/datetime.yo`'s `_local_utc_offset` off `localtime_r` — UTC by default, TZ per Q5 (the civil-calendar math is already Yo's). | Accuracy tests of the vendored subset vs glibc libm over a value corpus (±0 ULP except a documented divergence list); math output byte-identical between modes (same code); datetime goldens; `yo test ./std` green. | M |
| P9 | **The flip.** Linux targets default to `--libc auto`; `--libc on` / `build.executable({ libc : LibcMode.On })` opt in. Full Generation A sweep: `tests/`, both `docs/` languages, cli-cases goldens, the skills' copy, `docs/en-US/BUILD_SYSTEM.md`'s cross-compilation note. The release bundles are the hosted compiler (D9) and stay static musl; P9 changes only what the bundled compiler emits by default. | Develop's battery green with the no-libc leg (§5) promoted; optionally a no-libc hello-world link/size probe in the release job as a non-seed check, never a default asset. | M |
| P10 (optional, later) | Windows CRT-less default; freestanding/embedded profile (`*-none` style targets, no OS) as a consumer of the same seam. | Decided by measurement and by the first embedded consumer (FIXED_REGION_ALLOCATOR P4's trigger). | — |

Ordering is load-bearing: P0 then P0b first (everything sits on the seam,
and every no-libc gate needs startup and TLS), P1 and P2 next (no
hello-world runs without an allocator and console output), P5/P6
last-but-one (threads; everything between P0b and P5 runs
single-threaded), P9 only when P0–P8 hold on the fast suite. P3 and P7
are std-only and can start any time, before VBD completes — each is a
libc-mode win too (they close four open S2s), and `yo test ./std` gates
them independently.

## 5. CI and measurement gates

- **A no-libc battery leg** (from P4, promoted at P9): compile and run the
  language corpus with `--libc off` on linux-x64 + linux-arm64, and
  byte-compare every test's stdout against the libc build of the same
  corpus — divergence is a failure, not a diff to bless. Math output is
  covered because `std/math` runs the same vendored libm in both modes
  (D5). The leg asserts that D10's auto-opt-in did not fire for any file it
  counts green.
- **Link assertions** in that leg, defined mechanically rather than by
  symbol name (the seam itself defines `memcpy`, `strlen`, …): `file`
  reports a static executable and `ldd` "not a dynamic executable"; `nm -u`
  lists no undefined symbols; the link line carries `-nostdlib` and no
  libc/libm/libpthread archive — only Yo-emitted objects, vendored objects
  and compiler-rt; optionally a link map shows every defined symbol comes
  from those. Plus the SECCOMP-style check that only expected syscalls
  appear *(verify: worth a `strace -c` profile pinned per corpus)*.
- **Size and startup gates**, on emitted programs: a stripped no-libc
  hello-world no larger than the stripped static-musl one (§1.5: 29,672 B),
  the threshold recalibrated once from P2's measurement; hello-world and a
  test binary's startup time within noise of the static-musl build. The
  §1.5 table is the "before"; size is a guard, not the goal.
- **Differential gates** per phase: traps (P2), syscalls (P4), math (P8)
  — each a corpus run in both modes with byte-identical output; fmt/parse
  (P3) is gated by round-trip, datetime (P8) by goldens.
- **Sanitizer legs unchanged**: ASan/TSan/LSan legs keep libc (D3); the
  seam-backed `--allocator debug` oracle (P1) covers no-libc memory safety.
- The seed-cross-emit and suite-cross-emit jobs are unaffected (emit is
  link-mode-independent). The release `musl-bundle` job is unchanged: the
  bundles are the hosted compiler (D9) and stay static musl.

## 6. Non-goals

- **macOS**: libSystem always; not a mode, not a flag.
- **The `yo` compiler binary, the seed chain, the portable-C bootstrap,
  the verifier, the LSP**: hosted programs, libc linked (D9).
- **glibc-symbol compatibility for no-libc binaries**: a no-libc binary
  that wants to interpose/expose C ABI symbols opts into `--libc on`; the
  two modes are distinct products, not a compatibility ladder.
- **Replacing `std/libc/`'s FFI role**: it stays exactly as it is, as the
  libc-mode C surface (D10).
- **Optimizing the syscall paths beyond parity**: vDSO, `statx` batching
  and the like are follow-ups once the corpus is green; P4's gate is
  byte-identical behavior, not speed.

## 7. Interplay with VALUES_BY_DEFAULT (and the other campaigns)

- **This plan starts after VBD completes** (the status header's one hard
  sequencing constraint; P3 and P7 are exempt). Decision 48 deletes the cycle collector in
  stages (`WEAK_AND_UNCOLLECTED_RC.md`): porting collector C onto the
  `__yo_os` seam before W6 deletes it would be paying P4 effort for code
  with a death sentence. Post-48, the RC runtime a no-libc build must
  carry is the *lightweight* one plus `Weak` — materially less C. One duty
  of the collector's runtime survives it: `gc_runtime.yo`'s pthread key
  destructor also runs `__yo_async_thread_exit_hook` (async pool
  teardown), which P5's thread-exit hook keeps.
- VBD's ownership machinery (moves, `Drop`, explicit `.clone()`, `Rc`/
  `Arc`) is evaluator/codegen territory and is **unaffected** by the link
  mode: the emitted C is identical modulo the seam's syscall spellings.
  The one std-level touchpoint is `Drop`-based resource types over
  fds/sockets — they ride `__yo_os` like everything else.
- [`ZIG_STYLE_ALLOCATORS.md`](ZIG_STYLE_ALLOCATORS.md) A5 (`SmpAllocator`)
  gains its trigger here (D2); [`STRING_VALUE_SEMANTICS.md`](../STRING_VALUE_SEMANTICS.md)
  lands inside VBD and its `String` implementation is covered by P3.
- ZIG_ADOPTION **Z11** (`--allocator debug`) has landed by then (v0.2.70,
  W6's precondition) and becomes the no-libc leak oracle once P1 gives it
  a seam-backed backing (D3).
  **Z19** (`yo targets`) is the natural place to show the two link modes
  per triple once they exist.
- SAFE_MODE's guards print through P2's owned panic path; their emission
  is otherwise mode-independent.

## 8. Open questions (each moves to `issues/questions/` when P0 starts)

| # | Question | Recommendation |
| --- | --- | --- |
| Q1 | Link-mode flag vs triple vocabulary (D1) | `--libc auto\|on\|off` + `LibcMode`, modeled on `--cycle-collector`; triples unchanged (`-linux-none` possibly accepted later as a spelling of `off`). |
| Q2 | Default allocator under no-libc (D2) | mimalloc over the seam (its lock and thread-done key included); A5 stays a go/no-go. |
| Q3 | Sanitizer stance (D3) | `--sanitize address\|thread\|leak` implies `--libc on`; UBSan audited in P0. |
| Q4 | Float print/parse supplier (D4) | ryu + owned fixed-precision; musl `strtod` vendored. |
| Q5 | Timezones after P8 | UTC-only default; vendored tzdata (`/usr/share/zoneinfo` TZif parsing) as a later opt-in — decide at P8, not now. |
| Q6 | Does `yo test` default to `--libc auto` at P9 | Yes on Linux (test binaries are emitted programs); sanitizer invocations keep libc via Q3. |
| Q7 | Auto-opt-in wording (D10) | Symbol-based and automatic under `auto`, one build-log line naming the symbol; under an explicit `off` (`--libc off` / `LibcMode.Off`) a referenced libc symbol is an error naming it. Header-only imports never count. |

## Maintenance

As in the Zig/Rust adoption docs: a phase lands by moving its row out of
§4 with a dated pointer here; a decision that changes gets its D-number
amended in place; the *(verify)* marks are re-checked before the phase
that depends on them starts. The audit tables in §1 are the 2026-10-22
snapshot and are regenerated (the same greps) at P0 kickoff.
