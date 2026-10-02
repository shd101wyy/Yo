# Agent knowledge consolidation: thin skills, one home per rule

**Status: APPROVED 2026-10-02, starts after v0.2.49.** No phase has landed.
The audit numbers in §2 were measured on develop `c24ba33a1`. This plan extends
[`reference/YO_CONTEXT.md`](reference/YO_CONTEXT.md) C6 ("pack for rules,
skills for workflow"), which reconciled the skills only lightly. **No compiler
or std change** except K4's `yo skills install` pruning, so there is no seed
gate.

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

- **D1. Skills stay a separate artifact, but thin.** Their value is the
  trigger: an agent auto-loads a skill whose `description` matches the task,
  and `yo context` only helps once the agent knows to run it. Each `SKILL.md`
  keeps its frontmatter, the handful of rules that matter most, and pointers
  (`yo context`, `yo context <module>`, `yo context --doc GRAMMAR`). The
  cheatsheets go away. Skills do not move into `docs/`: `docs/` is bilingual
  user documentation, and agents discover skills in `.agents/`, `.claude/`,
  `.cursor/` and `.github/`.
- **D2. One home per fact.**

  | Kind | Home | Why |
  | --- | --- | --- |
  | Language rules and sharp edges an agent needs before writing code | `pack/context.md` | version-matched, always one command away; 24 KB cap |
  | Depth, tutorials, rationale | `docs/en-US` + `docs/zh-CN` manuals | served by `yo context --doc` |
  | Compiler-development knowledge | `.github/instructions/` | never shipped to users |
  | Workflow ("how to work in a Yo project") | `SKILL.md` | the trigger surface |

- **D3. A thin skill contains nothing version-specific.** Anything that changes
  between releases is reached through `yo context`, so a project's installed
  skill copy stays correct when the user upgrades `yo`.
- **D4. Code blocks in the pack, skills and manuals are checked.** A gate
  extracts them and compiles them (K5), so a removed form fails CI instead of
  surviving in prose.

## 4. Phases

Each phase is one PR, merged on local gates. Every phase runs `yo fmt` on any
touched `.yo` and keeps `docs/en-US` and `docs/zh-CN` in step.

### K0 — Fix what is wrong (correctness first)

Re-verify each stale claim in §2 against the current compiler with a
`tmp/fixme.yo` probe, then correct it where it stands, before anything moves.
That covers the cheatsheets, both `SKILL.md` lines, the pack's line 89–90 and
`DESIGN.md` §recur 953, which still implies `recur` is required. A claim that
turns out true while a manual says otherwise is a docs bug. A claim that
reveals broken code is a compiler bug: it gets an `issues/` entry with a
severity and a failing test, as usual.

### K1 — Give homes to the unique facts

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

Move the ~250 lines into `c-codegen`, `testing`, `debugging` and
`yo-syntax.instructions.md`, dropping anything those files already say. Seed
gates go to `plans/backlog/SEED_VERSION_AUTOMATION.md` when still live, and are
deleted when lifted.

### K3 — Pack: trim ~60 lines, add ~50–60

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

### K4 — Slim the skills; `yo skills install` prunes

- Each `SKILL.md` becomes ≤ 80 lines: frontmatter `description` (the trigger,
  unchanged unless wrong), "run `yo context` first", the top rules for that
  area, and a pointer table to the manuals.
- Delete the six cheatsheets. `yo-wasm-integration` becomes a pointer to `yo
  context --doc WASM`.
- **`yo skills install` removes files a bundled `yo-*` skill no longer ships**,
  inside those skill directories only, and journals each removal as `remove`.
  Today it only overwrites, so a user upgrading after this plan would keep the
  stale cheatsheets forever. This is the plan's one code change
  (`src/skills_command.yo`). It needs a cli-case: install an old skill tree,
  reinstall the new one, and expect the removed file gone and other files kept.
- Re-record the `init-*` and `skills-*` goldens: the skill tree is in their
  `expected_tree`.

### K5 — The snippet gate

Add a gate (GATE 8's extractor generalised, or a new GATE 9) that compiles
every ` ```rust ` block in `pack/context.md`, `.github/skills/*/SKILL.md` and
`docs/en-US/*.md`. A block marked as non-compiling (fragment, error example)
opts out with an explicit tag, and the tag form is decided in K5. The gate
runs in `gates_fast.sh` and in CI. Expect K0-style fixes the first time it
runs on the manuals. That size of fix decides whether K5 lands before or
after K4.

### K6 — Rules that point at the old layout

- `AGENTS.md` "update the cheatsheets … immediately" becomes "update the pack,
  the manual, or `.github/instructions/`, whichever is the fact's home (§D2)".
- Fix the references to the removed files: `.github/instructions/` (the
  `yo-syntax` cheatsheet's string-indexing pointer, the `yo-design` "keep …
  cheatsheets in step" lines, the `testing` golden note), `docs/en-US` and
  `zh-CN` `CONTEXT.md`, and `reference/YO_CONTEXT.md` (an addendum linking
  here).

## 5. Exit criteria

1. No rule is stated in two of {pack, skills, manuals}. A spot-check of the
   §2 duplicate sections finds each in exactly one home.
2. `.github/skills/` totals ≤ ~500 lines (from ~4,400), and no skill file
   contains compiler-dev content or a version-specific API listing.
3. Every §2 stale claim is fixed or deleted. The snippet gate is green over
   the pack, the skills and the manuals.
4. The pack stays under 24 KB.
5. Reinstalling the skills in a project that has the old tree leaves no
   cheatsheet behind (K4's cli-case).

## 6. Risks and open questions

- **Translation volume.** K1 adds roughly 400 lines to the manuals, and every
  one needs a zh-CN counterpart. It is the slowest part of the plan, so split
  K1 by manual if one PR gets too large.
- **Does a thin skill trigger as well?** The trigger is the `description`,
  which K4 keeps, so loading behaviour does not change. What changes is that
  the loaded skill sends the agent to `yo context` for depth: one extra tool
  call, in exchange for version-matched answers. Measuring it waits for the
  BEND B4 evals harness, as `YO_CONTEXT.md` exit criterion 3 does.
- **The snippet gate's opt-out tag.** It must not become a way to hide stale
  examples. K5 reports the opt-out count, and a rising count gets questioned
  in review.
