# `yo init` scaffolds agent files: bundled skills + AGENTS.md + CLAUDE.md

**Status:** LANDED 2026-09-06 (branch `feat/init-agent-files`).

## Decision

`yo init` ends with an agent-scaffolding step (new `install_agent_files`,
`src/init.yo`), opt-out via `--no-skills`:

1. **Install the bundled skill files** into the new project, reusing
   `install_skills_into` (`src/skills_command.yo`) — the exact copy core
   `yo skills install` uses, so the two commands can never drift: copy into
   every agent config dir that already exists (`.github`, `.agents`,
   `.claude`, `.opencode`, `.openai`, `.cursor`); a fresh project has none,
   so it defaults to `.agents/skills/` (the TS-era default). Existing skill
   files are overwritten (they are tool-managed, version-matched copies);
   the create/overwrite journal and summary line are shared verbatim.
2. **Write `AGENTS.md`** (skip-if-exists, like every scaffolded file):
   generated from the install result, never a hardcoded list — the location
   sentence is built from the actual target dirs and the bullet list carries
   each skill's name plus the `description:` line parsed from its SKILL.md
   frontmatter (`_skill_description`, scoped to the YAML frontmatter). An
   AGENTS.md that promises skills which are not installed would be a lie, so
   the file is skipped when the install produced nothing.
3. **Write `CLAUDE.md`** (skip-if-exists): the single line `@AGENTS.md` — the
   same convention this repository's own root uses, so Claude Code reads the
   same guidance without a second copy to keep in sync.

## Non-negotiables

- **Best-effort, never fatal.** `yo skills install` exits 1 when the bundled
  `.github/skills` dir cannot be located (packaging problem). `yo init` must
  not inherit that failure mode — a missing skills dir only prints a note and
  the scaffold still succeeds. `install_skills_into` returns
  `Option(SkillsInstallResult)`; `.None` means "not found", and the two
  callers choose fatal (skills) vs note (init).
- **Skip-if-exists for agent-authored files.** AGENTS.md/CLAUDE.md are the
  user's documents the moment they exist; init never rewrites them (same
  semantics as the rest of the scaffold). The skill FILES keep the
  overwrite behavior — they are tool-managed.
- **`init_project` resolves to the project dir.** The scaffolding runs in
  `run_init` (sync context, after the scaffold future resolves) so it can use
  blocking awaits exactly like `run_skills_install`; that required
  `init_project` to return the resolved `Path` instead of `unit`.

## Mechanics recorded for posterity

- `SkillEntry(name, description)` / `SkillsInstallResult(skills, targets,
  created, overwritten)` live in `src/skills_command.yo`; the module-global
  journal counters were replaced by a `SkillCopyCounters` ref threaded
  through the copy helpers, so each caller reports its own run.
- CLI goldens: `tests/cli-cases/init`, `init-cwd`, `init-existing`,
  `init-build-test` were re-recorded (the harness pins stdout + full-tree
  sha256, and the trees now include `.agents/skills/**` with hashes of the
  bundled skill files — the same coupling `skills-install` already had);
  `init-no-skills` is a new case pinning the opt-out.
- Docs updated: `README.md` (quick-start tree + skills section),
  `docs/en-US/BUILD_SYSTEM.md` + `docs/zh-CN/BUILD_SYSTEM.md` (project
  structure + `yo init` reference), and the `help init` page in `src/main.yo`
  (en + zh). The general help line (`yo init [dir] [options]`) is unchanged —
  `[options]` already covers the new flag.
