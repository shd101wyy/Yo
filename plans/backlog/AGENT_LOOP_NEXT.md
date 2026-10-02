# Agent loop: the post-2026-10 audit queue

**PROPOSED 2026-10-01 — backlog.** What the 2026-10-01 agent-loop audit
(27-agent sweep over `pack/`, `.github/instructions/`, `.github/skills/`,
the CLI surface, the plans and 197 issue docs, plus external research)
leaves as the ranked, unstarted work. The audit's docs-side fixes shipped
in the same PR (pack v3, the yo-verification skill, instruction/skill
truing); this doc carries what needs code or a cycle of its own. The
BEND plan (`BEND_LAWS_AND_AGENT_LOOP_LESSONS.md`) remains the tracker for
B4–B6; this file adds what no plan owned.

## Fix-first (filed issues, compiler-side)

1. ~~A law over an imported callee cannot verify (S2)~~ — FIXED
   2026-10-03 (`issues/fixed/law-over-an-imported-callee-cannot-verify.md`):
   cross-file laws verify, so the `spec/` convention below is unblocked.
2. `issues/yo-context-search-duplicates-rows-and-multiword-queries-hit-nothing.md`
   (S3) — tokenize the query, dedup the rows; recall is the surface's whole
   job. Cheap, high leverage.
3. `issues/init-agentsmd-template-omits-the-verify-recipe.md` (S3) — one
   line + `spec/README.md` scaffold in `src/init.yo`, post-release (rides a
   seed window and re-records the `init-*` goldens).
4. `issues/explain-registry-e13xx-e15xx-bands-unallocated.md` (S3) — start
   with E15xx over the install/fetch family.
5. `issues/yo-doc-help-omits-the-implemented---version-flag.md` (S3) and
   `yo check --help`'s missing `--test-bodies` line (same class).

## The evals corpus (BEND B4) — still the roadmap's Agent-loop item

The single best first PR after the release cut, exactly as B4 specifies it
(`evals/` + `scripts/evals/run.sh`, oracle = `yo verify --strict` green +
runtime tests + zero `assumed()`), plus three things B4 does not name that
the external-research pass argues for:

- a **harness manifest** checked in beside the tasks (model, agent command,
  token/tool budget, tool surface), recorded into `results.tsv` by the
  runner, so a number is attributable to a setup;
- a **public artifact** (GitHub Pages table over `results.tsv`) — Bend
  ships its evals; visibility is half the value of a corpus;
- **not a CI gate** (B4's own rule): the models' arena, not the repo's
  shape.

## Toolchain ideas with a precedent (none started, all S–M effort)

- **`yo mcp`** — a stdio JSON-RPC MCP server wrapping the pure query layer
  (`check`, `context_query`, `explain`, `effects`; `verify_strict`
  opt-in). `YO_CONTEXT.md` D6 deferred MCP pending usage data; Go's
  official experimental gopls MCP server (with its `-instructions`
  context-file pattern) has since set the precedent, and Yo's query layer
  is shim-ready by construction. Revisit D6 with that as the trigger.
- **`yo gate <paths>`** — one verdict collapsing the agent's two-step
  (`yo check` then `yo compile --skip-c-compiler`) plus optional
  `--verify`; text and JSON, naming the first failing stage. The
  check-is-not-codegen distinction is the #1 thing agents get wrong
  (Ronacher's "A Language for Agents" makes the same argument for
  one-command verification).
- **A `unique | candidate | placeholder` tier on `Repair`** — rustc
  Applicability's lesson: the uniqueness rule that gates `yo fix` today
  forces out repairs that are merely *probably* right; tiers let JSON/SARIF
  consumers apply `unique` mechanically and surface `candidate` to the
  model.
- **`yo test --test-name-pattern <p> --repro <out.yo>`** — emit a
  standalone `main`-driven file wrapping the named test's asserts, so the
  failing case is directly `yo compile`-able instead of extracted by hand
  (the extraction is today's documented workaround).

## Explicitly not taken

- Bend 2's dependent-type foundation, hand proofs, mandatory termination —
  re-confirmed by the BEND comparison; unchanged.
- Anything riding the v0.2.48 freeze: B5 (repo-shape CI job — branch
  protection is a manual list), the `src/init.yo` template, search/help
  code fixes. All post-release.
