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

Active work (root):

- [`ROADMAP.md`](ROADMAP.md) — overall language/product roadmap.
- [`STD_API_AUDIT.md`](STD_API_AUDIT.md) — the std API stabilization campaign
  (audit done; the §8 open questions are being worked), with
  [`STD_API_AUDIT_D4_PLAN.md`](STD_API_AUDIT_D4_PLAN.md) (D4 sub-plan) and
  [`STD_API_AUDIT_HANDOVER.md`](STD_API_AUDIT_HANDOVER.md) (method notes).
- [`HANDOVER_2026_08_28.md`](HANDOVER_2026_08_28.md) — the live handover for
  that campaign.
- [`LAZY_TOPLEVEL_BINDINGS.md`](LAZY_TOPLEVEL_BINDINGS.md) — PROPOSED
  2026-09-02: order-independent `::` definitions via pending bindings.
- [`THREAD_SAFETY.md`](THREAD_SAFETY.md) — 13 of 14 phases landed; Phase P
  (field visibility) is still open.
- [`FUNCVAL_ENV_SHARING.md`](FUNCVAL_ENV_SHARING.md) — capture-rebuild env
  sharing; the endgame steps remain.
- [`PERF_BORROW_ELISION.md`](PERF_BORROW_ELISION.md) and
  [`D6_TLS_PLAN.md`](D6_TLS_PLAN.md) (PR-2/PR-3 remain) — in flight.

Closed campaigns (`archive/`) — self-hosting is **finished**. The compiler has
been self-hosting since 2026-08-03, the TypeScript compiler was retired
2026-08-20 (tag `src-attic-final`), distribution and LSP shipped. Start from
[`archive/BOOTSTRAPPING.md`](archive/BOOTSTRAPPING.md) (the bootstrap campaign,
GOAL ACHIEVED) and
[`archive/SELF_HOSTING_COMPLETION.md`](archive/SELF_HOSTING_COMPLETION.md)
(the P1–P4 umbrella); the per-phase records (`P1_CLI_PARITY.md`,
`P2_RETIRE_SRC.md`, `P2_5_RETIRE_EXECUTION.md`, `P3_DISTRIBUTION.md`,
`P4_LSP.md`) sit alongside them.

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
[`reference/OPERATOR_SET_AND_PRECEDENCE.md`](reference/OPERATOR_SET_AND_PRECEDENCE.md),
[`reference/WINDOWS_ALLOCATOR_DECISION.md`](reference/WINDOWS_ALLOCATOR_DECISION.md),
….

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
