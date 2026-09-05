# What Yo can take from Zerolang ("The Programming Language for Agents")

**PROPOSED 2026-09-05.** Not a commitment to build anything listed here; it is
the keep/reject audit after studying [vercel-labs/zerolang](https://github.com/vercel-labs/zerolang)
([zerolang.ai](https://zerolang.ai/)). Two items already landed from this
audit — `yo skills install` (restored, see §Adopt 1) and the bilingual CLI
(`--lang` / `YO_LANG`, see §Adopt 6).

## What zerolang is

An experimental Vercel Labs language where **the semantic graph is the
program database**: the compiler-owned `zero.graph` file is the compile
input; the readable `.0` text is only a projection for human review. Agents
don't edit source text — they inspect facts with `zero query` and submit
*named, pre-conditional graph patches* (`zero patch --op ... --expect-graph-hash`),
which the compiler accepts or rejects **before anything is written** —
optimistic concurrency applied to program editing.

Its pitch, verbatim: *"Humans ask for outcomes. Agents query the graph,
submit checked edits, and prove the result."* The traditional loop it
attacks is: agent writes text → format/check/build → read failures → guess
again. Zero's claim is that putting the compiler inside the edit loop, with
stable node IDs, graph hashes, and block-level addressability
(`#block_then_1234`), removes the guessing.

Everything about the surface is designed for a machine consumer: JSON on
every command (`check --json`, `inspect --json`, `size --json`), stable
error codes, version-matched agent skills shipped with the compiler
(`zero skills get agent|graph|language|stdlib`), and an `evals/` suite that
measures how well agents can actually *use* the language.

## The honest caveats

- **It is an unproven labs experiment** — launched May 2026 with fanfare,
  quiet by mid-June (HN), self-described as expecting "breaking changes …
  and security issues". Not a validated authoring model.
- **The double source of truth is real tax**: compile input is the graph,
  but git/review/blame all see the `.0` projection, so Zero needs
  `export` / `import` / `verify-projection` sync rules — including a rule
  that export is *deliberately not* an agent step. That is a patch over the
  exact problem "graph as truth" was supposed to remove.
- **Zero's own text concession is the tell**: it keeps a full readable
  projection because pure structured editing has failed every time it has
  been tried. Text is not the enemy; *unchecked* text edits are.

## What Yo already has (the audit's baseline)

Zero's `raises [E]` + `check` is a weaker Zig-style subset of Yo's
algebraic effects with handlers (`return`/`unwind`); the "what capabilities
does this program retain" question Zero answers with `zero inspect` is the
question `src/evaluator/effects/` already answers for Yo — it just isn't
surfaced as a product. Otherwise already in place:

- the compile-in-the-loop workflow (`yo check ./src`) every contribution
  runs, and the gates battery around it;
- machine-readable surfaces: `--error-format json`, `--json-summary`,
  `unsafe-report --json`, `doc --format json`;
- stable diagnostic codes + offline bilingual explanations (`yo explain
  E0xxx`, `--format json`, did-you-mean);
- a full LSP (`src/lsp/`) computing symbols/references/definition/hover —
  the same facts Zero's `zero query` exposes to agents, currently
  editor-only;
- golden-gated CLI contracts (`scripts/cli-diff-test.sh` +
  `tests/cli-cases/`) — Zero's `command-contracts` equivalent;
- bundled agent skills (`.github/skills/`) and instruction files, and a
  bilingual docs culture (`docs/en-US/`, `docs/zh-CN/`).

## Adopt

Ranked by value/effort. Items 1 and 6 have landed.

1. **Version-matched agent knowledge, distributed with the toolchain.**
   Zero's `zero skills get` exists because training-data knowledge of a
   fast-moving language goes stale; the compiler itself must ship the truth.
   Yo had the right idea early — `yo skills install` (PR #58, TS era) — but
   the P2.5 bootstrap dropped it: the README advertised a command the
   self-hosted compiler no longer had. **Restored in this PR**
   (`src/skills_command.yo`): walks the executable's ancestors (then the
   project's) for a bundled `.github/skills`, and copies into every agent
   config dir found (`.github`, `.agents`, `.claude`, `.opencode`,
   `.openai`, `.cursor`; defaults to `.agents`).
   *Follow-ups:* ship `.github/skills` in release bundles / `install.sh`
   staging (currently only repo checkouts carry it; CI's gate script pins
   `YO_SKILLS` to the checkout — the same mechanism as `YO_STD` — so an
   out-of-tree staged binary still resolves them), and consider a
   `yo doc`-style per-version skills bundle so a project pinned via
   `.yo-version` gets the matching knowledge.
2. **CLI semantic query surface.** The LSP computes symbols, call edges,
   and types; agents live in the terminal. `yo symbols --json` /
   `yo query --fn <name>` (signature, callers/callees, effects) reuses
   `ExprInfoTable` and the LSP modules — packaging, not new analysis.
3. **Effects/capability audit as a report.** The natural Yo answer to
   `zero inspect`/`zero size`: a machine-readable "this program/module uses
   these effects, performs this I/O" report from the existing effects
   analysis (`src/evaluator/effects/`). Explicit effects are already a
   design stance; this productizes it for sandboxing decisions ("may this
   agent-built program touch the network?").
4. **Diagnostics-for-agents, completed.** Codes + `explain` exist; the
   remaining gap is did-you-mean coverage beyond `--target` and
   machine-applicable fix suggestions (`--error-format json` carrying a
   structured suggestion field). Zero's `fix --plan` / `explain` shape is
   the reference.
5. **Agent evals as a language metric.** Zero measures whether agents can
   use the language; Yo's gates measure whether the compiler is correct.
   A small task corpus (bug + tools, scored on fix success) next to
   `gates_fast.sh` would make "agent-friendly" a measured property instead
   of a claim.
6. **Every surface is product — including language.** Zero treats CLI text
   as a designed interface for a non-human consumer. Yo's user base is
   bilingual, so the CLI now is too: a global `--lang` flag / `YO_LANG` env
   var (conventions inherited from `yo explain`) with `src/cli_lang.yo`'s
   `tr(en, zh)` selector; help texts, top-level errors, and `skills` output
   carry both languages. *Follow-up:* the runtime chatter of the deep
   command modules (`build_runner`, `fetch_command`, `install_command`,
   `doc_command`, `init`) is still English-only.

## Reject

- **Graph as the source of truth / the patch protocol.** Yo is a
  self-hosted language: the compiler's own text corpus, `yo fmt`'s
  paren-preserving philosophy, the whole `tests/` + `tests/cli-cases/`
  fixture tree, and git-based review all presume text. Zero's projection-
  sync rules demonstrate the tax without removing it. The correct
  inversion for Yo: **text stays the single truth; compiler facts and
  constrained edits become first-class CLI/LSP citizens** (items 2–4).
  That captures Zero's actual payoff — fewer agent guesses — without the
  dual-truth synchronization layer.
- **Token-efficiency claims, taken on faith.** `zero query` output vs
  reading a focused source region is not obviously cheaper; if item 2
  lands, measure it rather than assert it.

## References

- [vercel-labs/zerolang](https://github.com/vercel-labs/zerolang) ·
  [zerolang.ai](https://zerolang.ai/) ·
  [language reference](https://github.com/vercel-labs/zerolang/blob/main/docs/articles/language-reference.md) ·
  [learn-zero](https://github.com/vercel-labs/zerolang/blob/main/docs/articles/learn-zero.md)
- Restored command ported from the TS-era `src/skills-command.ts` (frozen
  at tag `src-attic-final`).
- The forward-reference limitation this port hit (a module-level `::`
  binding cannot reference itself, forcing the iterative copy walk) is
  exactly what `plans/LAZY_TOPLEVEL_BINDINGS.md` proposes to lift.
