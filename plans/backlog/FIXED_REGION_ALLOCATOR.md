# Fixed-Region Allocator — `--allocator fixed`

> **Status: BACKLOG (proposed 2026-09-09)** — design written, nothing started.
> A third choice for `--allocator` / `build.Allocator`: a general-purpose
> allocator that serves every Yo allocation out of ONE statically-sized region
> chosen at compile time, with no call into the libc heap. It is the first
> building block of an embedded/freestanding story (§6) and is useful on the
> desktop targets on day one (§1.3). Line anchors are against `develop` at
> `c664226ac` (2026-09-09).

## 0. Verdict

The idea is sound, with one correction to the shape.

**What "fixed-size buffer allocator" must mean here.** Zig's
`FixedBufferAllocator` is a *bump* allocator: `free` is a no-op except for the
most recent block. That works in Zig because every collection takes an
allocator argument, so a bump region is scoped to one data structure and
dropped as a whole. Yo has ONE process-wide allocator (`GlobalAllocator`,
`std/allocator.yo`) behind reference counting, so blocks are released in
arbitrary order and a bump region would leak until exhaustion within seconds.
What Yo needs — and what embedded RTOSes actually ship (FreeRTOS `heap_4`,
Zephyr `sys_heap`, TLSF in μC/OS, o1heap in PX4) — is a **fixed-REGION
general-purpose allocator**: real `malloc`/`realloc`/`free` over a static
buffer, with O(1) operations and bounded fragmentation. This document plans
that, and calls the option `fixed`.

**It is storage, not stack.** The region is a `static` array in `.bss`, not
memory carved from the C stack. A multi-megabyte region on the stack would
have to live inside the 1 GiB worker thread `main` already spawns
(`src/codegen/functions/generation.yo:1231`) — the very thing an embedded
target cannot afford — and would vanish when `main` returns while module
globals are still being disposed.

**Why it is worth doing before any embedded target exists.**

1. The plumbing is already the right shape: every allocation the compiler
   emits goes through the `__yo_malloc` / `__yo_calloc` / `__yo_realloc` /
   `__yo_free` / `__yo_aligned_alloc` / `__yo_aligned_free` family. There are
   **zero** raw `malloc`/`free` calls in `src/codegen/` (measured 2026-09-09;
   §1.1). A new allocator is one more branch of the compat block in
   `src/codegen/c/collection.yo:118`.
2. It gives the test suite a **deterministic out-of-memory oracle**. Today OOM is
   unreachable on desktop (overcommit) and untestable; a 256 KiB heap makes it
   an ordinary, reproducible input. This is what makes the std API decision
   D9 (`push` infallible, `try_push` fallible — `plans/STD_API_STABILIZATION.md`)
   actually exercisable.
3. It gives a **portable leak oracle**: an allocator that owns every block can
   report live bytes/blocks at exit, on every target, with no sanitizer. ASan
   is AMFI-blocked on macOS 26 and mimalloc's statistics are per-heap; neither
   is a suite-wide gate today.
4. It removes the libc heap from the emitted program's dependency set, which
   is the first line item of every freestanding port.

**What it is NOT.** Not a per-collection allocator parameter (Zig-style); Yo
keeps one global allocator. Not a bare-metal target; the allocator is the
smallest of the embedded blockers, and §6 lists the others so this design
composes with them rather than being redone later. Not a bundle allocator:
the compiler's own self-build peaks at 11–20 GB and stays on the system
allocator / mimalloc.

## 1. Where allocation happens today (measured 2026-09-09)

### 1.1 Emission sites of the `__yo_*` family in `src/codegen/`

| file | sites | what |
| --- | ---: | --- |
| `async/runtime_io_windows.yo` | 131 | IOCP runtime |
| `async/runtime_io_common.yo` | 38 | shared async I/O |
| `async/runtime_io_macos.yo` | 26 | kqueue runtime |
| `async/runtime_io_linux.yo` | 25 | epoll runtime |
| `c/collection.yo` | 16 | the compat block itself (§1.2) |
| `functions/gc_runtime.yo` | 11 | RC/GC dispose paths (`__yo_free` of headers) |
| `parallelism/runtime.yo` | 9 | worker threads, task queues — **allocates from non-main threads** (`:147`, `:301`) |
| `async/runtime_io_wasm.yo` | 8 | wasm runtime |
| `async/runtime_core.yo` | 4 | futures |
| `exprs/parallelism.yo`, `exprs/async.yo` | 3 + 3 | per-expression |
| `functions/constructors.yo` | 2 | RC object constructors (`:88`, `:580`) |
| `types/generation.yo` | 1 | isolated values (`:1427`) |
| `functions/dyn.yo` | 1 | `dyn` boxes (`:144`) |
| `functions/generation.yo`, `exprs/other_fn_call.yo` | 1 + 1 | |
| **raw `malloc`/`calloc`/`realloc`/`free`** | **0** | nothing bypasses the family |

`std/` reaches the same family through `GlobalAllocator` (28 files import it).
`std/env.yo:355–372` already documents the one rule a non-libc allocator
imposes — buffers handed out by the OS/libc must never be released through
`GlobalAllocator` — because mimalloc enforces it today (`mi_free: invalid
pointer`). The fixed allocator inherits that rule unchanged.

### 1.2 The switch

| where | what | anchor |
| --- | --- | --- |
| `src/codegen/c/collection.yo` | the compat block: `mimalloc` arm (with `__has_include` fallback) and `system` arm; both split `aligned_alloc`/`aligned_free` on Windows (`_aligned_malloc`/`_aligned_free`) | `:118–176` |
| `src/codegen/utils/index.yo` | `CodeGenContext.allocator : String`, "already resolved: mimalloc or system" | `:192`, `:311` |
| `src/main.yo` | `--allocator` parsing (`:2057`), validation `invalid --allocator … Choices: mimalloc, system` (`:2232`), wasm downgrade mimalloc→system before codegen (`:2331`), `compile_module` call (`:2472`), link-line + "Using … allocator" message (`:2750–2763`), en/zh help lines (`:4832`, `:4873`) | |
| `std/build.yo` | `Allocator :: enum(Mimalloc, System)` (`:35`), `alloc_str` mapping (`:304`) | |
| `src/evaluator/builtins/build.yo` | build-API pass-through, default `"mimalloc"` (`:1112`) | |
| `yo test` | forwards `--optimize` (`:3495`) and `--sanitize` (`:3514`) to the batch compile but **not** `--allocator` — the runner cannot exercise an allocator today | |
| `.github/workflows/release.yml` | `bundle_allocator` matrix (macOS/Linux/Windows bundles all `system`; mimalloc opt-in) | `:449–496` |

### 1.3 OOM is undefined behaviour today

The RC constructors use the result of `__yo_malloc(sizeof(T))` without a NULL
check (`constructors.yo:88`, `:580`; `dyn.yo:144`; `types/generation.yo:1427`).
Under overcommit this never fires, so nobody noticed. With a finite heap OOM
is a normal event and a NULL deref would be the observable behaviour. Fixing
this (§2.5, phase P0) is a prerequisite that applies to ALL allocators, not a
feature of the new one.

## 2. Design

### 2.1 Algorithm: TLSF, written into the emitted C

**Choice: two-level segregated fit (TLSF)** — O(1) `malloc`, `free` and
in-place `realloc`, bounded and low fragmentation, the standard answer in
real-time embedded work.

Considered and rejected:

| candidate | why not |
| --- | --- |
| bump / arena (Zig `FixedBufferAllocator`) | no `free`; incompatible with RC release order (§0) |
| size-class free lists, no coalescing | simple, but fragmentation is unbounded across classes — a long-running program migrates memory into the wrong class and OOMs with most of the region free |
| first-fit linked list (FreeRTOS `heap_4`) | O(n) per operation; fine for a firmware, wrong for a language runtime doing millions of RC allocations |
| vendoring mattconte/tlsf or o1heap | a second C file on the link line breaks the single-file `yo.c` distribution (`plans/reference/PORTABLE_C_DISTRIBUTION.md`) and adds a licence line; the algorithm is ~300 lines |

Parameters: `FL_INDEX_MAX = 32` (blocks up to 4 GiB), `SL_INDEX_COUNT = 32`
(second-level split into 32 classes), minimum block 16 bytes, granule
`alignof(max_align_t)` (16 on every supported target). Control block ≈ 8 KiB
+ bitmaps, carved from the front of the region. Block header = size word
(low bits: `this_free`, `prev_free`) + pointer to the previous physical block,
so `free` coalesces both neighbours in O(1).

Operations:

- `__yo_fixed_malloc(size)` — round up to granule, map to (fl, sl), take the
  first non-empty class at or above, split the remainder back into the free
  lists if ≥ minimum block.
- `__yo_fixed_calloc(n, size)` — overflow-checked multiply (`n != 0 && size >
  SIZE_MAX / n` → NULL), then `malloc` + `memset`.
- `__yo_fixed_realloc(p, size)` — shrink in place; grow in place when the next
  physical block is free and large enough; otherwise `malloc` + `memcpy` +
  `free`. Never touches the original block on failure (the contract
  `GlobalAllocator.realloc` documents).
- `__yo_fixed_free(p)` — NULL is a no-op; coalesce and reinsert.
- `__yo_fixed_aligned_alloc(alignment, size)` — over-allocate by `alignment +
  header`, split off the misaligned front as a free block (TLSF supports this
  natively). **One family only**: `__yo_aligned_free` is `__yo_fixed_free`,
  exactly as the mimalloc arm does. The Windows `_aligned_malloc` /
  `_aligned_free` split (`std/allocator.yo` doc comment) does not exist under
  `fixed` on any target.

The C is emitted by codegen, in the same place and style as the existing arms
(`emit_header_line` blocks), so the fixpoint gate keeps comparing plain
emitted C and the `--emit-c` output stays self-contained. Whether the ~300
lines live in `collection.yo` itself or in a new `src/codegen/c/allocator_fixed.yo`
is decided at implementation time (creating a new `.yo` file needs an explicit
go-ahead per `AGENTS.md`); the recommendation is the new file, mirroring how
the async runtimes are one file per flavour.

### 2.2 Region storage and sizing

```c
#define __yo_FIXED_HEAP_BYTES ((size_t)16777216)          /* from --heap-size */
static _Alignas(16) uint8_t __yo_fixed_heap_region[__yo_FIXED_HEAP_BYTES];
```

- **Static `.bss` storage.** No `malloc`, no `mmap`, no startup call. This is
  what makes it a freestanding candidate: the linker script decides where the
  region lives.
- **Size is a compile-time constant**: `--heap-size <n>[K|M|G]` on the CLI
  (`16M` default; `64K` minimum — the control block alone needs ~8 KiB), and
  `heap_size : usize` on the build-API artifact config. Passing `--heap-size`
  with any other allocator is an error, not a silent ignore.
- **No environment override.** `YO_MAIN_STACK_MB`-style `getenv` tuning is
  deliberately absent: an embedded target has no environment, and the region
  must be a link-time constant for the linker script to place it.
- **Library mode (P4).** When compiling a static library (`static_library`,
  `--static-lib`), the region can instead be supplied by the host:
  `--heap-extern` emits `extern uint8_t __yo_fixed_heap_region[]; extern const
  size_t __yo_fixed_heap_bytes;` and initializes lazily on first allocation.
  That is how a C firmware links a Yo library and places the heap in a chosen
  memory section. Not in the first PR.
- **Initialization.** The control block is set up on first use (a `static
  bool` check on the fast path costs one predictable branch) rather than in a
  constructor attribute, because module-global initializers (`__yo_main_module_init`)
  allocate before `main` runs and constructor-attribute order across TUs is
  the classic portability trap.

### 2.3 Thread safety

Yo's async runtime is single-threaded (no lock needed), but the **parallelism
runtime allocates and frees from worker threads** (`parallelism/runtime.yo:147`,
`:301`, and every RC drop that happens on a worker). So the allocator must be
thread-safe whenever parallelism is in use.

Decision: **always guard with a C11 `atomic_flag` spinlock**, never a
`pthread_mutex` (embedded targets have no pthreads; `atomic_flag` is the one
atomic C11 guarantees lock-free). Cost is one uncontended CAS per operation,
which is irrelevant for the intended uses. The alternative — emit the
lock-free variant when `get_uses_parallelism()` (`utils/index.yo:66`) is false
— is rejected because that flag is set while function bodies are generated,
AFTER the includes/allocator block has been emitted (see
`yo-codegen-c-includes-collected-before-bodies`), so the decision would need a
second late emission point for a saving nobody measured. Revisit only with a
number.

### 2.4 Statistics, `--debug-heap`, and the leak oracle

The allocator keeps four counters: `live_bytes`, `live_blocks`, `peak_bytes`,
`alloc_count`. A new `--debug-heap` compile flag (same family as `--debug-gc`,
`--debug-parallelism`, `--debug-async-await`, which already ride on
`CodeGenContext`) registers an `atexit` reporter (a plain call at the end of
the direct-call `main` on wasm/freestanding) that prints:

```
heap: peak 1.2 MiB of 16.0 MiB, 48213 allocations, live at exit: 0 blocks / 0 bytes
```

**Non-zero live at exit is the leak oracle.** This is the payoff for the test
suite: an allocator-level leak check that works on every target, under every
CI leg, without ASan or mimalloc. Before it can gate anything, the baseline
has to be measured: module globals, interned strings and anything the GC
runtime deliberately leaves alive at process exit will show as "live". P3
below is that measurement and classification; turning the oracle into a CI
gate is a separate decision after the numbers are in.

### 2.5 Out-of-memory policy (all allocators)

Introduce one runtime helper and route the unchecked sites through it:

```c
static void* __yo_rc_alloc(size_t size) {
  void* p = __yo_malloc(size);
  if (p == NULL) __yo_alloc_fail(size);   /* noreturn */
  return p;
}
```

`__yo_alloc_fail` prints `out of memory: requested N bytes` (plus `heap M
bytes, live L bytes` under `fixed`) to stderr and calls `abort()`. This is a
**panic**, not an unwind: an RC constructor has no `Result` to return, and the
language already treats allocation of an object as infallible — matching Rust's
`alloc::handle_alloc_error` and the D9 decision (`push` infallible). The
fallible surface stays where it is: `GlobalAllocator.malloc` returns `?*void`,
and `try_push`/`try_reserve`-style APIs are what a program that wants to
survive OOM calls.

Sites to convert: `constructors.yo:88`, `:580`; `dyn.yo:144`;
`types/generation.yo:1427`; plus an audit of the runtime files in §1.1 for
`__yo_malloc` results used without a check (the async runtimes mostly check
already; the parallelism runtime `:147`, `:301` do not).

This lands FIRST (P0) under the existing allocators because it fixes a latent
UB regardless of the new option, and because it changes emitted C: run the
fixpoint gate and the byte-identity corpus on it alone, so any later diff is
attributable to the allocator arm.

Making the hook overridable (weak symbol on ELF/Mach-O, `/ALTERNATENAME` on
MSVC) so a firmware can reset instead of `abort()` is P4, with the extern
region.

### 2.6 User-facing surface

| surface | change |
| --- | --- |
| `yo compile` | `--allocator fixed`; `--heap-size <n>[K\|M\|G]` (only with `fixed`); `--debug-heap` |
| `yo test` | forwards `--allocator` (and `--heap-size`) to the batch compile like `--optimize`/`--sanitize` — without this the suite cannot run under `fixed` at all |
| `std/build.yo` | `Allocator.Fixed`; `(heap_size : usize) ?= 16 MiB` on the artifact config; `alloc_str` gains `.Fixed => "fixed"` |
| `src/evaluator/builtins/build.yo` | pass `heap_size` through next to `allocator` |
| message parity | `Using fixed-region allocator (16 MiB heap)` beside "Using system allocator" / "Using bundled mimalloc" |
| wasm | `fixed` is allowed on wasm (it is the one allocator that needs nothing from the host); the mimalloc→system downgrade at `main.yo:2331` is untouched |
| docs | `docs/en-US/BUILD_SYSTEM.md` §Allocators (`:152`) and its `zh-CN` twin; `.github/instructions/c-codegen.instructions.md` §Memory allocator options; `std/allocator.yo`'s `GlobalAllocator` doc comment (the "two families" table gains the note that `fixed` has one) |

**Seed gate.** Adding `Allocator.Fixed` to `std/build.yo` is source-compatible
with the seed (`yo build` evaluates the tree's `std/build.yo` with the seed
binary, which only sees the string it produces). What must NOT happen until
the seed ships the feature is the repo-root `build.yo` or any `std/` code
*using* `Allocator.Fixed` or the new flags — same two-release sequencing as
every seed-gated form (`yo-seed-gate-blocks-std-using-new-runtime-macros`).
User projects are unaffected: they pin their own version.

## 3. Phases

Each phase is one PR. Verification steps are the acceptance test.

### P0 — OOM hardening (all allocators)

1. Add `__yo_alloc_fail` + `__yo_rc_alloc` to the runtime prelude in
   `collection.yo`; convert the sites in §2.5.
2. Verify: `yo check ./src`; `yo compile src/main.yo --skip-c-compiler`;
   fixpoint (`scripts/bootstrap/fixpoint_only.sh`); `tests/rc.test.yo`,
   `tests/ptr.test.yo`, `tests/allocator.test.yo`, `tests/dyn.test.yo`; byte-identity
   corpus diff shows ONLY the new helper + the converted call sites.
3. No test can force system-malloc failure, so P0's behavioural test arrives
   with P1 (a cli-case that allocates past a 64 KiB `fixed` heap and matches
   the `out of memory` line — the `build run` + `stdout_keep_match` pattern).

### P1 — the allocator

1. Emit the TLSF arm behind `context.allocator == "fixed"`; thread `heap_size`
   through `CodeGenContext`; validation + help text in `main.yo` (both
   languages); forward `--allocator`/`--heap-size` in `yo test`.
2. Tests:
   - `tests/cli-cases/compile-allocator-fixed/` — `build run` a program that
     exercises malloc/realloc/free/aligned_alloc in mixed order, checks
     `GlobalAllocator.aligned_alloc` contract from `tests/allocator.test.yo`
     holds, and prints a checksum.
   - `tests/cli-cases/compile-allocator-fixed-oom/` — the OOM panic line.
   - `tests/cli-cases/compile-heap-size-requires-fixed/` — the flag error.
   - Re-record `tests/cli-cases/help-compile` (new flag lines).
   - Run the language suite once under `fixed`:
     `yo test ./tests --exclude tests/internal --exclude tests/cli-cases
     --allocator fixed --heap-size 512M`. Every failure is either a suite test
     that needs more than 512 MiB (raise, record) or an allocator bug.
3. Verify fixpoint is unchanged (the bundle allocator is not `fixed`, so
   stage-2/3 C must be byte-identical to P0's).

### P2 — build API and docs

`Allocator.Fixed`, `heap_size`, pass-through in `builtins/build.yo`, a
`tests/internal/build_runner.test.yo` case, `BUILD_SYSTEM.md` en + zh-CN,
`c-codegen.instructions.md`, the `std/allocator.yo` doc comment. The seed-gate
note in §2.6 applies: no `std/`/`build.yo` consumer.

### P3 — `--debug-heap` and the leak baseline

Counters + reporter; then run the whole language suite under `fixed
--debug-heap` and classify every non-zero "live at exit" (module globals, GC
immortals, genuine leaks → `issues/`). Output: a table in this document and a
decision on whether the oracle becomes a CI leg.

### P4 — library mode

`--heap-extern` region, weak `__yo_alloc_fail`, and a cli-case that links a
Yo static library into a C `main` that supplies the region. This is the first
PR that a firmware author could actually use.

## 4. Risks and non-goals

- **Never the bundle allocator.** The compiler's self-build needs 11–20 GB
  with a fragmentation profile TLSF was not measured on. `release.yml`'s
  `bundle_allocator` matrix stays `system`.
- **Speed vs mimalloc.** TLSF with a global spinlock will be slower than
  mimalloc on allocation-heavy multi-threaded programs. Irrelevant for the
  intended uses; documented, not optimized.
- **Goldens.** `help-compile` and any cli-case whose `expected_stdout` prints
  "Using system allocator" (`compile-emit-chunks`) are re-recorded with the
  in-repo binary (`yo-cli-cases-skill-goldens-track-bundled-skill-files`
  pattern), and the full cli-diff scorecard is rerun after.
- **Region size is a footgun for the runner.** A suite run under `fixed` needs
  a heap sized for the largest test batch, not the average; the runner inlines
  every test body of a file into one `__yo_user_main`.

## 5. Open decisions

| decision | recommendation |
| --- | --- |
| option name | `fixed` (`static` reads as "static linking"; `arena` promises a bump allocator) |
| default `--heap-size` | 16 MiB — large enough that a desktop user who types `--allocator fixed` out of curiosity gets a working program, small enough to be a real constraint |
| hand-written TLSF vs vendored | hand-written, emitted (§2.1) |
| where the emitter lives | new `src/codegen/c/allocator_fixed.yo` (needs the explicit go-ahead) |
| lock | always-on `atomic_flag` (§2.3); revisit with a measurement |
| leak oracle as CI gate | decide after P3's baseline table |

## 6. The rest of the embedded road (out of scope, recorded so this composes)

The allocator is item 1 of roughly seven. Nothing here is planned; each is
listed with the current anchor so the allocator's choices (static `.bss`
region, no `getenv`, no pthreads, a `noreturn` OOM hook, single alloc family)
are known to be compatible with it.

1. **`main` wrapper.** POSIX and Windows spawn a 1 GiB-stack worker thread
   (`functions/generation.yo:1231`); wasm already uses a direct-call `main`
   (`:1302`). A freestanding OS would take the wasm arm; the stack is the
   linker script's business.
2. **Unconditional headers.** `collection.yo` includes `<unistd.h>`,
   `<sys/stat.h>`, `<sys/random.h>` on every non-Windows target and pthread
   throughout. These become OS-gated.
3. **Runtimes.** The async I/O runtime is per-OS (kqueue/epoll/IOCP/wasm) and
   the parallelism runtime is pthread-based. A freestanding target would emit
   neither, or a polling async runtime; programs using them fail to compile
   with a diagnostic rather than link to nothing.
4. **Target vocabulary.** `--target` is the closed Rust-triple set
   (`plans/reference/TARGET_TRIPLES.md`). Embedded means adding `Os.None` in
   `src/target.yo` and triples like `thumbv7em-none-eabihf`,
   `riscv32imac-unknown-none-elf`, with cfg name `none`.
5. **std split.** The prelude and the collections need only
   `GlobalAllocator`; `std/libc/*`, `std/fs`, `std/net`, `std/process`,
   `std/env` need an OS. A `cfg(target_os = "none")` profile of std is the
   large item; `plans/STD_API_STABILIZATION.md` owns the API it would freeze.
6. **Panic output.** `assert`/`panic` and `__yo_alloc_fail` write to stderr
   via stdio; freestanding needs a `__yo_panic_write(const char*, size_t)`
   hook (the same weak-symbol mechanism as §2.5).
7. **Binary size.** `Optimize.ReleaseSmall` already exists (`std/build.yo`);
   what it lacks is a size budget test.

## 7. References

- `std/allocator.yo` — `GlobalAllocator`, the two-family contract.
- `src/codegen/c/collection.yo:118–176` — today's compat block.
- `plans/archive/MIMALLOC.md`, `plans/reference/WINDOWS_ALLOCATOR_DECISION.md`
  — how the second allocator landed and the A/B that settled the Windows
  default.
- `plans/reference/PORTABLE_C_DISTRIBUTION.md` — why nothing new joins the
  link line.
- `plans/STD_API_STABILIZATION.md` — D9 (`push` / `try_push`), the fallible
  surface this allocator makes testable.
- `plans/ROADMAP.md` Phase 5 (targets & ecosystem) — where an embedded target
  would be scheduled.
- Masmano, Ripoll, Crespo, Real — *TLSF: a New Dynamic Memory Allocator for
  Real-Time Systems* (ECRTS 2004).
