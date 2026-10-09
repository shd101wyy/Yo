# Generated-code performance: closing the gap to Rust

**Status: BACKLOG — designed and sequenced, not started.** Written 2026-10-08
at the maintainer's request, alongside
[`RUST_REFERENCE_PATTERNS.md`](RUST_REFERENCE_PATTERNS.md)'s §12, and parked
here on the maintainer's call (2026-10-08): nothing drives a phase yet; CP0
is the entry point when the campaign opens. The async runtime's performance
is owned by
[`ASYNC_PERFORMANCE_HANDOVER.md`](../handover/ASYNC_PERFORMANCE_HANDOVER.md)
and [`ASYNC_STATE_MACHINE_GENERATION.md`](../ASYNC_STATE_MACHINE_GENERATION.md);
this plan is the other half: **what the emitted C is worth at run time.**

## 0. The position

Post-VBD, Yo's *semantics* are near-Rust by construction for unshared code:
unique buffers, no hidden counts, implicit moves, static exclusivity for
value-rooted borrows. The remaining gap to Rust has exactly two causes, and
this plan attacks both:

1. **What clang is allowed to see.** Rust tells LLVM `noalias` on every
   `&mut`; Yo lowers `mut(x) : T` to a plain `T*` and discards the
   exclusivity it just proved — nothing in the emitted C uses `restrict`
   (measured 2026-10-08: zero occurrences in a fresh `yo compile` output).
   Cross-translation-unit inlining is NOT a gap: chunked optimizing builds
   already pass `-flto=thin` by default (`src/main.yo:4898`–`4917`,
   [`CHUNKED_C_EMISSION.md`](../reference/CHUNKED_C_EMISSION.md) — MEASURED
   on an N=4 self-build at `-O2`: 14.2% slower without it, 102.8s vs 90.0s
   on `check ./src`, and the thin link slightly FASTER than single-file,
   87.4s). The visibility gap that remains is aliasing metadata (CP1a) and
   the audit edges of CP1b.
2. **Checks the language could discharge itself.** Per-step bounds checks on
   index walks (decision 39 accepted them), the `Rc` write-site borrow assert
   (§3.10), container guards — each has a proof path that removes it: static
   exclusivity, the runtime pin, or the verifier.

**Non-goals.** No direct LLVM backend: the portable-C identity is
load-bearing ([`PORTABLE_C_DISTRIBUTION.md`](../reference/PORTABLE_C_DISTRIBUTION.md),
the bootstrap chain — `yo.c` runs wherever any C compiler runs), and after
`restrict` + LTO + PGO clang *is* LLVM's optimizer for this C
(`plans/ROADMAP.md` lists the backend as a non-goal). Recorded 2026-10-08,
this is a **reopen condition, not a flat no**: reopen only if, after CP1 and
CP2 land, CP0's paired suite still shows a gap to Rust that is (a)
persistent across releases, (b) attributable by profiling to metadata or
lowering the C path cannot express — exact `noalias` without `restrict`'s
UB-on-violation, per-construct aliasing facts, Yo-aware lowering of count
and flag operations — and (c) worth more than it costs: an IR emitter owns
per-triple ABI (raw IR does not inherit clang's calling-convention and
struct-passing decisions), DWARF emission, and a doubled gate surface. If it
ever reopens, the shape is an optional `--backend llvm` for release builds
(`.ll` text, compiled by clang), with C staying canonical for bootstrap,
portability and every gate. No language-semantics change. No async-runtime
work (the ASYNC plans own it; the runtime is already at measured libuv
parity).

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

### CP1b. LTO edges (an audit, not a build)

ThinLTO is already the default for chunked `-O1+` builds (`--no-chunk-lto`
opts out; wasm excluded), with the measured numbers in §0 — there is nothing
to add for the common path, and single-file builds need no LTO (inlining is
already intra-TU). What remains is small:

- the flag is clang-shaped: `-flto=thin` is not gcc's spelling (`-flto`),
  and zig/msvc are their own stories — audit every supported C compiler in
  the target matrix (`src/target.yo`) so a non-clang toolchain either gets
  its own flag or a loud error, never a silently slower or broken link;
- confirm the posture with CP0's per-compiler numbers and document it beside
  [`CHUNKED_C_EMISSION.md`](../reference/CHUNKED_C_EMISSION.md)'s.

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

- [`SAFE_MODE_5B_CONTAINER_BOUNDS_ELISION.md`](SAFE_MODE_5B_CONTAINER_BOUNDS_ELISION.md)
  — the std container's own trap elided at proved call sites (option A
  implemented on its branch per that doc; land or re-land it);
- [`SAFE_MODE_5B_VERIFIED_GUARD_ELISION.md`](SAFE_MODE_5B_VERIFIED_GUARD_ELISION.md)
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

### CP2d. Considered and declined (2026-10-09): splitting `Rc(T)` into `Rc(RefCell(T))`

The maintainer asked whether Rust's split — a plain `Rc<T>` with no borrow
flag and `Rc<RefCell<T>>` only where mutation happens — should replace
§3.10's one `Rc(T)` with marks in every cell header. Recorded here so the
question is not re-opened without the measurement.

**What the marks cost today, and what a split would save.** A Yo `Rc(T)`
costs what Rust's `Rc<RefCell<T>>` costs: the header word for the marks,
one load-compare-branch at each write through the cell (the §3.10 assert),
and a mark set/clear around every `imm`/`mut` lend that crosses the cell
(decision 28's per-call marks). The only thing Rust has that is cheaper is
`Rc<T>` with a payload nobody can mutate: no flag, no assert, and a read
through it touches no header. That is the whole saving a split could buy;
the write path is the same check under either spelling.

**Why not the split.** It is the cost VALUES_BY_DEFAULT chose not to pay:
decision 4 makes a write through `Rc` a plain write with no annotation,
§3.10 states "there is no `RefCell`", and the two together are what let the
compiler's ~3,000 `ref` trees become `Rc(struct(...))` at V4/V5 with
auto-dereference and no `.borrow()`/`.borrow_mut()` at every use. A split
puts that spelling on every user, forces a payload type that is mutated in
one place to be a `RefCell` everywhere, and duplicates the shared-cell
semantics the plan unified (the peer session carrying the VBD phases holds
the same position, 2026-10-09).

**The same saving, statically, with no new type.** Yo emits one
whole-program C translation, so the facts a `RefCell` spelling would carry
in the type are already visible to codegen:

- **Per-type frozen cells.** If no site in the program writes through an
  `Rc(T)` deref for a given payload `T` (no field store, no `mut(self)`
  call, no index place through the cell), then no mark on an `Rc(T)` cell
  can ever conflict: emit no marks and no assert for that instantiation.
  That is exactly Rust's `Rc<T>` cost, decided per type at codegen time
  instead of per declaration by the user. A payload exported from a static
  library, or reachable from `Dyn`, is conservatively "mutable" unless the
  consumer's build proves otherwise.
- **Per-site elision** is CP2c as designed: the write assert and the lend
  marks go where the mutation summary proves no conflicting borrow is live.

**Sequencing and the reopen condition.** Both levers sit behind V1's
remaining item (the assert moves to the write site) and CP0's `Rc`-tree
bench, which must add a mark/assert counter (acquires, releases, asserts
executed on `check ./src`) so the share of time is a number. Reopen the
split only if, after CP2c and the frozen-cell rule land, that counter
shows mark traffic still dominating a hot path, concentrated in payload
types that are mutated somewhere but read in the hot loop — the one case
the static levers cannot reach.

## 4. CP3 — layout and profiles

- **CP3a. Field reordering** in codegen for non-`extern` nominal types
  (descending alignment, deterministic by type key so chunked emission
  agrees across translation units). C keeps declaration order; rustc's
  `repr(Rust)` reorders — this is the free cache win on hot structs.
  `extern`/C types keep declaration order (ABI); the `Option` one-pointer
  niches must survive; `sizeof` goldens move with this.
- **CP3b. PGO**: `--pgo generate|use` mapped onto clang's
  `-fprofile-generate`/`-fprofile-instr-use` (gcc equivalents per target),
  counter-file placement under `yo-out/`, documented in BUILD docs. The flag
  is not `--profile`: that name is already the timing report of `yo build`
  and `yo compile` (`profile: watch round N <ms> rss=…MB`), and a PGO knob
  must not shadow it. BOLT is a later option once PGO exists.

## 5. Gates and sequencing

Every phase: the AGENTS.md battery (`check ./src`, `check ./std`,
`compile --skip-c-compiler`, `build --std-path ./std`, fixpoint,
`gates_fast`, the fast language suite, fmt with the tree binary) **plus the
CP0 table before/after in this file**. CP1a additionally requires a green
UBSan language suite. One PR per phase, or a stack with one battery.

| Phase | Depends on | Can start |
| --- | --- | --- |
| CP0 | — | now |
| CP1b (LTO audit) | CP0 per-compiler numbers | now |
| CP1c (closure audit) | CP0 | now |
| CP1a (`restrict`) | V3b Generation B flip; UBSan canaries | after V3b |
| CP2a (5b) | its own backlog designs | as designed |
| CP2b (`for` lowering) | V2b | after V2b |
| CP2c (assert elision) | §3.10's V1 write-site assert | after V1's remainder |
| CP2d (frozen-cell rule; the declined `RefCell` split's static form) | CP2c's write-site assert; CP0's mark counter | after CP2c |
| CP3 | everything worth profiling | last |

## 6. Risks

- **`restrict` is a soundness claim, not a hint.** A wrong rule is silent UB;
  the UBSan job and the alias stress tests are the only detectors, so the
  rule ships conservative (value-rooted `mut` first, the `Rc`-path rule only
  with the assert-ordering proof) and widens by measurement.
- **CP1b's audit must not regress the default.** ThinLTO's on-by-default is a
  measured position (`CHUNKED_C_EMISSION.md`); any per-compiler change keeps
  dev builds chunked and re-measures `yo build` wall clock in the PR.
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
