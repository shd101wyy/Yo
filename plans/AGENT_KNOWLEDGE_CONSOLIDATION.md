# Agent knowledge consolidation: no shipped skills, one home per rule

**Status: APPROVED 2026-10-02; AMENDED 2026-10-13 (maintainer).**

- **Landed:** K0 (#1138) and K1 (#1139–#1142).
- **The rest waits for VALUES_BY_DEFAULT V5** (§4 "Order"). VBD is still
  rewriting the language these documents describe, so a sweep before V5 would
  have to be redone.

The 2026-10-13 amendment:

- **D1 reversed.** User projects get no skill files. `yo init` writes
  `AGENTS.md` and a one-line `CLAUDE.md`, and `yo skills install` is deleted
  (K4).
- **K5** checks ` ```yo ` blocks, building on #1288.
- **A post-VBD docs sweep** is added (K7).

The audit numbers in §2 were measured on develop `c24ba33a1`; on 2026-10-13
the skills were still 4,416 lines and the pack 17.5 KB.

This plan extends [`reference/YO_CONTEXT.md`](reference/YO_CONTEXT.md) C6
("pack for rules, skills for workflow"). After the amendment, the pack and the
manuals carry the rules, and `AGENTS.md` carries the trigger.

**Compiler change:** K4 only (`yo init`, and deleting `yo skills install`).
Neither touches std, so there is no seed gate.

---

## 1. The problem

A release ships three overlapping bodies of Yo knowledge:

| Body | Size | How an agent gets it | Version-matched? |
| --- | --- | --- | --- |
| `pack/context.md` | 376 lines, 16.9 KB (24 KB cap) | `yo context` (pull) | yes, served by the installed toolchain |
| `.github/skills/` (6 skills) | ~4,400 lines (`syntax-cheatsheet.md` alone 2,132) | auto-loaded by the agent from the `SKILL.md` `description` (push) | **no**: `yo skills install` copies them into the project, and the copy goes stale on every upgrade |
| `docs/en-US/` manuals | — | `yo context --docs` / `--doc NAME` (#1133), and the website | yes |

Two costs follow.

- **Drift by construction.** Every new pitfall is supposed to be written into
  the cheatsheets, the pack and the instruction files ("update the cheatsheets
  … immediately", `AGENTS.md`), and in practice it never reaches all three.
- **Wrong answers.** The syntax cheatsheet contradicts itself in at least 8
  places: the old and new forms of a rule sit side by side. Several skills
  also state rules the compiler no longer has.

## 2. Audit (2026-10-02, read-only, section by section)

| Skill | Duplicate of pack/docs | Unique (raw → condensed) | Stale | Compiler-dev only |
| --- | --- | --- | --- | --- |
| yo-syntax | ~1,250 | ~270 → ~110 | ~250 | ~250 |
| yo-core-patterns | ~470 | ~110 → ~45 | ~25 | ~35 |
| yo-async-effects | ~350 | ~55 → ~30 | ~35 | — |
| yo-project-workflow | ~320 | ~15 | 2 | ~10 |
| yo-verification | ~150 | ~75 → ~60 | ~6 | — |
| yo-wasm-integration | ~45 | ~200 (mostly JS/npm) | ~3 | — |

Stale claims that would make an agent write wrong code (cheatsheet line
numbers; each claim gets re-verified in K0 before it is edited):

- `async-effects-recipes.md` 354–377: "swallow the error and resume with a
  fallback value by using `return` in the handler". That has been a compile
  error since #1100 (`DESIGN.md` 3274–3278).
- `syntax-cheatsheet.md` 2050: "`ArrayList.push` returns `Result`". `push` is
  infallible.
- `syntax-cheatsheet.md` 962: "`type` is a reserved keyword". Its own line 759
  and the pack say otherwise.
- `syntax-cheatsheet.md` 1591 / 2084: "template strings cannot be nested inside
  `${...}`". They can (line 111, pack line 205).
- `syntax-cheatsheet.md` 1645: "a backtick literal WITHOUT `${...}` is a `str`",
  which contradicts line 100 and the pack (198).
- `syntax-cheatsheet.md` 136, 138, 1197–1207, 1109, 1720: seed gates and
  "fmt never removes parens", all lifted (#1092; `AGENTS.md`: a one-operator
  chain left-associates and `yo fmt` flattens redundant parens).
- `wasm-integration-cheatsheet.md` 22: `{ malloc, free } :: import("std/allocator")`.
  std/allocator exports neither; they are `GlobalAllocator.malloc` / `.free`,
  and both return `Option`.
- `verification-cheatsheet.md` 242–246: lists `for` loops as unsupported, but
  `FORMAL_VERIFICATION.md` 242 documents verified `for` loops.
- `workflow-cheatsheet.md` 190, 209: `[T]` slices (removed) and `yield()`
  (it takes `io`).
- `core-patterns` `SKILL.md` 31: "Use `for(collection.iter(), …)`".
- **The pack has one too:** `pack/context.md` 89–90 says "`yo fmt` preserves
  your parens", contradicting its own lines 99–101.

Three more findings shape the plan:

- **~250 lines of compiler-developer content ship to users**: proto-evaluator
  source strings, `get_callee`, backticks in emitted C, seed gates, `src/` API
  gotchas, and core-patterns' "yo-self API". It belongs in
  `.github/instructions/`.
- **Some user-facing facts have no manual today:** `yo fmt`'s paren rules, the
  loop-invariant tutorial and `vacuous` / `--rlimit`, the law same-file
  limitation, `join_all` inside `io.async`, the async-recursion worklist,
  associated constants and static trait methods, the `String` out-parameter
  value-copy trap, `unwind` skipping restore, and the circular-derive trap.
  These need a home **before** anything is deleted.
- **Nothing compiles documentation code blocks.** GATE 8 (`gates_fast.sh`)
  covers only the installer and release snippets. Skills, pack and manual
  examples are unchecked, which is how the stale claims above survived.

## 3. Decisions

- **D1. No skills in user projects (revised 2026-10-13, maintainer).**
  - **What the original D1 said:** skills stay a separate, thin artifact. Their
    value was the trigger: an agent auto-loads a skill whose `description`
    matches the task, and `yo context` only helps once the agent knows to run
    it.
  - **Why the trigger no longer needs a skill tree:**
    - The `AGENTS.md` that `yo init` writes already opens its command block
      with "`yo context` — the language pack + API index — read this first".
    - Codex, Cursor, Copilot and Gemini read `AGENTS.md` natively. Claude Code
      reads `CLAUDE.md`, so `yo init` also writes a one-line `CLAUDE.md`
      holding `@AGENTS.md`, as this repository does.
    - Those two small files trigger every major agent. The content an agent
      then needs is `yo context`, which is version-matched.
  - **What the skill tree costs:**
    - The copy goes stale by construction: `yo skills install` copies one
      release's files, and the next upgrade makes them wrong.
    - Keeping it right would take the pruning installer the original K4
      planned, which is more code to maintain a copy that only says "run
      `yo context`".
    - It costs `src/skills_command.yo` (433 lines, copying into six agent
      directories), three skills cli-cases, the `init`/`skills` goldens that
      hash the skill tree (re-recorded twice on 2026-10-13, #1334 and #1339,
      for cheatsheet edits), and a copy in every release bundle.
  - **The accepted loss:** an agent that never reads `AGENTS.md`, working on a
    Yo file inside an unrelated repository, no longer gets Yo knowledge pushed
    to it. `yo context` stays one command away.
- **D2. One home per fact.**

  | Kind | Home | Why |
  | --- | --- | --- |
  | Language rules and sharp edges an agent needs before writing code | `pack/context.md` | version-matched, always one command away; 24 KB cap |
  | Depth, tutorials, rationale | `docs/en-US` + `docs/zh-CN` manuals | served by `yo context --doc` |
  | Compiler-development knowledge | `.github/instructions/` | never shipped to users |
  | Workflow and the trigger ("how to work in a Yo project", "run `yo context` first") | the `AGENTS.md` that `yo init` writes | read natively by most agents; `CLAUDE.md` imports it |

- **D3. The generated `AGENTS.md` contains nothing version-specific.** It holds
  the commands and the pointer to `yo context`; anything that changes between
  releases is reached through `yo context`. A project's `AGENTS.md` then stays
  correct when the user upgrades `yo`. (This was D3's rule for thin skills,
  which D1 now removes.)
- **D4. Code blocks in the pack and the manuals are checked.** A gate type-checks
  them (K5), so a removed form fails CI instead of surviving in prose.

## 4. Phases

Each phase is one PR, merged on local gates. Every phase runs `yo fmt` on any
touched `.yo` and keeps `docs/en-US` and `docs/zh-CN` in step.

**Order (amended 2026-10-13).** K0 and K1 have landed. Everything else waits
until VALUES_BY_DEFAULT V5 has landed, along with every Generation B half:
VBD is still changing the language these documents describe. After that:

1. K2 and K3: move the compiler-dev content out, and condense the pack.
2. K5: the snippet gate. Its first run is the inventory for K7.
3. K7: the post-VBD docs sweep.
4. K4: delete the skills and `yo skills install`.
5. K6: point the rules at the new layout.

Then VALUES_BY_DEFAULT §6 "After V5: retire the `yo fix` migrations" runs: the
six README example projects are migrated, then the `--migrate` modes are
deleted. The docs keep naming `--migrate` modes until that PR, which removes
them.

### K0 — Fix what is wrong (correctness first) — LANDED (#1138)

Re-verify each stale claim in §2 against the current compiler with a
`tmp/fixme.yo` probe, then correct it where it stands, before anything moves.
That covers the cheatsheets, both `SKILL.md` lines, the pack's line 89–90 and
`DESIGN.md` §recur 953, which still implies `recur` is required. A claim that
turns out true while a manual says otherwise is a docs bug. A claim that
reveals broken code is a compiler bug: it gets an `issues/` entry with a
severity and a failing test, as usual.

### K1 — Give homes to the unique facts — LANDED (#1139–#1142)

Write the §2 "no manual today" facts into their manual. Each takes a few lines
and is added in both languages:

- `FORMAL_VERIFICATION`: §Loop invariants (new, ~35 lines), `vacuous` /
  `--rlimit` / `--solver-path`, the law same-file limitation, the recipes.
- `ASYNC_AWAIT`: `join_all` inside `io.async`, the captured-local suspend
  issue, the async-recursion worklist.
- `DESIGN`: associated constants, trait where-clause projection, static trait
  methods, duplicate imports, the `String` out-parameter value copy, and
  `yo fmt`'s paren rules under §CLI.
- `ALGEBRAIC_EFFECTS`: `unwind` skips restore.
- `DERIVE_TRAITS`: the circular-derive trap (re-verify; the cheatsheet's
  example is itself rejected).
- A new **`WASM.md`** grown from `INSTALL_WASM.md` and the wasm cheatsheet's
  ~200 unique lines: API pattern, npm layout, JS/TS wrappers, string passing.

### K2 — Move compiler-dev content out of the shipped skills

(After V5. Re-audit first: VBD will have outdated part of the ~250 lines.)

Move the ~250 lines into `c-codegen`, `testing`, `debugging` and
`yo-syntax.instructions.md`, dropping anything those files already say. Seed
gates go to `plans/backlog/SEED_VERSION_AUTOMATION.md` when still live, and are
deleted when lifted.

### K3 — Pack: trim ~60 lines, add ~50–60

(After V5. The line numbers below are from the 2026-10-02 audit; re-read the
pack before editing.)

- **Trim:** shorten Verification (319–336) to a pointer to `--doc
  FORMAL_VERIFICATION` once K1 has moved its caveat. Remove the duplicate
  sharp edges (347–350, 360–363), the Option/Result block (219–235), and the
  toolchain and types prose already in the manuals.
- **Add:** the condensed unique sharp edges from the cheatsheets: `return(unit)`
  and dead code after `return`, `Option ==`, named tuple fields, parameter
  reassignment, `dyn` needing `Error`, `comptime_str`, the closed operator set,
  the `=>` arm-paren rule, and the E1104 comptime-locals rule.
- **Limit:** stays under 24 KB (`wc -c` in the PR). If the adds would overflow
  it, the overflow goes to a manual, not the pack.

### K4 — Delete the shipped skills and `yo skills install` (amended 2026-10-13)

The original K4 slimmed each `SKILL.md` and made `yo skills install` prune.
With D1 reversed:

- **First, verify nothing unique is left.** K1 and K2 have rehomed the
  skills' unique facts. Diff each cheatsheet against the pack and the manuals
  one last time, and move anything still unique into its D2 home.
- **Delete** `.github/skills/` (all six skills and their cheatsheets).
- **Delete `yo skills install`**:
  - `src/skills_command.yo` and its dispatch and help text in `src/main.yo`,
    in both CLI languages;
  - the `skills-install`, `skills-install-zh` and `skills-unknown-action`
    cli-cases;
  - `yo init --no-skills` and the `init-no-skills` case.
  - `src/context_command.yo`'s pack lookup stays. Its comments describe it as
    mirroring the skills lookup, so they are rewritten to stand alone.
  - `scripts/bootstrap/gates_fast.sh` and `scripts/install.sh` stop pinning
    and installing `.github/skills`.
- **`yo init`** writes `AGENTS.md` and a one-line `CLAUDE.md` containing
  `@AGENTS.md`, and copies no skill tree.
  - The generated `AGENTS.md` drops its "Yo agent skills" section and its
    "refresh the skills" footer. It keeps the command block that starts with
    `yo context`.
  - An existing `AGENTS.md` or `CLAUDE.md` is left alone, as `AGENTS.md` is
    today.
  - Re-record the `init*` goldens. They no longer contain a skill tree, so
    later documentation edits stop touching them.
- **Release bundles** stop carrying `.github/skills` (`release.yml`'s seed
  and native bundles).
- **Docs, en-US and zh-CN:**
  - `README.md` "AI Agent Skills" becomes a short "AI agents" section: `yo init`
    writes `AGENTS.md`, and `yo context` is the version-matched language pack.
  - `BUILD_SYSTEM.md`'s project tree drops `.agents/skills/`.
  - `CONTEXT.md` says the same as the new README section.
- **Existing projects.** There is no compatibility shim (single-user policy).
  The six README example projects delete any committed skill copies during the
  migration that VALUES_BY_DEFAULT's "retire the migrations" step gates on.

### K5 — The snippet gate (amended 2026-10-13)

#1288 already makes `yo fmt` format ` ```yo ` blocks in `docs/`, `.github/` and
`README.md`, and CI checks that they parse. A fragment or an intentionally
invalid example is fenced ` ```yo ignore `. (The original text named
` ```rust ` blocks, but since 2026-10-10 every Yo block is fenced ` ```yo `.)

K5 upgrades that parse check to a **type-check**.

- **Scope:** each ` ```yo ` block (not `ignore`) in `pack/context.md`,
  `docs/en-US/*.md`, `docs/zh-CN/*.md` and `README.md` is extracted and run
  through `yo check`.
- **Running it:** the gate runs in `gates_fast.sh` and in CI. A block that is a
  fragment and cannot type-check on its own is fenced ` ```yo ignore `.
- **Its first run is K7's inventory.** Every block still written in a pre-VBD
  form fails.
- **The opt-out risk (§6) stands:** K5 reports the `ignore` count, and a
  rising count gets questioned in review.

### K6 — Rules that point at the old layout

- `AGENTS.md` "update the cheatsheets … immediately" becomes "update the pack,
  the manual, or `.github/instructions/`, whichever is the fact's home (§D2)".
  Its "skill files (`.github/skills/`)" check-after-a-change line, its
  `src/skills_command.yo` row and its `yo skills install` command go.
- Fix the references to the removed files: `.github/instructions/` (the
  `yo-syntax` cheatsheet's string-indexing pointer, the `yo-design` "keep …
  cheatsheets in step" lines, the `testing` golden note), `docs/en-US` and
  `zh-CN` `CONTEXT.md`, and `reference/YO_CONTEXT.md` (an addendum linking
  here: C6's "skills for workflow" is superseded by D1).

### K7 — The post-VBD docs sweep (added 2026-10-13, maintainer)

Once V5 has landed, the docs still describe the language as VBD found it. K7
removes that old content in one pass, after K5's gate has listed what no
longer checks.

- **Scope:** `docs/en-US` and `docs/zh-CN` (every manual), `README.md`,
  `pack/context.md`, `.github/instructions/`, and the doc comments in `std/`
  that `yo doc` publishes. `plans/`, `issues/` and `code-reviews/` are
  historical records and stay as they are (`AGENTS.md`, "Reading historical
  documents").
- **What goes:**
  - Every pre-VBD form: `ref(...)`/`atomic(...)` types, the old parameter
    words (`own`, `sink`, `inout`, `imm(x)`, `mut(x)`), `Dispose` (after the
    Drop rename), implicit copies of owning values, a bare closure into a
    `Dyn(Fn)` slot, and the pre-A1 future and handle forms.
  - **History narration in user docs** ("used to be", "since vX.Y.Z", "was
    renamed from", "before #NNN"): a manual describes the language as it is,
    and the record of how it got there belongs in `plans/` and `issues/`. A
    migration note may stay only where a migration still exists, until
    VALUES_BY_DEFAULT's "retire the migrations" step removes it.
  - Manuals and sections whose subject was deleted, such as
    `COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md` (replaced,
    VALUES_BY_DEFAULT §3.14), and the links that point to them.
- **How:**
  - K5's failures are the work list for code.
  - A grep list of the removed spellings, plus the history phrases above, is
    the work list for prose.
  - Each manual's en-US and zh-CN pages are swept in the same PR.
  - Split by manual if a PR gets large.
- **Exit:**
  - K5 is green over every manual with no new `ignore` tags.
  - The grep list finds nothing outside `plans/`, `issues/` and
    `code-reviews/`.
  - Each manual's zh-CN page matches its en-US page section by section.

## 5. Exit criteria

1. No rule is stated in both the pack and a manual. A spot-check of the §2
   duplicate sections finds each in exactly one home.
2. `.github/skills/`, `src/skills_command.yo` and `yo skills install` are
   gone. `yo init` writes `AGENTS.md` and `CLAUDE.md` and copies no skill
   tree. Release bundles carry no skills.
3. Every §2 stale claim is fixed or deleted. The snippet gate (K5) type-checks
   the pack and every manual, and is green.
4. The pack stays under 24 KB.
5. K7's grep list of pre-VBD forms and history phrases finds nothing in the
   user docs.

## 6. Risks and open questions

- **Translation volume.** K1 adds roughly 400 lines to the manuals, and every
  one needs a zh-CN counterpart. It is the slowest part of the plan, so split
  K1 by manual if one PR gets too large.
- **Does `AGENTS.md` trigger as well as a skill did?** For agents that read
  `AGENTS.md` (or `CLAUDE.md`), it is loaded at session start, which is
  earlier and more reliable than a skill matching on its `description`. The
  loss is an agent that reads neither, working on Yo code inside an unrelated
  repository (D1). Measuring it waits for the BEND B4 evals harness, as
  `YO_CONTEXT.md` exit criterion 3 does.
- **The snippet gate's opt-out tag.** It must not become a way to hide stale
  examples. K5 reports the opt-out count, and a rising count gets questioned
  in review.
