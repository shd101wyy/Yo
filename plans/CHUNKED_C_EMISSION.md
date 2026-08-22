# Chunked C emission + parallel/cached clang

**Status: ACTIVE (designed 2026-08-23; step 0 measured, step 1 in progress).**
Goal: `yo build`'s C leg — clang -O2 on the single ~148 MB emitted `yo.c` —
measured **74.8 s single-threaded** (step 0 baseline, M4, of a ~220 s full
rebuild). Split the emitted program into N translation units compiled in
parallel with a content-hashed `.o` cache, then link. Opt-in
(`--emit-chunks N`, default 0 = today's single file, bit-for-bit): the
single-file `yo.c` is a DISTRIBUTION REQUIREMENT
(`plans/PORTABLE_C_DISTRIBUTION.md`), and the bootstrap fixpoint gates
compare default emissions.

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

`-flto=thin` is the opt-in mitigation (`--chunk-lto`) for lost cross-TU
inlining; not default (thin-link + backends re-run per rebuild, eroding the
cache win). Perf gate: chunked binary within ~5% of baseline on self-`check`.

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

## Driver

Refactor `run_compile`'s flag assembly (main.yo:1492-1732) into a helper
shared by: the unchanged single-file command (byte-identical argv), per-chunk
`cc -c` jobs, and the link. Parallelism via `io.spawn` windows (`--jobs J`,
default 8, `YO_JOBS` override — no CPU-count API in std yet). `.o` cache
mirrors Phase A's sha256 stamp pattern (build_runner.yo:436-490) under
`<c_base>.chunks/cache/`; `YO_BUILD_NO_CACHE=1` honored; mimalloc `static.c`
becomes one more parallel job.

## Steps and gates

0. **Baseline (DONE 2026-08-23)**: clang -O2 -c on the emitted self-build C
   = **74.8 s** (M4, 148 MB, 2.35 M lines).
1. **Chunk plumbing, degenerate N=1**: byte-range recording around
   generation.yo:705, `--emit-chunks` flag, `yo_shared.h` + one all-static
   `.c` that `#include`s it. Gate: default emission byte-identical; N=1
   self-build binary passes `yo check`.
2. **Linkage split** (the hard step): the table above. Gate: N=4 self-build
   links cleanly; full `tests/` green on the chunked binary; fn-pointer
   equality audit on duplicated inlines.
3. **Parallel driver + `.o` cache**. Gate: N=16 C-phase ≤ ~20 s; touch-nothing
   rebuild = 100% cache hits; corrupt `.o` falls back.
4. **Perf validation + LTO experiment** (3 configs). Gate: runtime within
   ~5% of baseline.
5. **build.yo surface + CI gate**: `Executable.emit_chunks`, a behavioral
   fixpoint gate (chunked-built binary emits byte-identical single-file C),
   cli-case golden. Default off everywhere including portable-C.

Honest total: ~2-3 weeks; the risk is Step 2.
