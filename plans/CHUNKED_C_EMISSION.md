# Chunked C emission + parallel/cached clang

**Status: STEPS 0-5 COMPLETE (2026-08-23) — step 1 #233, step 2 #234,
LTO-by-opt-level #235, step 3 + gates + build surface #236. Remaining items are
deliberate deferrals, listed under "What is intentionally not done".**

Goal was `yo build`'s C leg: clang -O2 on the single ~148 MB emitted `yo.c`,
measured **74.8 s single-threaded** (step 0 baseline, M4, of a ~210 s full
rebuild). Split the emitted program into N translation units compiled in
parallel with a content-hashed `.o` cache, then link. Opt-in
(`--emit-chunks N`, default 0 = today's single file, bit-for-bit): the
single-file `yo.c` is a DISTRIBUTION REQUIREMENT
(`plans/PORTABLE_C_DISTRIBUTION.md`), and the bootstrap fixpoint gates
compare default emissions.

## Outcome

| self-build, `--release` | total | C phase |
|---|---|---|
| single-file (default, unchanged) | 209.7 s | 72.3 s |
| chunked N=8, cold cache | **171.5 s** | ~34.1 s |
| chunked N=4, warm cache | **161.7 s** | ~24 s (link only) |

So the C leg roughly halves, and a no-change rebuild's chunk phase collapses to
a cached link. **The more useful result is what that leaves behind:** a warm
chunked build is 137.4 s of evaluation plus a ~24 s ThinLTO link, i.e. the
EVALUATOR is now 85% of a cached rebuild. Further chunk-side work cannot buy
much; the next real levers are cross-process incremental evaluation (the
deferred original Phase C of `plans/INCREMENTAL_COMPILATION.md`) and
content-stable symbol naming, which is also what would make the `.o` cache pay
off for ordinary source edits rather than only for flag changes.

Correctness is gated two ways beyond `check`: the full language suite passes ON
A CHUNKED-BUILT compiler (2802 passed / 0 failed), and a chunked-built compiler
emits **byte-identical** C to a single-file-built one
(`scripts/bootstrap/chunked_gate.sh`).

## What is intentionally not done

- **Chunking stays opt-in.** The four conditions for flipping the default are
  under "Chunk count" below; three now hold, and the fourth (auto-N) is blocked
  on a std CPU-count API.
- **Auto-N** — blocked: `std` has no `available_parallelism`, and there is no
  `YO_JOBS` override yet. The N sweep below says the target is ~8, not
  "2x cores".
- **The behavioural fixpoint gate is a script, not a CI job** — two self-builds
  plus two self-emits (~12 min, heavy RAM) to guard an opt-in flag no default
  path uses.
- **`io.spawn` in a loop still hangs**
  (`issues/io-spawn-in-loop-or-recursion-hangs.md`). Root-caused, with a
  verified workaround; the driver sidesteps it entirely by generating a shell
  script. Fixing it properly needs `JoinHandle` to own its future, which is an
  async-runtime correctness project rather than build-perf work.
- **mimalloc's `static.c`** is still compiled by the link command rather than
  as one more parallel job.

## Ground truth

- Emitter: three buffers — `headers`, `declarations`, `code` — concatenated
  by `Emitter.print()` (src/emitter.yo:305). `compile_module`
  (src/codegen/codegen_c.yo:289-410) returns the single String;
  `run_compile` writes it and runs ONE `cc` Command (src/main.yo:1477,
  :1733).
- The per-function boundary is exact: `generate_all_functions`'s loop
  (src/codegen/functions/generation.yo:691-713), one `generate_function`
  call per function at :705, and ~95% of the emitted bytes. Do NOT rotate
  files mid-stream: specializations are minted mid-emission (the loop
  re-reads `function_order.len()`), and `generate_function` can truncate the
  buffer tail (superseded-stub rewrite :629-645) — a function's extent is
  final only when the call returns. Record `(c_name, start, end)` byte
  ranges instead and slice post-emission; everything outside the ranges
  (runtimes before the loop; dyn/async/main/dispatch after) is chunk-0
  residue in original order.

## Linkage split (the risk mass)

**Step-2 implementation refinements (2026-08-23, src/codegen/chunk_assembly.yo):**

- **The runtime allowlist is replaced by an AUTO-DEQUALIFIER.** The assembly
  pass computes the *defined-in-header* name set (static definitions already
  living in the declarations buffer — atomics, dyn wrappers — plus the
  header-routed constructor/traverse block and the RC-helper ranges), then
  strips the `static [inline]` prefix from every column-0 static FUNCTION
  line (prototype and definition alike) whose name is NOT in that set. One
  rule drives both sides, so prototype and definition linkage can never
  disagree, and there is no hand-maintained list to rot. `static` DATA lines
  are never touched by the dequalifier — address-identity statics and
  cross-chunk globals are split at their emission sites under
  `CodeGenContext.chunk_mode` (typeids via `emit_typeid_static`, TLS
  unwind/effect buffers, argv shim, module-level vars → extern in the
  header + one definition in `chunk_globals`, prepended to chunk 0).
- **Dyn vtables stay per-TU static in the header** (no extern split): the
  emitted C compares only `vtable->__yo_type_id` (downcast.yo) — vtable
  ADDRESSES are stored and dereferenced, never compared — and the wrapper
  functions they reference are per-TU header statics anyway. Only the
  `__yo_typeid_*` chars need the extern/chunk-0 split.
- **Constructors + traverse functions** are routed to the header as one
  recorded byte-range block (per-TU `static` copies; each TU's constructors
  take the address of that TU's own traverse copy, which is only ever CALLED
  through the stored pointer).

| Symbol class | Chunked treatment |
|---|---|
| Preprocessor/`#include`s, `__yo_tN` typedefs, FSM/GC structs | shared header verbatim |
| `yo_id_N` prototypes (declarations.yo:660) + definitions (generation.yo:435) | drop `static inline ` → external; prototypes in the header |
| RC helpers `___dup`/`___drop`/`___dispose`, `__yo_new_*` constructors | **stay `static inline` with BODIES in the shared header** (per-TU copies). They are the RC hot path (`__yo_decr_rc` history: 54% of a self-compile); their addresses are stored (`dispose_fn`) but never compared (verified: no fn-pointer `==` in the emit), so duplication is safe. `__yo_dispose_dispatch` must be externalized (header-inlined helpers call it from every TU). |
| Runtime functions (GC/sys/async/parallelism string literals) | definitions in **chunk 0** with `static` dequalified on the externally-referenced subset (allowlist, seeded from declarations.yo:298-309 + clang undefined-symbol errors); extern prototypes in the header |
| Runtime-private `static _Thread_local` globals inside the runtime literals | unchanged — private to chunk 0 (the key simplification) |
| Declarations-buffer globals: unwind buffers (gc_runtime.yo:149,154,280), argv shim (codegen_c.yo:368-375), module-level `g_*` vars (generation.yo:781) | `extern (_Thread_local)` in header + single definition in chunk 0 — read/written from every chunk; duplication would silently break unwind/args/state |
| `__yo_typeid_X` chars + dyn vtables | `extern const` decl + chunk-0 definition — **address identity is the semantics** |
| String literals | compound literals inside bodies — travel with their function |

~~`-flto=thin` is the opt-in mitigation (`--chunk-lto`) for lost cross-TU
inlining; not default.~~ **SUPERSEDED 2026-08-23 by measurement:** at `-O1`+
ThinLTO is REQUIRED and a chunked build gets it automatically
(`--no-chunk-lto` opts out); at `-O0` it is skipped, because there is no
cross-module inlining to lose there. Without LTO at `-O2` the chunked binary
runs 14.2% slower; with it, 2.9% faster than single-file. See "The real cause,
and why ThinLTO is REQUIRED" below. Perf gate: chunked binary within ~5% of
baseline on self-`check` — **met**.

## Chunk count: how N is chosen, and whether chunking should be default

**How functions are assigned (decided, implemented):** `fnv1a(c_name) % N`
(`String.hash()` is FNV-1a) — NOT by `.yo` source file. Measured skew on the
self-build at N=4: chunk bodies 30/36/30/38 MB, i.e. max/mean = 1.13. By-file
grouping was considered and rejected for now on three grounds: (1) source
modules differ in emitted size by orders of magnitude (a hub like `expr.yo`
against a leaf), so the slowest job — which sets wall clock — would be far
worse than ±13%; (2) a large share of emitted functions are specializations
minted DURING emission, which belong to no single source module in any useful
sense; (3) hashing the name is edit-stable (inserting a function moves nothing
else), where round-robin by definition order shifts every later function.
By-file grouping WOULD be better for the step-3 `.o` cache — an edit to one
leaf module would dirty one chunk — but only once symbol naming is
content-stable; today the global expr-id counter in `yo_id_N` renames symbols
in every module parsed after an edit, churning all chunks regardless of
grouping. The defining module path exists in the evaluator but is not recorded
on `CodegenFunctionEntry`, so this is a design choice, not a limitation.

**The shared-header tax (measured, changed the design's assumptions):** every
TU `#include`s the whole shared header, so aggregate compiler input is
`bodies + N x header`. Self-build: header 9 MB, bodies 134 MB, single-file
143 MB. N=4 -> 170 MB aggregate (+19%); N=16 -> 278 MB (+94%). Wall clock
still falls (each job sees ~9 MB header + ~8 MB body at N=16 instead of
143 MB) but the FLOOR is the header's own compile time, and aggregate CPU
grows linearly with N — which matters on machines with fewer cores than N and
for every `.o` cache MISS. So "N = 2x cores" is an assumption to MEASURE at
step 4 (N=4/8/16/32), not a default to hard-code. The tax is worse in
relative terms for small programs: on a ~1700-line test program the header is
~27% of the emission, so N=4 there is ~181% of the work for a program that
compiles in under a second.

**Default-on? Not yet — deliberately.** `--emit-chunks` stays opt-in
(default 0 = single file, bit-for-bit) until all of the following hold:
1. steps 3-5 land (parallel driver + `.o` cache, perf validation, CI gate);
2. step 4's runtime gate passes — chunking loses cross-TU inlining, and this
   compiler is RC-hot (`__yo_decr_rc` has historically been ~54% of a
   self-compile), so a silent runtime regression is the real risk;
3. the behavioral fixpoint gate exists (a chunked-built binary emits
   byte-identical single-file C), so flipping the default cannot quietly
   weaken the bootstrap fixpoint story;
4. auto-N (below) exists, so small programs and small machines do not
   REGRESS relative to single-file.
Even then, these paths stay single-file permanently: portable-C distribution
(`plans/PORTABLE_C_DISTRIBUTION.md`), `--emit-c` / `--emit-c-to` (the
single-file artifact is what humans read and bisect — see
`.github/instructions/debugging.instructions.md`), `--static-library` (one
input -> one `.o`; currently rejected outright with chunks), and wasm/emcc
targets.

**Auto-N (design, for step 3/4):** `--emit-chunks auto` picks
`N = clamp(1, jobs, emitted_bytes / MIN_CHUNK_BYTES)` where `jobs` is the
core count and `MIN_CHUNK_BYTES` (~4-8 MB, to be measured) keeps N=1 for
programs too small to amortize the header tax. Blocker: there is no
CPU-count API in `std` (verified — no `available_parallelism`, no `nproc`
probe), so this needs either a new `std/sys` call or a `YO_JOBS` /
`--jobs` override read first. Until auto-N exists, N is whatever the user
passes.

## Determinism

- Stage2/stage3: `function_order` is insertion-ordered and identical across
  stages — any pure function of `(c_name, N)` chunks both identically. The
  fixpoint scripts compare DEFAULT emissions anyway.
- Edit stability: assignment = `fnv1a(c_name) mod N` (round-robin by
  definition order shifts every later function on any insertion). N default
  16 (≥ 2× cores; ±10-20% skew acceptable).
- **Honest caveat**: `yo_id_N` names embed the single global expr-id counter
  (src/expr.yo:311-323), so an edit that changes expr counts renames symbols
  in every module parsed after it — chunk hashes then churn broadly.
  Per-chunk caching reliably pays for flag-only changes and edits that keep
  expr counts (many bug fixes), and late-parsed leaf modules. Content-stable
  symbol naming is a separate future project that would unlock full
  incrementality.
- Cache key: `sha256(shared_header ‖ chunk_text ‖ clang argv ‖ compiler
  version)` — a type renumbering must invalidate every chunk.

## Driver (IMPLEMENTED, step 3)

The flag assembly was NOT refactored into a helper — 99 `cmd.arg(...)` call
sites would have had to move, and any reordering silently changes the
single-file argv the bootstrap gates depend on. Instead `cmd` became a
drop-in RECORDER (`CcArgv`, whose `arg` matches `Command.arg`'s signature
exactly), so every assembly site is untouched and the argv order is preserved
by construction. Everything recorded up to the point where inputs are added is
the compile flag set; it is replayed verbatim for each `cc -c`, and the link
runs from the same recorded argv with `.o` paths substituted for the `.c`.

Parallelism does NOT use `io.spawn`: spawning in a loop hangs
(`issues/io-spawn-in-loop-or-recursion-hangs.md`). The driver instead generates
a POSIX `sh` script — one backgrounded `cc` per chunk in waves of `--jobs`
(default 8), collecting each job's status individually with `wait $pid`,
because bare `wait` always reports success. That is one child process and no
async machinery. On a WINDOWS host there is no `sh`, so the compiles run
sequentially (the `.o` cache still applies). Flag values reach the script
single-quoted (`_sh_quote`), since `-D`/`-I`/`--cflags` carry user text.

`.o` cache: key is `sha256(chunk text hash ‖ compile flags ‖ compiler
version)`, where the text hash is taken AT WRITE TIME so the ~140 MB of chunk
`.c` never has to be read back. The stamp lands in `<obj>.inputs-sha256`
(Phase A's pattern) and is written only AFTER a successful compile, so a failed
build never leaves a stamp that would skip a missing object.
`YO_BUILD_NO_CACHE=1` disables it.

A stamp records INPUTS, so it cannot detect that an object file is present but
unusable (truncated, clobbered). A link failure after cache hits is therefore
treated as a poisoned cache: the driver recompiles every chunk from source and
links once more, and only a second failure is reported. Verified by
clobbering one `.o` — link fails, all chunks recompile, binary builds and runs.

**Measured on the self-build (N=4, `--release`):**

| build | total | chunk phase |
|---|---|---|
| single-file baseline | ~209.7 s (137.4 s evaluate+emit, 72.3 s C) | — |
| chunked, cold cache | **173.2 s** | 0 cached, 4 compiled |
| chunked, warm cache | **161.7 s** | 4 cached, 0 compiled |

The warm build's residual is 137.4 s of evaluation plus the ~24 s ThinLTO
link — i.e. **the evaluator is now 85% of a cached rebuild**, and the C leg is
no longer where the time goes. Not done: `--jobs` has no `YO_JOBS` override and
no CPU-count default (no std API yet — see auto-N above); mimalloc's
`static.c` is still compiled by the link command rather than as one more
parallel job.

## Step 2 bring-up record (2026-08-23)

Four linkage classes were NOT in the original table and had to be discovered by
bring-up. Each is now handled in `src/codegen/chunk_assembly.yo`; the gate that
catches regressions in seconds is `tests/internal/chunk_assembly.test.yo`
(synthetic-C unit test of every split rule, red-first verified — 40 s vs the
~15 min a chunked self-build costs).

1. **Borrow primitives needed header routing.** `__yo_borrow_acquire` /
   `_release` / `_assert_unborrowed` have no prototypes anywhere and are called
   from every chunk (they are the per-container-access hot path), so they are
   recorded as a header range in `generate_atomic_gc_runtime_functions`.
2. **Residue functions need auto-generated prototypes** — the sys / async /
   parallelism / GC runtimes are emitted as big string literals carrying no
   prototypes, yet generated bodies call them across chunks. `assemble_chunks`
   now synthesizes a prototype for every `__yo_`-named residue definition,
   filtered to those actually REFERENCED by non-residue text.
3. **The reference scan must skip C string literals.** This compiler's own
   runtime emitters embed the entire runtime C text as `__yo_str` spill data,
   so a naive scan sees every runtime function name as "referenced" and emits
   prototypes whose signatures name chunk-0-private typedefs
   (`__yo_io_pending_op_t`, `__yo_fs_event_entry_t`, `__yo_yield_future_t`) —
   16+16+4 "unknown type name" errors. The scan is now string-literal aware.
4. **External function DEFINITIONS live in the declarations buffer.** The async
   state-machine emitter writes `<sm>_set_effect` / `_resume` / `_dispose`
   bodies there with EXTERNAL linkage — 80 of them in a self-build. A
   definition in the shared header is compiled by every TU: 240 duplicate
   symbols at link. Unlike a `static` header definition it cannot be made
   per-TU, so `_ca_split_decl_defs` relocates each block to chunk 0 (placed
   after the residue, so residue definitions precede their uses) and leaves
   `<signature>;` in the header.

**Two Yo-level bugs surfaced along the way:**

- `issues/ref-struct-field-named-header-collides-with-rc-header.md` (OPEN,
  PRE-EXISTING): a `ref(struct(...))` field named `header` collides with the
  built-in RC header member and emits invalid C. `yo check` passes it.
  Reproduced on unmodified develop HEAD. The assembler's field is
  `header_text` because of it.
- **`String` out-parameters silently discard writes** (a Yo semantics trap, not
  a compiler bug): `String` is a VALUE type whose byte buffer is lazily
  allocated (`_bytes : .None` until first push), so `fn f(out : String)` +
  `out.push_string(...)` mutates a copy. This dropped the ENTIRE declarations
  buffer from the emission — the header came out 11.6k lines instead of 29.4k
  and clang reported it only as far-downstream "unknown type name". Fixed by
  returning a `ref` struct (`DeclSplit`). Recorded in the syntax cheatsheet.

### The RC de-inlining regression (found, measured, fixed)

A 5-lens adversarial audit of the linkage split (34 agents; 3 findings survived
double verification) produced one dominant result, which the measurement then
confirmed quantitatively.

**Measured, interleaved A/B, both binaries `-O2`, `check ./src` (262 files):**

| binary | run 1 | run 2 | run 3 | mean | verdict |
|---|---|---|---|---|---|
| single-file self-build | 87.54 s | 87.59 s | 87.88 s | **87.67 s** | 262/262, 0 errors |
| N=4 chunked self-build | 102.61 s | 102.00 s | 101.93 s | **102.18 s** | 262/262, 0 errors |

Functionally equivalent, **16.5% slower** — 3x over the ~5% gate. And it is
self-defeating: a chunked-built compiler that compiles 16.5% slower cancels the
build-time win it was made for, so this is blocking for step 2, not a step-4
formality.

**Cause.** `__yo_decr_rc` / `__yo_incr_rc` are emitted `static inline` into the
CODE buffer with no covering header range, so they land in the residue and the
auto-dequalifier makes them external. RC drops are lowered as DIRECT calls to
these two primitives — the self-build emission has **336,211 `__yo_decr_rc(`
sites** and 14,756 `__yo_incr_rc(` sites — so with N=4 roughly 78% of them
became cross-TU calls into `chunk000.o`, on the function profiled at 54% of a
self-compile. (Chunk 0's own sites are fine: clang -O2 still inlines from an
in-TU body even without the `inline` keyword.)

**Fix (the audit's, better than routing the globals).** The full-GC
`__yo_decr_rc` only touches the thread-local GC state in its TRACKED tail; the
untracked fast path needs nothing but the object header. So the tail is split
out as `__yo_decr_rc_tracked` (stays in the residue -> chunk 0, external,
auto-prototyped) and the inline fast path plus `__yo_incr_rc` are bracketed
into a `chunk_header_ranges` entry, exactly as the borrow primitives are. The
lightweight (non-cycle-GC) RC pair is header-routable as-is. `header_defined`
then picks up both definitions, so the `declarations.yo:298-299` prototypes
keep `static inline` automatically and prototype/definition cannot disagree.
In a single-file build the tail is a `static` function with one call site, so
clang inlines it back and the split is free.

**Also fixed (audit F2):** `_ca_parse_static_fn_line` had no data-vs-function
guard, so paren-QUALIFIED file-scope data — `static __declspec(thread) T x =
init;` (11 sites in the Windows async runtime), `static _Alignas(16) char
buf[64];`, `static _Atomic(void*) p;` — parsed as a "prototype" named after the
qualifier and lost its `static` to the dequalifier, silently giving file-scope
DATA external linkage. Latent on macOS (those lines hit `=` before any paren)
but live for Windows targets, since `--emit-chunks` is not target-gated. The
parser now requires `)` to be followed by `;` or `{`, which makes the module's
"`static` DATA lines are never touched" invariant actually hold for all three
consumers of the parser.

**Recorded, not fixed (audit F3):** `_ca_is_rc_helper` is DEAD — it keys on a
triple underscore (`___drop`), while real emitted names put a single one before
the verb (`__yo_dispose___yo_dyn_box___yo_tN`). Its three branches never
execute. Confirmed inert AND low-value: there are only 8 per-type dyn-box
dispose functions in a whole self-build, so correcting the predicate would
route 8 functions. Delete it once the RC measurement settles. The same dead
predicate exists in the COMPILER (not just the assembler) and has silently
disabled an intended `always_inline` optimization since it was written —
filed as `issues/rc-helper-always-inline-linkage-branch-never-fires.md`.

### The real cause, and why ThinLTO is REQUIRED (not an opt-in mitigation)

Routing the RC primitives into the header was necessary for design conformance
but **recovered nothing**: 102.18 s before the fix, 102.21 s after. The
hypothesis was refuted by measurement, and the honest cause is elsewhere.

Splitting the program into N translation units externalizes ~175k generated
functions that were `static inline`, so the C compiler can no longer
INTERNALIZE or DEAD-STRIP them. Measured on the N=4 self-build:

| build | binary | defined symbols |
|---|---|---|
| single-file | 9 MB | 3,493 |
| chunked N=4 | 24 MB | 7,201 |

A 2.7x code-size explosion — I-cache and branch-predictor pressure, not call
overhead, is what costs the 14%. That also explains why the RC fix was
irrelevant: `__yo_decr_rc` was already only one of ~175k externalized symbols.

`-flto=thin` restores cross-module inlining and internalization at link time.
Measured (interleaved, `check ./src`, 262/262 on every run):

| build | mean runtime | vs single-file |
|---|---|---|
| single-file (`yo-step3`) | 90.02 s | — |
| **chunked N=4 + ThinLTO** | **87.41 s** | **-2.9% (faster)** |
| chunked N=4, no LTO | 102.81 s | +14.2% |

So the design decision changes: **a chunked build at `-O1`+ gets `-flto=thin`
automatically** (`--no-chunk-lto` opts out, wasm excluded; at `-O0` it is
skipped — see the `-O0` measurement under step 3). It is not a tuning knob at
`-O2` — without it a chunked-built compiler runs 14% slower, which cancels the
build-time win the campaign exists for. Interestingly the LTO binary is still 23 MB / 6,821
symbols, i.e. ThinLTO buys the speed through inlining rather than by shrinking
the image.

Side observation on the LTO build cost: the ThinLTO C phase took 65.8 s wall /
125.9 s CPU (the backends already parallelize ~1.9x) against the 74.8 s
single-file baseline — so chunking is *already* marginally ahead on build time
before step 3's parallel driver exists, and the 125.9 s of CPU is what that
driver gets to spread across cores.

**Still open for step 4:** whether `-flto=thin` erodes the `.o` cache win
enough to want the alternatives (header-routing SMALL functions as per-TU
`static inline` via the byte-range size already recorded per function; keeping
`static` for functions no OTHER chunk references; call-graph-aware assignment).
Measure the cached-rebuild path before adding any of them.

## Steps and gates

0. **Baseline (DONE 2026-08-23)**: clang -O2 -c on the emitted self-build C
   = **74.8 s** (M4, 148 MB, 2.35 M lines).
1. **Chunk plumbing, degenerate N=1**: byte-range recording around
   generation.yo:705, `--emit-chunks` flag, `yo_shared.h` + one all-static
   `.c` that `#include`s it. Gate: default emission byte-identical; N=1
   self-build binary passes `yo check`.
2. **Linkage split** (the hard step): the table above.
   Gates and their status:
   - N=4 self-build links cleanly — **DONE 2026-08-23** (after four
     undiscovered linkage classes; see the bring-up record above).
   - chunked binary is functionally equivalent — **DONE**: `check ./src`
     262/262, 0 errors, identical to the single-file build.
   - default emission byte-identical — **DONE** (`--emit-chunks 0` unchanged;
     re-verified after every assembler change until the RC split
     deliberately changed the emitted C for all builds).
   - assembler unit gate — **DONE**: `tests/internal/chunk_assembly.test.yo`
     (every split rule on synthetic C, red-first verified, 40 s).
   - fn-pointer equality audit on duplicated inlines — **DONE**: only
     `vtable->__yo_type_id` is ever compared (`downcast.yo:53`); no
     function-pointer or vtable-address comparison exists in the emit, so
     per-TU copies of constructors/traverse/RC helpers are safe and dyn
     vtables need no extern split.
   - runtime within ~5% of the single-file build — **the blocking gate**; see
     "The RC de-inlining regression" above (16.5% found, RC fix landed,
     re-measurement in progress).
   - full `tests/` green on the chunked binary — **MET 2026-08-23**: a
     chunked-built compiler (N=4, `--release`) runs the whole language suite
     at **2802 passed / 0 failed**, i.e. it is behaviourally identical to a
     single-file-built one across the corpus, not merely on `check`.
3. **Parallel driver + `.o` cache** — **DONE 2026-08-23** (see "Driver"
   above for the implementation and the measurements).
   Gates:
   - touch-nothing rebuild = 100% cache hits — **MET** (self-build: "4
     unit(s), 4 cached, 0 to compile"; total 173.2 s cold -> 161.7 s warm).
   - corrupt `.o` falls back — **MET**, by recompiling every chunk and
     retrying the link once (a stamp records inputs, so it cannot detect an
     unusable object). Verified by clobbering an object file.
   - N=16 C-phase ≤ ~20 s — **RESTATED, not met as written**: with ThinLTO the
     link alone is ~24 s and is not cacheable, so no N reaches 20 s. At `-O0`,
     where LTO is skipped, a cached rebuild's chunk phase is a 0.13 s link.
     The gate should have been written per optimization level.

   **Measured up front (2026-08-23, N=4, 10-core M4), so the driver is built
   against numbers rather than hopes:**

   | configuration | compile | link | total | binary runtime |
   |---|---|---|---|---|
   | single-file (today's default) | — | — | 72.3 s | baseline |
   | chunked, ONE clang call + LTO (what the driver does after step 2) | — | — | 65.8 s | −2.9% |
   | chunked, 4 parallel `cc -c` + LTO link | 11.5 s | 24.8 s | **36.2 s** | −2.9% |
   | chunked, 4 parallel `cc -c`, no LTO | 26.3 s | 0.1 s | **26.4 s** | +14.2% |

   Two consequences for the design:
   - **The link becomes the bottleneck under LTO** (24.8 s of 36.2 s), and it
     is not cacheable — it re-runs on every build. So a `.o` cache saves at
     most the 11.5 s compile, putting the cached-rebuild floor at ~25 s. Raising
     N past ~4 mostly does not help either; the thin-link/backend phase already
     parallelizes internally (~1.9x). The cache is still worth having, but
     "N=16 C-phase ≤ 20 s" is unreachable WITH LTO and should be restated.
   - **Without LTO the picture inverts**: a cached no-change rebuild is a
     0.1 s link. That is only usable if the 14.2% runtime penalty does not
     matter — which is exactly the case at `-O0`, where there is no
     cross-module inlining to lose in the first place.

   **`-O0` measured, hypothesis CONFIRMED (2026-08-23):** at `-O0` clang
   neither inlines nor dead-strips, so externalizing every function costs
   almost nothing there:

   | `-O0` build | C phase | runtime (`check ./std`, 154/154) | defined symbols |
   |---|---|---|---|
   | single-file | 18.25 s | 40.73 s | 6,848 |
   | chunked, 4 parallel | **5.49 s (3.3x)** | **40.23 s (identical)** | 7,693 (+12%) |

   Contrast the `-O2` symbol blow-up (3,493 -> 7,201, i.e. 2.1x): at `-O0` the
   single-file build cannot dead-strip either, so the gap is only 12%. So
   **LTO tracks the OPTIMIZATION LEVEL, not the chunk flag** — implemented as
   `chunk_lto_wanted` in `run_compile`, mirroring the `-O` selection exactly.
   At `-O0` a chunked build now skips the thin-link entirely and is 3.3x
   faster with no runtime cost; at `-O1`+ it gets `-flto=thin` and is
   perf-neutral. This also materially changes the default-on calculus for dev
   builds: `-O0` chunking is a pure win, and with a `.o` cache the no-change
   rebuild is a 0.13 s link.

   **BLOCKER, found while prototyping the fan-out:** `io.spawn` inside a
   `while` loop or a recursive call hangs (spins at 100% CPU) — the JoinHandle
   holds a borrowed pointer and the loop body's scope-end drop frees the future
   under it. Root-caused at the C level and filed as
   `issues/io-spawn-in-loop-or-recursion-hangs.md`. A verified workaround
   exists (unrolled spawns inside a helper fn, and loop over WAVES of that
   helper — measured 2 waves x 500 ms concurrent = 1013 ms), which also bounds
   the job window the way `--jobs` would anyway. Either fix the bug first or
   build the driver on the wave pattern.
4. **Perf validation + LTO experiment** — **DONE 2026-08-23**. Gate: runtime
   within ~5% of baseline — **MET at -2.9%** (see "The real cause, and why
   ThinLTO is REQUIRED"), and the `-O0` configuration measured identical.

   **N sweep (cold chunked self-build, `--release`, jobs=8, 10-core M4; C phase
   is total minus the constant 137.4 s of evaluation):**

   | N | total | C phase | binary |
   |---|---|---|---|
   | 2 | 204.3 s | ~66.9 s | 20 MB |
   | 4 | 173.2 s | ~35.8 s | 22 MB |
   | 8 | **171.5 s** | **~34.1 s** | 24 MB |
   | 16 | 172.2 s | ~34.8 s | 24 MB |

   **The knee is at N=4-8 and there is nothing past it.** N=16 is
   indistinguishable from N=8 (marginally worse), because the ThinLTO link — not
   the per-chunk compile — is the floor, and the shared-header tax grows
   linearly in N, so everything beyond the knee is pure waste. N=2 is far worse.
   This refutes the plan's original "N default 16 (>= 2x cores)": auto-N should
   target ~8 and can drop the core-count term entirely, keeping only the
   small-program size floor.
5. **build.yo surface + CI gate**: partially DONE 2026-08-23.
   - behavioural fixpoint gate — **DONE and PASSING**: a chunked-built
     compiler (N=4) and a single-file-built one emit **byte-identical** C for
     the compiler itself (143 MB, `cmp` clean, hollow=0 on both).
     Packaged as `scripts/bootstrap/chunked_gate.sh`
     (`S1=<bin> N=4 bash scripts/bootstrap/chunked_gate.sh`). This is the
     strongest statement available about the linkage split: it rewrites
     linkage across ~175k functions, duplicates the RC hot path and the
     constructors per TU, and splits the address-identity statics — if any of
     that changed behaviour, the two compilers would disagree on some emitted
     byte. Deliberately NOT a per-PR CI job: it costs two self-builds plus two
     self-emits (~12 min, heavy RAM) to guard an opt-in flag no default path
     uses. Wire it in if chunking becomes a default.
   - cli-case golden — **DONE**: `tests/cli-cases/compile-emit-chunks` runs the
     same chunked compile twice, so one golden pins both halves of the cache
     contract ("0 cached, 3 to compile" then "3 cached, 0 to compile").
     Generated artifacts are in the case's `ignore` list — object files are not
     reproducible across clang versions, and hashing the emitted C would force
     a re-record on every codegen change.
   - `Executable.emit_chunks` (the `yo build` surface) — **OPEN**. Today only
     `yo compile --emit-chunks N` exists. The field has to thread through
     `std/build.yo` -> `BuildArtifact` (src/evaluator/builtins/build.yo, three
     construction sites + the positional extractor) -> the child argv in
     `src/build_runner.yo`, following `emit_c_to`'s pattern exactly. Note
     BuildArtifact's `emit_c_to` comment: a `?=` default needs a
     compile-time-known value, so a non-defaultable field ripples into every
     literal including `tests/internal/build_runner.test.yo`. The Phase A
     artifact stamp already hashes the child argv, so the flag invalidates the
     build cache for free.
   Default off everywhere including portable-C.

Honest total: ~2-3 weeks; the risk is Step 2.
