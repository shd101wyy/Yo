# plans/ — design and planning documents

One markdown file per feature design, migration plan, or campaign roadmap.
Always create new design/plan documents here (see `AGENTS.md` workflow rules).

## Layout

| Location   | Meaning                                                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| `./*.md`   | **Living documents** — designs of shipped features (kept as reference) and actively-driving plans/roadmaps                 |
| `backlog/` | **Backlog** — designs and ideas for future work: written but not started, or explicitly parked/deferred                    |
| `archive/` | **Closed** — completed campaign docs, superseded roadmaps, and one-off audits; each carries a banner saying what closed it |

Current entry points:

- [`ROADMAP.md`](ROADMAP.md) — overall language/product roadmap.
- [`BOOTSTRAPPING.md`](BOOTSTRAPPING.md) — the (completed) bootstrap campaign
  record; umbrella over the archived per-slice docs.
- [`SELF_HOSTING_COMPLETION.md`](SELF_HOSTING_COMPLETION.md) — the active
  next-phase roadmap and umbrella over P1-P4: full CLI parity in yo-self,
  retiring `src/` + bun, release bundles + install scripts, LSP + VS Code.
  Its "Where the phases actually stand" table is the fastest status read.

Its per-phase working docs, in order:

- [`P1_CLI_PARITY.md`](P1_CLI_PARITY.md) — **COMPLETE 2026-08-10.** Kept for
  the method notes and the three verified-false premises it found in P1's own
  plan. Supersedes `archive/PRE_P1_HANDOVER.md`.
- [`P2_RETIRE_SRC.md`](P2_RETIRE_SRC.md) — **the active handover; start here.**
  2.1/2.2/2.4 done, 2.3 in review, and the two-generation rule that governs
  when a codegen fix can reach a seed-built CI job.
- [`P2_5_RETIRE_EXECUTION.md`](P2_5_RETIRE_EXECUTION.md) — the audited
  deletion plan for `src/`: 9 blockers, 28 steps, the deletion manifest, and
  the scope decisions still open for the maintainer. **The deletion has
  LANDED**: the TypeScript compiler, the bun/npm toolchain and the `./yo-cli`
  shims are gone, frozen at the `src-attic-final` tag, and `yo-self/` is now
  the only compiler (its rename to `src/` is the one step still pending).
- [`P3_DISTRIBUTION.md`](P3_DISTRIBUTION.md) — installers (landed), `yo
version` on GitHub Releases (urgent — npm publishing stopped at v0.2.0), and
  static-musl Linux bundles.
- [`P4_LSP.md`](P4_LSP.md) — the LSP rewrite in Yo: measured sizing, the
  transport spike (green) and the diagnostics spike (red — blocked on the
  def-eval swallow). Supersedes `LSP_IMPLEMENTATION.md`, which planned the
  TypeScript server that retires with `src/`.

Cross-cutting:

- [`HANDOVER_DEF_EVAL_SWALLOW.md`](HANDOVER_DEF_EVAL_SWALLOW.md) — **active
  handover for the def-eval swallow endgame** (the blocker P4's diagnostics
  spike is waiting on) plus the merge order for PRs #110 → #98 → #112. Carries
  the ordering probe that refuted the previous "trial runs outside the impl
  field loop" conclusion, and the Case-2 forward-shell attempt that regressed
  `imm_map` — read it before touching `yo-self/evaluator/values/impl.yo`.

Conventions:

- When a plan completes (or is refuted/superseded), add a closing banner at
  the top stating the outcome and the commit/run that proved it, then
  `git mv` it into `archive/` and update references
  (`grep -rn "plans/<NAME>.md"`).
- Historical status numbers inside archived docs are frozen at their writing
  dates — do not update them; the banner is the authoritative summary.
