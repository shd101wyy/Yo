# plans/ — design and planning documents

One markdown file per feature design, migration plan, or campaign roadmap.
Always create new design/plan documents here (see `AGENTS.md` workflow rules).

## Layout

| Location       | Meaning                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `./*.md`       | **Active** — plans and handovers actively driving work right now. Nothing else lives here.                                                        |
| `reference/`   | **Landed designs & decision records** — shipped-subsystem designs and policy decisions kept as the authoritative reference (still true, nothing pending). |
| `backlog/`     | **Backlog** — designs and ideas for future work: written but not started, or explicitly parked/deferred.                                          |
| `archive/`     | **Closed** — completed campaigns, refuted/rejected proposals, superseded roadmaps, one-off audits; each carries a banner stating its outcome.      |

Every doc states its status in its first lines: active docs carry a live
Status header; archived docs carry a closing banner (outcome + the commit/run
that proved it). Historical numbers inside archived docs are frozen at their
writing dates — the banner is the authoritative summary.

## Current entry points

Active work (root) — **8 docs, and nothing else lives here**:

- [`ROADMAP.md`](ROADMAP.md) — overall language/product roadmap.
- [`STD_API_STABILIZATION.md`](STD_API_STABILIZATION.md) — the live std
  campaign. **All eleven §2 decisions (D9–D19) are LANDED**; §4 (P1 batteries
  per module group) and §5 (maintainer decisions: `imm`/`Vec` structure,
  `MemoryOrder.Consume`, HashMap random keys) remain. Raw per-module findings:
  [`STD_API_STABILIZATION_FINDINGS.md`](STD_API_STABILIZATION_FINDINGS.md).
- [`HANDOVER_STD_AUDIT_2026-09-07.md`](HANDOVER_STD_AUDIT_2026-09-07.md) — the
  live handover: the PR stack and its verified merge order, what is still open
  and why, and the rules that bit the last session.
- [`THREAD_SAFETY.md`](THREAD_SAFETY.md) — 13 of 14 phases landed; Phase P
  (field visibility) never landed — `_`-prefixed fields are private by
  CONVENTION only.
- [`INCREMENTAL_COMPILATION_ZIG_LESSONS.md`](INCREMENTAL_COMPILATION_ZIG_LESSONS.md) —
  edit-compile-run latency: what Yo takes from Zig's incremental design
  (per-definition hashing + dependency edges, stable symbol identity, a
  resident evaluator, per-module TUs) and what it does not (native
  backend, in-place patching). Phase 0 = instrumentation; nothing started.
- [`PERF_BORROW_ELISION.md`](PERF_BORROW_ELISION.md) — cutting RC traffic in
  the self-compile; in progress.
- [`BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN.md`](BUILD_AND_DEPENDENCY_SYSTEM_REDESIGN.md) —
  PROPOSED 2026-09-11: the build/dependency audit (the dependency system is
  fetch-only — `import("dep")` never resolves; `Step.link` does not link;
  `build.yo` errors are swallowed — five issues filed) and the redesign:
  `yo.toml` manifest (declarative, read without the evaluator, edited in place), semver ranges over git tags with a Cargo-style
  resolver, `yo.lock` v2 with integrity, a content-addressed store,
  explicit `--imports` plumbing to the child compile, workspaces; plus the
  compile-time-input decisions (`comptime_read_file` and
  `comptime_json_parse`/`comptime_toml_parse` yes, `comptime_fetch` no,
  `build.env` in the build context only).

Closed campaigns (`archive/`) — self-hosting is **finished**. The compiler has
been self-hosting since 2026-08-03, the TypeScript compiler was retired
2026-08-20 (tag `src-attic-final`), distribution and LSP shipped. Start from
[`archive/BOOTSTRAPPING.md`](archive/BOOTSTRAPPING.md) (the bootstrap campaign,
GOAL ACHIEVED) and
[`archive/SELF_HOSTING_COMPLETION.md`](archive/SELF_HOSTING_COMPLETION.md)
(the P1–P4 umbrella); the per-phase records (`P1_CLI_PARITY.md`,
`P2_RETIRE_SRC.md`, `P2_5_RETIRE_EXECUTION.md`, `P3_DISTRIBUTION.md`,
`P4_LSP.md`) sit alongside them.

The **std API campaign's first half** closed 2026-09-07:
[`archive/STD_API_AUDIT.md`](archive/STD_API_AUDIT.md) (the 2026-08-22 audit —
S0–S5 complete, superseded by `STD_API_STABILIZATION.md`), with its sub-plan
[`archive/STD_API_AUDIT_D4_PLAN.md`](archive/STD_API_AUDIT_D4_PLAN.md)
(byte-indexed strings) and method notes
[`archive/STD_API_AUDIT_HANDOVER.md`](archive/STD_API_AUDIT_HANDOVER.md).
Its superseded handovers (`HANDOVER_2026_08_28.md`,
`HANDOVER_STD_AUDIT_NEXT.md`, and the dated 08-30 / 09-01 / 09-02 / 09-05 /
09-06 files) are archived alongside;
[`archive/D6_TLS_PLAN.md`](archive/D6_TLS_PLAN.md) closed with Windows
Schannel TLS in v0.2.26.

Landed designs & decisions (`reference/`) — done but still true. Subsystem
designs: [`reference/BUILD_SYSTEM.md`](reference/BUILD_SYSTEM.md),
[`reference/DEPENDENCY_MANAGEMENT.md`](reference/DEPENDENCY_MANAGEMENT.md),
[`reference/VERSION_MANAGEMENT.md`](reference/VERSION_MANAGEMENT.md),
[`reference/ERROR_DIAGNOSTICS_OVERHAUL.md`](reference/ERROR_DIAGNOSTICS_OVERHAUL.md),
[`reference/PORTABLE_C_DISTRIBUTION.md`](reference/PORTABLE_C_DISTRIBUTION.md),
[`reference/ASYNC_ITERATION_STREAM.md`](reference/ASYNC_ITERATION_STREAM.md)
(the `Stream` trait — async iteration, LANDED 2026-09-11 with `for_await` and
`BufReader.lines` parked in `backlog/`),
…. Policy decisions:
[`reference/MACRO_POLICY.md`](reference/MACRO_POLICY.md),
[`reference/TARGET_TRIPLES.md`](reference/TARGET_TRIPLES.md),
[`reference/FUNCTION_OVERLOADING_POLICY.md`](reference/FUNCTION_OVERLOADING_POLICY.md),
[`reference/LAZY_TOPLEVEL_BINDINGS.md`](reference/LAZY_TOPLEVEL_BINDINGS.md)
(order-independent definitions, LANDED 2026-09-05),
[`reference/OPERATOR_SET_AND_PRECEDENCE.md`](reference/OPERATOR_SET_AND_PRECEDENCE.md),
[`reference/WINDOWS_ALLOCATOR_DECISION.md`](reference/WINDOWS_ALLOCATOR_DECISION.md),
[`reference/MATCHING_LOGIC_RESEARCH.md`](reference/MATCHING_LOGIC_RESEARCH.md)
(matching logic / K assessed and declined as the verifier foundation, 2026-09-09),
[`reference/REMOVE_OPEN_BUILTIN.md`](reference/REMOVE_OPEN_BUILTIN.md)
(the `open(...)` builtin removed 2026-09-10 — glob imports are
`{ ... } :: import(...)`, and the migration rules there are how to read an
`open(...)` in an older doc),
….

Backlog (`backlog/`) — written, not started. Recent additions:
[`backlog/UNSAFE_SCOPING_AND_POINTER_ITERATORS.md`](backlog/UNSAFE_SCOPING_AND_POINTER_ITERATORS.md)
(unsafety is FILE-scoped in Yo, which is what makes the D14 pointer `iter()`
expensive — with probes and a Rust/Swift comparison),
[`backlog/FUNCVAL_ENV_SHARING.md`](backlog/FUNCVAL_ENV_SHARING.md) (the
mechanism was built and rejected twice; kept because the failure modes
generalize) and
[`backlog/ZEROLANG_AGENT_FIRST_LESSONS.md`](backlog/ZEROLANG_AGENT_FIRST_LESSONS.md)
(a keep/reject audit, explicitly not a commitment). Three landed 2026-09-11
alongside `reference/ASYNC_ITERATION_STREAM.md`, each parking a piece of it
with the blocker measured:
[`backlog/FOR_AWAIT_NEEDS_MACRO_AWARE_ASYNC_TRANSFORM.md`](backlog/FOR_AWAIT_NEEDS_MACRO_AWARE_ASYNC_TRANSFORM.md)
(an `io.await` inside a macro expansion compiles to a BLOCKING await, so an
awaiting macro deadlocks in a task),
[`backlog/ASYNC_LINES_NEEDS_A_NONTHROWING_READ.md`](backlog/ASYNC_LINES_NEEDS_A_NONTHROWING_READ.md)
(an async `BufReader.lines` needs a `Reader` that returns its failure instead
of throwing it) and
[`backlog/ASSOC_TYPE_BINDING_IN_FREE_FN_WHERE.md`](backlog/ASSOC_TYPE_BINDING_IN_FREE_FN_WHERE.md)
(`where(T <: Trait(Assoc := A))` binds nothing when `A` is a generic — true of
`Iterator` too).

**Language features the std campaign is blocked on** (added 2026-09-10, each
written from the std row that needs it, with the blocked call sites named):

- [`WAKER_BASED_SCHEDULING.md`](WAKER_BASED_SCHEDULING.md) — the largest one,
  and **now active** (moved out of `backlog/` on 2026-09-11). Everything that
  waits on a peer used to poll a **1 ms timer**, putting a millisecond floor
  under every hand-off and making `spawn_blocking` inexpressible. The `Waker` +
  `park` primitive and the async `Mutex` over it have landed; `yield` is
  seed-gated, `Channel` is blocked on a tracer defect, and the combinators and
  cross-thread wake are open — the doc's status table says which is which.
- [`backlog/MEMBER_VISIBILITY.md`](backlog/MEMBER_VISIBILITY.md) — Yo has no
  visibility mechanism; the leading-underscore convention standing in for it
  covers **752 members** in `std/` and enforces nothing. Blocks three
  stabilization rows, including `Mutex._raw_lock`.
- [`backlog/ASYNC_ITERATION_STREAM.md`](backlog/ASYNC_ITERATION_STREAM.md) —
  no async analogue of `Iterator`, so four std APIs have each invented their
  own "value, later, repeatedly" shape. Blocks `TcpListener.incoming`. This
  one needs **no compiler change**.
- [`backlog/VALUE_SUBSTITUTION_IN_TYPE_POSITIONS.md`](backlog/VALUE_SUBSTITUTION_IN_TYPE_POSITIONS.md)
  — an associated constant in a TYPE position (`Array(u8, T.BYTES)`) silently
  resolves to **0**. Blocks collapsing the ten per-type byte conversions, and
  `usize`/`isize` having them at all.
- [`backlog/THREAD_LOCAL_STORAGE.md`](backlog/THREAD_LOCAL_STORAGE.md) — no
  thread-local storage, so `rand.thread_rng` is not expressible.

Two things measured while writing these, both of which turned out to be
features Yo already HAS despite comments in the tree saying otherwise:
associated **types** (`Item : Type`, `Self.Item`, used as a return type and as
a constructor) and associated **constants** in a value position (`T.BITS`).
Probe before working around.

## Conventions

- When a plan completes (or is refuted/superseded), add a closing banner at
  the top stating the outcome and the commit/run that proved it, then
  `git mv` it into `archive/` — or into `reference/` if it is a landed
  design/decision that stays authoritative — and update references
  (`grep -rn "plans/<NAME>.md"`).
- A doc that is written but not started goes to `backlog/`; promote it to the
  root when work starts. When a root doc lands, graduate it to `reference/`.
- Historical status numbers inside archived docs are frozen at their writing
  dates — do not update them; the banner is the authoritative summary.
