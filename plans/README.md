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
  next-phase roadmap: full CLI parity in yo-self, retiring `src/` + bun,
  release bundles + install scripts, LSP + VS Code.

Conventions:

- When a plan completes (or is refuted/superseded), add a closing banner at
  the top stating the outcome and the commit/run that proved it, then
  `git mv` it into `archive/` and update references
  (`grep -rn "plans/<NAME>.md"`).
- Historical status numbers inside archived docs are frozen at their writing
  dates — do not update them; the banner is the authoritative summary.
