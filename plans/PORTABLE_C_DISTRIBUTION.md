# Portable C distribution — publishing a compilable `yo.c`

**Working doc.** Same contract as `P1_CLI_PARITY.md` / `P2_RETIRE_SRC.md` /
`P3_DISTRIBUTION.md`: measured numbers, live status, traps recorded as found.
Opened 2026-08-15 from a user proposal; **revised the same day** after
research corrected two of the opening premises (both corrections are recorded
below rather than silently patched, because both were load-bearing).

## The goal

Publish a C file per release that a user can download and compile with
nothing but a C compiler, producing a working `yo` binary. This makes the
compiler bootstrappable from source without an existing Yo compiler, and gives
every platform we do not ship a bundle for a real installation path.

Requirements as stated by the user (2026-08-15):

1. `yo compile` grows a flag to save the generated C file, **with a
   user-specified file name or path**.
2. `yo build` and the build system grow an equivalent config option.
3. The `yo-self` C file is published to the GitHub Release.
4. **Codegen emits the SAME C on every platform**, using C preprocessor macros
   (`#if defined(_WIN32)` / `__APPLE__` / `__linux__`) instead of selecting the
   platform at Yo-codegen time.
5. CI compares the emitted C across all five targets and fails if they differ.
6. `install.sh` detects a platform with no native bundle and falls back to
   downloading the C file for the user to compile.

## Bottom line — ONE `yo.c`, built by concatenation (PROVEN 2026-08-15)

**Ship a single `yo.c`.** The decisive insight is that "one file" and "one
_merged_ file" are different goals, and only the second one is hard:

| design                                                                                                                | verdict                                            |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **B — concatenated arms**: each platform's COMPLETE emission wrapped in `#if defined(_WIN32)` / `__APPLE__` / `#else` | **works today, proven, zero evaluator work**       |
| **A — merged**: one copy of the shared ~99%, `#if` only at the divergences                                            | infeasible — see "Why MERGING is the wrong target" |

Design B satisfies requirement 4 exactly as stated ("use C macro in C file to
distinguish the platforms") and **every objection to design A evaporates**,
because each arm stays internally consistent: its Yo half and its C half come
from the same emitter run, so the shadow constant tables can never decouple,
and `detect_host()` is correct inside each arm.

### Measured, not assumed

Two experiments, both on this machine:

1. **Correctness** — real macOS-arm64 and Linux-x64 emissions of an async
   program, concatenated under `#if defined(__APPLE__)/#else/#endif`:
   compiles clean on macOS (`rc=0`) and the binary runs (`rc=0`).
2. **Scale** — the real 142 MB `yo-self` self-emit as the live arm plus four
   copies standing in for the other platform arms:

   | metric  | value                                            |
   | ------- | ------------------------------------------------ |
   | file    | **713,346,156 bytes (680 MB), 11,280,738 lines** |
   | compile | `rc=0`, binary passes `check std/assert.yo`      |
   | time    | **69.34 s** vs **68.65 s** for one arm alone     |

   **568 MB of skipped arms cost 0.7 s (+1%)**, because the preprocessor skips
   inactive blocks without tokenizing them. The size objection is dead.

Release asset: **~32 MB gzipped** for five arms (~6.4 MB each), or **~19 MB**
for three if the arch axis is collapsed (below).

### Gotcha found while proving it

The emitted `.c` does **not end with a newline**, so a naive
`{ cat a.c; echo '#else'; cat b.c; }` produces `}#else` — not a preprocessor
directive, since a directive must start a line — and BOTH arms compile,
yielding a flood of redefinition errors. The concatenation step must emit an
explicit newline before each directive. (This cost one confusing debugging
round; it looks exactly like the approach failing.)

### Five arms or three?

Five, initially. For ordinary user programs the arch axis is provably empty,
but **`yo-self` itself is not**: `yo-self/target.yo:165-184 detect_host()`
folds `arch ==` as well as `platform ==`, so the x64 and arm64 emissions of the
compiler differ in that constant. Collapsing to three arms means making
`detect_host` probe the arch at runtime — a small, independently valuable fix
(it is also part of what `issues/yo-self-cross-emit-host-constants.md` needs).
Gate it by emitting both arches and `cmp`-ing: let the measurement decide,
rather than assuming.

### Prerequisites specific to the one-file artifact

- **`issues/liburing-fallback-does-not-compile.md` must be fixed first.** The
  Linux arm currently fails to compile on a box without liburing headers, which
  is precisely the audience for a source distribution.
- **The Windows arm needs a Windows emission that does not exist yet.** The
  Windows self-build SEGVs (`issues/windows-no-main-worker-stack-rc139.md`) and
  cross-emitting it from Linux is blocked by
  `issues/yo-self-cross-emit-host-constants.md`. Ship with the arms that exist
  and add Windows when one of those two is fixed — a missing arm degrades to
  "unsupported platform" at the `#else`, not to a wrong build.
- Publish the **libc** allocator flavor: mimalloc-flavored C needs
  `vendor/mimalloc/src/static.c` alongside it, so it is not self-contained.

### Why the obvious objection is not the real one

The obstacle people expect is code volume; it is not. **81 comptime
`platform ==` / `arch ==` branch sites across 13 `std/` files and 2 `yo-self/`
files** are folded by the _evaluator_: `cond` evaluates only the taken branch
(`src/evaluator/exprs/cond.ts:200`), so the untaken arm never reaches the AST
and no `#if` can recover code that was never generated. Yet the leakage is
small — for a real program exercising `std/path` + `std/fs` + async, only
**16 of 2141** normalized changed lines (linux↔macos) and **14 of 5184**
(linux↔windows) touch evaluated-program symbols. **>99% of the OS diff is C
scaffolding that `#if` could unify**, and `c_include` (already used by
`std/libc/fcntl.yo:4-11`) is a proven in-tree way to defer a constant to the C
compiler.

So a staged migration _looks_ tractable. **The reason not to do it is
correctness, not volume** — see "Why MERGING is the wrong target (design A)". The same
~50 constants that look mechanical to migrate are exactly the ones with a
second, independently-authored copy in the C emitter.

### Superseded: what "per-target" would have meant

Publish **five** named files, one per release target
(`yo-v<ver>-<target>.c.gz`), even though the arch axis is provably empty and
only **three** are distinct. The naming keeps `install.sh` trivial — it already
sniffs os/arch to pick a bundle and can pick a `.c` the same way — and the two
duplicate uploads cost nothing.

The empty arch axis is still worth a gate, just a cheap one: assert
`linux-x64 C == linux-arm64 C` and `macos-x64 C == macos-arm64 C`. That is a
real regression check on arch leakage into codegen, and unlike cross-OS
identity it is true today.

## Measured baseline (2026-08-15)

Emitting the same async-heavy program for five target triples
(`compile --release --allocator mimalloc --target <t> --skip-c-compiler`):

| axis                     | result                         |
| ------------------------ | ------------------------------ |
| linux-x64 vs linux-arm64 | identical except label names   |
| macos-x64 vs macos-arm64 | identical except label names   |
| linux vs macos           | 2439 changed lines (of ~13.9k) |
| linux vs windows         | 5482 changed lines             |
| macos vs windows         | 5525 changed lines             |

Real `yo-self` emit, for sizing the artifact: **2,257,123 lines /
142,787,710 bytes, gzipping to 6,702,300 bytes** — a ~6.7 MB `.c.gz` release
asset, which is perfectly reasonable.

**The arch axis is empty, as a property of the code and not a coincidence:**
`src/codegen/` reads `targetInfo.arch` only in `exprs/asm.ts`, and neither
`std/` nor `yo-self/` contains a single `asm(...)`. `pointerSizeBits` is never
read in codegen at all, and is 64 for both x86_64 and aarch64. So the two
arm64 legs are free regression checks, not a fifth of the work.

### Correction 1 — the emitter that ships is already deterministic

The opening measurement ("298 changed lines between two identical runs") was
taken with `./yo-cli`, i.e. the **TypeScript** compiler, which P2.5 Group E
deletes. It has 13 `Math.random()`/`Date.now()` sites across 6 files of
`src/codegen/`, of which only `loop_`, `continue_` and `_yo_async_return_`
reach real emitted C — those account for 100% of the diff.

**`yo-self` is already byte-deterministic.** Its `random_id`
(`yo-self/utils.yo:90-98`) is a pure monotonic counter seeded from nothing —
no time, no address, no RNG — and its `module_path` argument is unused. The
bootstrap fixpoint gate independently proves byte-identity between emissions
from two different binaries.

So determinism is **not** a blocker for the shipping compiler. Two smaller
real issues remain in this area:

- **Counter ids make diffs fragile.** `yo_id_N` is assigned in traversal
  order, so the first divergence that consumes a different number of ids
  renumbers every identifier after it. A genuine 20-line difference presents
  as a near-total file diff. **Any comparison job must canonicalize
  `yo_id_\d+` / `__yo_t\d+` before classifying hunks**, or every failure looks
  identical and tells you nothing.
- **Neither compiler resets its codegen counters between compilations in one
  process**, so emitted C depends on how many files were compiled before it in
  batch mode. Determinism work must add a per-compilation reset.

### Correction 2 — `std/` _does_ branch on the platform at comptime

The opening claim "no comptime OS branching in `std/`" was produced by a grep
for `Os.Windows` / `is_windows`. The actual idiom is
`platform == Platform.Windows`, so the grep missed all of it.

Two counts appear in this doc; both are correct, for different queries.
`Platform.(Linux|Macos|Windows)` in `std/` alone gives **63 matches across 13
files**; widening to `platform ==|platform !=|arch ==|arch !=` and including
`yo-self/` gives **81 sites across 15 files**. The files:
`std/env.yo`, `std/sys/socket.yo` (25 sites alone),
`std/sys/{constants,mmap,clock,signals,sysinfo}.yo`, `std/fs/{dir,temp}.yo`,
`std/os/{env,signal}.yo`, `std/crypto/random.yo`, `std/libc/dyld.yo`, plus
`yo-self/target.yo` (16) and `yo-self/cache.yo`.

`src/evaluator/builtins/process.ts:42` folds `__yo_process_platform()` to a
literal string, and the untaken `cond` arm is eliminated before codegen.
`src/codegen/c/collection.ts:47-53` even documents deliberately _dropping_
includes that leak from eliminated branches.

These split into two classes:

- **~50 sites select only an integer constant** (socket/signal/mmap/clock/stat
  numbers, `PATH_SEPARATOR`). Mechanically re-expressible as C constants
  defined once under `#if` — at the cost of their comptime-ness.
- **~10 sites are structurally different call graphs** against different
  extern sets and headers. `std/env.yo`'s `current_exe` alone has three
  implementations (`GetModuleFileNameW` / `_NSGetExecutablePath` /
  `/proc/self/exe`). This is the hard blocker.

## The ASSEMBLED artifact, measured for the first time (2026-08-16)

The baseline above sizes **one arm**. This sizes what the `portable-c` job
actually publishes — all five arms through `scripts/make-portable-c.sh`.

Source: the five `portable-c-*` artifacts from release run **31909103188**
(the failed v0.2.6 attempt), reassembled locally with the real script.

| artifact                                       | bytes       |                       |
| ---------------------------------------------- | ----------- | --------------------- |
| `yo.c` assembled (5 arms)                      | 599,555,205 | 571.8 MB, 6,960,701 L |
| `yo-v0.2.6.c.gz` (`gzip -9`, the shipped form) | 35,073,706  | 33.4 MB               |

**The `.gz` had never been produced before this measurement.** In
`release.yml` the `gzip -9` step runs _after_ the `gcc -std=c11 -fsyntax-only`
check, and that check is what failed the job — so no run has ever reached the
compression step. 33.4 MB is the first real number for the published asset.

### gzip cannot see the arms as related, at all

| compression of the same 5 arms        | bytes      |
| ------------------------------------- | ---------- |
| each arm `gzip -9` separately, summed | 35,072,670 |
| the concatenated `yo.c`, `gzip -9`    | 35,073,706 |

Concatenating costs **1,036 bytes more** than compressing the arms
independently. gzip's 32 KB window cannot span a 114 MB arm, so the five arms
are five unrelated payloads and the assembly buys nothing at rest.

### Codec comparison — and why `.gz` should stay

| codec                | size    | vs gz | wall |
| -------------------- | ------- | ----- | ---- |
| `gzip -9` (shipped)  | 33.4 MB | —     | 7 s  |
| `zstd -12`           | 23.6 MB | −30%  | 2 s  |
| `zstd -19 --long=31` | 17.2 MB | −49%  | 73 s |

zstd wins the ratio decisively and should still **not** become the only
format. This artifact exists for the reader who has a C compiler and nothing
else; macOS ships no `zstd` and neither does Windows, so requiring one to
unpack it defeats its premise. If the ratio is wanted, publish **both** — one
extra step, `.gz` remains the guaranteed path.

### What the size actually costs: counter ids, quantified

The "Counter ids make diffs fragile" note under Correction 1 is right, and its
cost is larger than diff legibility. Diffing `linux-x64.c` against
`linux-arm64.c` over a 400 k-line window: **260,424 lines differ (65%)**. Every
difference is one shape —

```
< _yo538951a6_temp_56505_state_t     > _yo538951a6_temp_56512_state_t
< _yo538951a6_temp_54146_state_t     > _yo538951a6_temp_54153_state_t
```

— every counter offset by exactly **7**, i.e. one early platform-conditional
emitted 7 extra temps and renumbered everything after it. Normalize
`_temp_NNNNN` → `_temp_N` and the same diff falls to **2,748 lines (0.69%)**.
This confirms the baseline's "identical except label names" for the arch axis
and puts a number on it.

Alignment-free confirmation across all five arms, since the head-window diff is
only valid for the line-aligned same-OS pair:

| `zstd -12 --long=31` over the whole `yo.c` | bytes      |
| ------------------------------------------ | ---------- |
| as shipped                                 | 23,626,082 |
| with `_temp_NNNNN` normalized to `_temp_N` | 9,802,040  |

**2.4× smaller from renumbering alone** — and the normalized text is only 3.3%
smaller, so this is restored matchability, not a smaller input.

**This is a measurement, not a proposal.** Making ids content-derived rather
than sequential would recover it, but post-hoc id canonicalization has been
attempted and failed before (dyn keys plus memo duplicates), and the
correctness hazard in work item 2 above — dispose/dyn type-ids keyed on
emission order — sits in exactly this machinery. Recorded so the cost is known;
not sequenced.

### What this does NOT revive

None of the above argues for merging the arms into one `#if`-selected
translation unit. The shadow-constant-table refutation below is unaffected by
compression economics: the arms are redundant _at rest_, which is a packaging
fact, while merging them changes _when_ platform constants are chosen, which is
a correctness fact. Cheaper bytes are not a reason to reopen it.

## Why MERGING is the wrong target (design A)

The staged path below is _technically_ walkable. Two adversarial reviews
independently concluded it should not be walked. The decisive arguments:

### 1. The shadow constant tables (the correctness killer)

Platform constants are authored **twice**: once in `std/sys/constants.yo` as a
comptime `cond`, and again as **hardcoded literals in the C runtime emitter**.
`runtime-io-macos.ts:1222` is literally
`if (flags & 0x80) {  // AT_REMOVEDIR (macOS value)` while
`std/sys/constants.yo:16-19` folds `AT_REMOVEDIR` to `0x200` for Linux.

They agree today **only because one emitter run picks both for the same
target**. `#if` merging decouples them permanently: the Yo half freezes at emit
time, the C half is selected at C-compile time. Emit for Linux, compile on
macOS, and `0x100 & 0x20 == 0` makes `symlink_metadata` call `stat()` instead
of `lstat()` — every symlink silently reports its target's metadata and
`is_symlink()` is false. `0x200 & 0x80 == 0` makes `remove_dir` pass macOS's
`AT_REALDEV` instead of `AT_REMOVEDIR`. Socket options are worse: `SOL_SOCKET`
is 1 on Linux and 0xFFFF on macOS, `setsockopt` errors are discarded, so a
wrong level is invisible until an intermittent `EADDRINUSE` months later.

**All of this compiles, links, and runs on all five platforms**, and the
byte-identity gate is green _by construction_ because identity is the goal.
That is precisely the "compiles everywhere but subtly wrong on one platform"
outcome the request exists to avoid. `AT_FDCWD` survives the same mismatch
only by accident — see `issues/emitted-c-hardcodes-linux-at-fdcwd.md`.

### 2. The `detect_host()` fix is circular

Making the host a runtime probe (required, or one published file yields a
compiler permanently convinced it runs on the emitting OS) un-folds the ~81
`cond(platform == ...)` sites into **runtime** branches. Those branches call
symbols that do not exist to link against on the other platforms —
`std/env.yo:76,208,356` import `GetModuleFileNameW`/`_putenv_s` from
`./libc/windows`, `:269` imports `_NSGetExecutablePath`. So the fix for the
blocker reintroduces the blocker at link time. Escaping needs Yo `cond` arms to
lower into C `#if`/`#else` — a new emitter capability, not a tidy-up.

### 3. It buys no new platform reach

`#if` arms only exist for OSes the emitter already knows, so one file delivers
exactly the same five platforms that already have prebuilt bundles. The
distribution effort is identical either way — you ship a tarball regardless,
because the binary still needs `std/` sources at runtime.

### What the reviews did NOT object to (worth recording)

- **Compile cost is a non-issue.** Measured: `clang -O2` on the real 2.26 M-line
  / 142 MB self-emit takes **69.5 s / 3.17 GB peak** and yields a working
  8.7 MB binary. Adding all three OS runtimes is +0.35% of lines and ~0 time,
  since the preprocessor drops untaken arms.
- `--emit-c-to` is cheap and parity-safe.

### Work worth doing regardless of the one-file decision

1. `issues/liburing-fallback-does-not-compile.md` — the `#else` arm does not
   compile for programs using `sleep`. Breaks the "any C compiler" promise on
   Linux **today**.
2. Make dispose/dyn type-ids position-independent (key on the dispose function
   _name_, not emission order). They are a single dense counter shared by four
   allocators, baked as literals and consumed by a `switch`; an innocuous
   emitter reordering desynchronizes them into **wrong-dispose-function calls**
   — type-confused frees, with no compile error.
3. Strip the absolute checkout path out of emitted identifiers and comments
   (`yo-self/evaluator/types/struct.yo:83`, `enum.yo:217`) — needed for a
   credible published artifact regardless of file count. Deterministic and
   third-party-reproducible are different properties; only the second matters
   for a published file.
4. `src/codegen/exprs/async.ts:98` and `:1709` independently recompute
   `async_block_${Date.now()}` for names that must agree — if that fallback
   ever fires, the forward declaration and definition disagree and the C is
   invalid. A correctness bug, not a determinism one.

## What is genuinely tractable in the C emitter (for reference)

Should the one-file project ever be taken up, the codegen half is the _easy_
half — 20 call sites, 13 trivial, 4 moderate, 3 hard — and the research
established two strongly encouraging facts:

- **The async/sync runtime exposes an identical callable symbol set on all
  three OSes.** Only backend-internal helpers and state globals differ, so
  callers never diverge.
- **Of 46 shared typedefs, exactly one (`__yo_fs_event_t`) has genuinely
  different fields per OS.** Every other per-OS type is name-disjoint.
- The declaration head (~1530 lines: user structs, enums, RC/GC machinery) is
  already OS-independent between Linux and macOS except 3 include lines.
- Precedent for the technique already exists in-tree: the Linux io_uring
  backend is guarded by `#if __has_include(<liburing.h>)` with a complete
  same-symbol stub in the `#else` arm.

The hard codegen sites are the three I/O backends (~2.9k/3.25k/4.56k lines —
one file would carry all three), `c/collection.ts`'s data-dependent include
filter (includes carry no platform tag), the POSIX-vs-Windows `main` wrapper
(incompatible return types), and `parallelism/runtime.ts` (a signature-level
divergence). `exprs/inline-fns.ts:119` fires _inside an expression_, where
`#if` is not legal, and must become a macro.

### What one file would additionally require (the staged path)

In dependency order — each stage is independently valuable:

1. **Migrate the ~50 constant-only comptime branches to `c_include`**
   (`std/sys/constants.yo` first — it is also the fix for
   `issues/emitted-c-hardcodes-linux-at-fdcwd.md`). Mechanical, uses an
   existing in-tree mechanism, and removes most evaluated-program divergence.
   Cost: those constants stop being comptime-known.
2. **Restructure the ~10 structurally-different sites**, of which the hard
   core is **comptime-conditional `import()`**: `std/env.yo:76,108,208,269,356`
   import `./libc/windows` or `./libc/dyld` from _inside_ a `cond` arm, which
   changes the emitted top-level `#include` set. An evaluator that walks one
   branch cannot express this. `std/env.yo`'s `current_exe` alone has three
   implementations (`GetModuleFileNameW` / `_NSGetExecutablePath` /
   `/proc/self/exe`).
3. **`yo-self/target.yo:165-184 detect_host()` must become a runtime check.**
   It folds the compiler's own host identity at build time, and yo-self's
   `__yo_process_platform` reads `detect_host()` (the HOST) rather than the
   target. **One published C file would otherwise yield a compiler permanently
   convinced it runs on the OS the C was emitted for.**
4. The codegen `#if` work itself (the well-understood, cheap half).
5. `src/codegen/async/runtime-io-common.ts:579` registers one extra dispose
   type-id on Linux only, shifting every user `header.type_id` literal by one
   — so the OS choice leaks into the _user_ portion of the C, not just the
   runtime.
6. Everything twice: `yo-self/` is a faithful port with the same conditionals
   in the same places, and it is the compiler that generates the published
   file.

## Blocker for _any_ published artifact — absolute paths in the C

**This must be fixed before publishing anything**, and it is independent of
the platform question.

- TS derives every module id from `sha1("file://" + absolute path)`
  (`src/utils.ts:16-25`), so all C temp names change with the checkout dir.
- **`yo-self` is worse: it bakes the literal sanitized checkout path into C
  function identifiers** — `yo-self/evaluator/types/struct.yo:83` and
  `enum.yo:217` mint ids containing the module path with `/` and `.` replaced
  (111 occurrences in a 256 KB probe; 18 absolute paths also appear in
  comments).

So today's emitted C embeds the CI machine's checkout path
(`/home/runner/work/Yo/Yo` vs `/Users/runner/work/Yo/Yo` vs `D:\a\Yo\Yo`).
That alone makes a cross-platform byte-identity gate red on day one for a
reason unrelated to the OS axis, and it makes the published artifact
non-reproducible for third parties. **Fix at the emitter (repo-relative
paths), not by normalizing before comparison** — normalizing leaves the varying
bytes in the shipped file.

## Work items

### A. `yo compile --emit-c-to <path>` — small, ship first

**Current behaviour (verified):** the C file is **already written and never
deleted** — `yo compile -o foo` leaves `foo.c` beside the binary
(`src/codegen/index.ts:228-231`, `yo-self/main.yo:1312-1313`). `--emit-c`
means **print the C to stdout** (`src/module-manager.ts:501`,
`yo-self/main.yo:1291`) and does not touch the file; `--skip-c-compiler` only
gates the compiler invocation. So this is _path control over an artifact that
already exists_, ~10 lines in TS and ~12 in yo-self.

**Do not rename or repurpose `--emit-c`.** It is a boolean, and making it
value-taking would swallow the following flag as its value. It is used by 11
cli-cases, 12 invocations across 7 TS test files, 3 workflow lines, both
`fixpoint_only.sh` lines, `perf-repros/run.sh`, and AGENTS.md.

Semantics: redirect (not duplicate) the sidecar, create parent dirs, do **not**
imply `--skip-c-compiler`, and feed the same path to the C compiler when it
still runs.

Parity is enforced by construction — yo-self's compile parser throws on
unknown options, so a TS-only flag is an immediate differential failure. One
gap to close: on success TS prints `Generated C code written to <path>` and
`Skipping C compiler …`; **yo-self prints neither**. A cli-case will hit this
immediately.

### B. Build-system option

`std/build.yo`'s `Executable` (`:77-90`) gains `(emit_c_to : comptime_str) ?= ""`,
passed as a 7th positional to `__yo_build_executable`, stored on
`BuildArtifact`, consumed at 2 sites in TS and 1 in yo-self. **Note the
yo-self registry duplicates the struct literal 3 times — the field must be
added in 5 yo-self places, not 2.**

### C. Per-OS C artifacts on the release

Three files (linux, macos, windows). Traps:

- **Emit from the BUMP commit**, not `github.sha` — the version string lives in
  `yo-self/version.yo` and is rewritten by the release job, so it is compiled
  into the C. A job on `github.sha` publishes C claiming the previous version.
- The new job must be in `publish-release`'s `needs:`, or the release flips
  public without the C files — defeating the atomicity invariant `install.sh`
  depends on.
- **Publish the `libc` flavor, not mimalloc.** mimalloc-flavored C needs
  `vendor/mimalloc/src/static.c` at compile time, so it is _not_ a
  self-contained file. (`yo compile`'s default is already `libc`; every CI
  emit explicitly passes `--allocator mimalloc`.)
- Reuse the existing emit-only step verbatim — `build-linux-musl-static`'s
  "Stage 1 (Yo → C only)" (`test.yml:773-779`).

### D. The identity gate — re-scoped, and shaped as a ratchet

Assert `linux-x64 == linux-arm64` and `macos-x64 == macos-arm64`. Notes:

- **Do not cross-emit all targets from one host.** Blocked by the open bug
  `issues/yo-self-cross-emit-host-constants.md`: the self-hosted evaluator
  resolves target-conditional constants for the HOST, not `--target`, so a
  macOS→linux cross-emit bakes macOS's `AT_FDCWD` (-2) where Linux needs -100.
- Cheapest honest slot is the existing 5-leg `test` matrix, which already
  builds stage-1 from PR sources on every platform — but note
  `test (macos-26-intel)` and `test (ubuntu-24.04-arm)` are **not** required
  checks, so the arch legs would upload without gating.
- Report failures with canonicalized ids + hunk bucketing + `cmp`'s
  first-differing offset. A raw `diff -u` of two 2.26 M-line files is useless.
- **Adding a job carries no branch-protection hazard** — an unlisted job runs
  and simply does not gate. _Renaming or deleting_ a listed job is what blocks
  every PR forever (ruleset 13548862, 15 hand-listed contexts). So a new job
  can land first and be promoted to required in a follow-up.
- If it goes in a new workflow file, do **not** give it `paths:` filters and
  then make it required — PRs touching no matching path would get a
  permanently-pending check.

### E. `install.sh` source fallback

Two triggers, both requested by the user (2026-08-15):

1. **Automatic** — the platform has no native bundle (i.e. not linux/macOS on
   a released arch). Detect and fall back to the source path instead of
   failing.
2. **Explicit** — new options `-cc` / `--c-compiler <cc>` and `-cflags` /
   `--c-flags <flags>`. **If either is provided, take the source path
   regardless of platform**: download the `.c` and compile it with exactly the
   compiler and flags given. This makes the source install a first-class,
   testable path on platforms that _do_ have bundles, rather than dead code
   that only runs on machines we cannot test — which is the difference between
   a fallback that works and one that is discovered broken by its first user.

Design notes:

- Quote `$CFLAGS` correctly — the user's flags are a word list, not one
  argument. `install.ps1` needs the same pair for parity.
- Reuse the existing verification step: the installer already **compiles and
  runs a hello world** rather than checking a version string, which is exactly
  the assertion a source install needs.
- Default the compiler to the existing `clang`-then-`gcc` probe when `-cc` is
  absent but the source path was taken automatically.

Prerequisites to document per platform:

- **The liburing trap, which this path makes MORE likely to be hit.** The
  Linux C gates its whole io_uring subsystem on
  `#if __has_include(<liburing.h>)`, and the `#else` arm is stubs that only
  warn. Since the compiler reads every source file through `io.await`, a user
  who compiles without liburing headers gets a binary that **links cleanly,
  runs, and compiles nothing**, with one stderr line as the only clue.
  `install.sh` must check for liburing **and** pkg-config together and refuse
  loudly. (`-luring` is added only when `pkg-config --exists liburing`
  succeeds, so header-without-pkg-config is strictly worse than neither.)
- Windows: determine whether the emitted C compiles with MSVC `cl` or requires
  clang/gcc.

### F. Relationship to P3 item 3 (static musl)

Overlapping goals, different coverage. A portable C file covers FreeBSD, other
arches, and anything we never build a bundle for, because the user's own C
compiler targets their own libc — so it is a **more general** fix for the
Alpine/NixOS class than static-musl bundles, which are Linux-only. It does not
replace item 3: a prebuilt static binary is a much better default experience
than "compile this yourself". Keep both; document the C file as the universal
fallback.

## Sequencing

1. **A + B** (flag + build option) — small, independent, immediately useful.
2. **Absolute-path fix** (the "Blocker for any published artifact" section) —
   required before publishing, and valuable on its own for reproducibility.
3. **C** (per-OS artifacts) then **E** (installer fallback).
4. **D** (arch-identity ratchet) any time after A.
5. "One universal C file" — only if it is ever worth the evaluator work; the
   codegen half is well understood and cheap, the evaluator half is not.
