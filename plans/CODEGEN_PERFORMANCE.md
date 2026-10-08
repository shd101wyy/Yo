# Generated-code performance: closing the gap to Rust

**Status: ACTIVE — the static-code performance campaign.** Written 2026-10-08
at the maintainer's request, alongside
[`backlog/RUST_REFERENCE_PATTERNS.md`](backlog/RUST_REFERENCE_PATTERNS.md)'s
§12. The async runtime's performance is owned by
[`ASYNC_PERFORMANCE_HANDOVER.md`](handover/ASYNC_PERFORMANCE_HANDOVER.md) and
[`ASYNC_STATE_MACHINE_GENERATION.md`](ASYNC_STATE_MACHINE_GENERATION.md);
this plan is the other half: **what the emitted C is worth at run time.**

## 0. The position

Post-VBD, Yo's *semantics* are near-Rust by construction for unshared code:
unique buffers, no hidden counts, implicit moves, static exclusivity for
value-rooted borrows. The remaining gap to Rust has exactly two causes, and
this plan attacks both:

1. **What clang is allowed to see.** Rust tells LLVM `noalias` on every
   `&mut`; Yo lowers `mut(x) : T` to a plain `T*` and discards the
   exclusivity it just proved. Nothing in the emitted C uses `restrict`
   (measured 2026-10-08: zero occurrences in a fresh `yo compile` output),
   no LTO is passed (the C invocation in `src/main.yo` and
   `src/codegen/codegen_c.yo` assembles no `-flto`), and chunked emission
   caps inlining at translation-unit scope — the same place Rust builds lose
   their last percent without LTO.
2. **Checks the language could discharge itself.** Per-step bounds checks on
   index walks (decision 39 accepted them), the `Rc` write-site borrow assert
   (§3.10), container guards — each has a proof path that removes it: static
   exclusivity, the runtime pin, or the verifier.

**Non-goals.** No direct LLVM backend: the portable-C identity is
load-bearing ([`reference/PORTABLE_C_DISTRIBUTION.md`](reference/PORTABLE_C_DISTRIBUTION.md),
the bootstrap chain), and after `restrict` + LTO + PGO clang *is* LLVM's
optimizer for this C. No language-semantics change. No async-runtime work
(the ASYNC plans own it; the runtime is already at measured libuv parity).

**Relationship to VALUES_BY_DEFAULT.** Every VBD phase reshapes the emitted
C, so the measurement-gated work is sequenced around it (§5); nothing here
re-baselines what a VBD phase owns (`check ./src` time, stage-2 RSS stay
that campaign's ratchets).

## 1. CP0 — the measurement (first PR, prerequisite for everything)

Without numbers, "on par with Rust" is unfalsifiable and every later phase is
unprovable. Two layers:

- **The paired suite**, `scripts/bench/lang-vs-c/`: the same workload written
  in Yo, Rust and C, one directory each, a runner script printing a table.
  The initial set, chosen to cover the cost axes of §0:

  | Workload | What it isolates |
  | --- | --- |
  | numeric kernel (dot product, n-body step) | autovectorization; what `restrict` unlocks |
  | ArrayList/Vec churn (build, sort, dedup) | buffer ownership, growth, move/copy costs |
  | string building + parsing (a small JSON/toml reader) | `String`/`&str` shape vs `String`/`&str`, bounds checks |
  | an `Rc`/`Arc` tree walk + rewrite | handle traffic, write asserts, collector |
  | iterator sum / filter-map chains | decision 39's bounds check vs Rust's elision |
  | closure-heavy (a `with_lock`-shaped loop) | whether `Impl(Fn)` bodies fold away |

  Rust compiled with its release profile, C with clang `-O2` (and `-O3` for
  reference), Yo with `--optimize 2`. Results land in this file, dated, per
  phase that claims a change — the same discipline VBD applies to
  `check ./src` time.
- **The macro-benchmark you already own**: the fixpoint battery's wall clock
  (`scripts/bootstrap/fixpoint_only.sh`, `gates_fast.sh`) is a large real Yo
  program running its own test suite through a self-compiled binary. Record
  it beside the suite at each phase; it catches what microbenches miss.

CP0's PR ships the suite, the first table, and nothing else.

## 2. CP1 — let clang see the guarantees (codegen only)

### CP1a. `restrict` for exclusive parameters

Emit `T* restrict` (and `const T*` stays as is) where Yo has *proved*
exclusivity, so clang may treat the parameter as `noalias` — the one
attribute Rust gets from `&mut` that the C pipeline currently throws away.
Decision 29 recorded the precedent (Hylo passes parameters by pointer "adding
only LLVM attributes (`noalias`, `nofree`, `nocapture`, and `readonly` for
`let`)").

**Where it is sound:**

- a `mut(x) : T` / `mut(self)` parameter whose lent place is value-rooted:
  decision 28's overlap rules reject every competing argument at compile
  time (E0901/E0911), so at the C level no other access path into the object
  exists in this call;
- a `mut` place through an `Rc`/`Arc` deref, provided the exclusive-flag
  acquire and its assert are emitted before any payload access: the assert
  reads the cell header, not the payload, so the object is only ever
  accessed through the `restrict` pointer or after a panic.

**Where it is not:** `imm` parameters — two `imm` arguments may alias
(decision 28 allows it), so `noalias` would be a lie. A later extension may
emit it where Stage-1 summaries prove the argument disjoint from every other
alias in the call.

**Canaries.** `restrict` violations are silent UB, so the gate is the
UBSan language-suite job (`ubsan.yml`) plus stress tests that alias exactly
the ways the rule must reject (overlapping `mut` args — compile errors;
writes through a second `Rc` handle during a pinned walk — the §3.10 panic).
A `-fno-`-style kill switch is not kept: the canaries are the contract.

**Phase:** after the V3b Generation B flip (the `mut` spelling and the
by-value default are then final, so the rule keys on the end-state modes).

### CP1b. LTO for release builds

Options, decided in the PR by measurement:

- pass `-flto=thin` to the C compiler at `--optimize >= 2` (clang/gcc both
  accept it; the `.o` chunk cache stays valid per-unit);
- or a `--profile release` that collapses `--emit-chunks` to one translation
  unit (maximum inlining, forfeits incremental compile — a build-profile
  choice, not a default change).

Either way the goal is rustc's `codegen-units=1 + LTO` posture for release
artifacts while dev builds keep the chunked incremental loop.

### CP1c. The closure-call audit

The closure-borrowing API style (`with_lock`, `with`, `for_each`, the
borrowed `for`) matches Rust's stack guards only if the monomorphized
`Impl(Fn)` call folds away. CP0's closure bench answers it from the emitted
C; if the call site is an indirect call through a stored function pointer,
the fix is in the specialization/inlining emission (`src/codegen/exprs/inline_fns.yo`
is the existing inline machinery), not in the API.

## 3. CP2 — stop paying for checks the language already subsumes

### CP2a. Finish the 5b elision line (designed work, not new design)

SAFE_MODE 5b Phases 0–2 landed (#983, #987, #998, #1009): a verify-mode entry
file's guards elide through `guard_site_is_proved` and the verifier's sited
`index-in-bounds` obligations. What remains is owned by the backlog designs
and lands as they say:

- [`backlog/SAFE_MODE_5B_CONTAINER_BOUNDS_ELISION.md`](backlog/SAFE_MODE_5B_CONTAINER_BOUNDS_ELISION.md)
  — the std container's own trap elided at proved call sites (option A
  implemented on its branch per that doc; land or re-land it);
- [`backlog/SAFE_MODE_5B_VERIFIED_GUARD_ELISION.md`](backlog/SAFE_MODE_5B_VERIFIED_GUARD_ELISION.md)
  — Phase 3, the general verifier-driven elision.

This plan's only addition: the CP0 suite before/after, so the elision's
value is a number in this file, not an assertion.

### CP2b. The borrowed `for` lowers to a hoisted walk

Decision 39 accepted "one bounds check per step" for index walks. Inside the
borrowed `for` the check is redundant, because the guarantee lives elsewhere:

- **value-rooted container:** the body's element borrow conflicts with every
  `mut` access on the root (E0911), so growth mid-walk is a compile error —
  the loop is as safe unchecked as checked;
- **`Rc`-rooted container:** the pin is retained, and every write through
  the cell asserts (§3.10), so a growth that would reallocate panics before
  the old buffer is freed.

The lowering hoists the length and the element pointer at loop entry and
walks raw elements. `indices()` walks and `xs(i)` outside the macro keep
their checks (growth is genuinely possible there), so decision 39's test
requirement survives with its three readings: value-root = compile error,
`Rc`-root = pin panic, cursor walk = bounds error.

**Phase:** with V2b (the collections must be uniquely owned first).

### CP2c. `Rc` write-assert elision by mutation summary

The write-site assert (§3.10's V1 form) is skippable where no conflicting
mark can be live: a function-local handle with no borrows in scope, and
Stage-1 summaries (`src/evaluator/effects/mutation_summary.yo`) showing every
callee between acquisition and write is read-only. The mechanism mirrors the
summaries' existing mark-skipping; the canaries are V1's own determinism
tests (a closure and an async body mutating a captured `Rc(ArrayList(T))`
while a `for` borrows it must keep panicking).

**Phase:** after §3.10's write-site emission lands (VBD lists it under V1
"Remaining").

Dead `Rc.clone()` elision needs no work here: decision 27 owns it, landing
with V2b.

## 4. CP3 — layout and profiles

- **CP3a. Field reordering** in codegen for non-`extern` nominal types
  (descending alignment, deterministic by type key so chunked emission
  agrees across translation units). C keeps declaration order; rustc's
  `repr(Rust)` reorders — this is the free cache win on hot structs.
  `extern`/C types keep declaration order (ABI); the `Option` one-pointer
  niches must survive; `sizeof` goldens move with this.
- **CP3b. PGO**: `--profile generate|use` mapped onto clang's
  `-fprofile-generate`/`-fprofile-instr-use` (gcc equivalents per target),
  counter-file placement under `yo-out/`, documented in BUILD docs. BOLT is
  a later option once PGO exists.

## 5. Gates and sequencing

Every phase: the AGENTS.md battery (`check ./src`, `check ./std`,
`compile --skip-c-compiler`, `build --std-path ./std`, fixpoint,
`gates_fast`, the fast language suite, fmt with the tree binary) **plus the
CP0 table before/after in this file**. CP1a additionally requires a green
UBSan language suite. One PR per phase, or a stack with one battery.

| Phase | Depends on | Can start |
| --- | --- | --- |
| CP0 | — | now |
| CP1b (LTO) | CP0 for the number | now |
| CP1c (closure audit) | CP0 | now |
| CP1a (`restrict`) | V3b Generation B flip; UBSan canaries | after V3b |
| CP2a (5b) | its own backlog designs | as designed |
| CP2b (`for` lowering) | V2b | after V2b |
| CP2c (assert elision) | §3.10's V1 write-site assert | after V1's remainder |
| CP3 | everything worth profiling | last |

## 6. Risks

- **`restrict` is a soundness claim, not a hint.** A wrong rule is silent UB;
  the UBSan job and the alias stress tests are the only detectors, so the
  rule ships conservative (value-rooted `mut` first, the `Rc`-path rule only
  with the assert-ordering proof) and widens by measurement.
- **LTO interacts with the chunk cache and build times**; keep dev builds
  chunked and measure `yo build` wall clock in the PR.
- **CP2b changes panic sites** (a growth attempt inside a value-rooted
  borrowed `for` becomes a compile error instead of a bounds error); the
  decision-39 test and its docs move with it — a dated amendment there, not
  a silent change.
- **Elision by summary is only as sound as the summaries.** CP2c reuses
  machinery that already gates D3 checks; its negative tests (the panic
  canaries) must fail before the elision exists.

## 7. Open questions

- Whether `imm` parameters may earn `restrict` where Stage-1 summaries prove
  an argument disjoint from every other alias in the call (a per-call proof,
  unlike CP1a's per-rule one).
- Whether the release profile is LTO-by-default or opt-in (`--profile
  release`), decided by CP1b's build-time measurements.
