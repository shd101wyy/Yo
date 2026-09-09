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

Active work (root) — **7 docs, and nothing else lives here**:

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
- [`PERF_BORROW_ELISION.md`](PERF_BORROW_ELISION.md) — cutting RC traffic in
  the self-compile; in progress.

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
….

Backlog (`backlog/`) — written, not started. Recent additions:
[`backlog/UNSAFE_SCOPING_AND_POINTER_ITERATORS.md`](backlog/UNSAFE_SCOPING_AND_POINTER_ITERATORS.md)
(unsafety is FILE-scoped in Yo, which is what makes the D14 pointer `iter()`
expensive — with probes and a Rust/Swift comparison),
[`backlog/FUNCVAL_ENV_SHARING.md`](backlog/FUNCVAL_ENV_SHARING.md) (the
mechanism was built and rejected twice; kept because the failure modes
generalize) and
[`backlog/ZEROLANG_AGENT_FIRST_LESSONS.md`](backlog/ZEROLANG_AGENT_FIRST_LESSONS.md)
(a keep/reject audit, explicitly not a commitment).

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
