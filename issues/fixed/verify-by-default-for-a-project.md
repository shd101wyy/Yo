# Should a project be able to arm every file as a verify target, instead of the per-entry pragma?

**Kind:** design question — decided. Filed 2026-09-30 by the ATS-style
indexed types audit (`plans/backlog/ATS_STYLE_INDEXED_TYPES.md` §5 Q1).

**Verdict (2026-09-30, maintainer: "do what you suggest"):** the
recommendation below. No `check` switch; a verification build step landed the
same day — `__yo_build_verify(name, root, mode, strict)` + `StepKind.Verification`
(Generation A; the `build.verify({...})` wrapper is seed-gated, see
`plans/backlog/SEED_VERSION_AUTOMATION.md`). Docs: `docs/*/BUILD_SYSTEM.md`
§ Verification steps. Test: cli-case `build-verify-dry-run`,
`tests/internal/build_runner.test.yo`.

## The question

In ATS, index constraints are discharged as part of type checking: every
compile proves them, nothing is opt-in. Yo's verifier is opt-in three times
over (`plans/backlog/ATS_STYLE_INDEXED_TYPES.md` §2.2, measured):

- `yo check` and `yo compile` verify **only the entry file**, and only when it
  carries `pragma(Pragma.Verify)` or `pragma(Pragma.VerifyOrAssert)`;
  imported modules are never targets, whatever their pragma.
- `yo test` compiles its batches with `--no-verify`.
- `yo verify <path>` verifies every file under the path, but nothing runs it
  unless the user or CI does.

So a project that annotates `std`-style `assumed()` contracts on its
collections gets them *checked at call sites* only in the files that opt in,
one entry file at a time. Is that the intended steady state, or should a
project-level switch (`yo.toml`, or a `build.yo` step) arm every root?

## Recommendation

**No new switch for `check`; yes as a build step.**

- `check` must stay solver-free: Z3 is a downloaded binary, `check` ships
  nothing, and since #760 a missing solver is a skip-with-hint there. Making
  `check` prove things by project setting would turn the fastest gate in the
  loop into one that depends on a 100 MB download and a per-query process
  spawn.
- A project that wants "every compile proves my contracts" should say so in
  `build.yo`: a `verify` step over the project's roots, next to `test`, run
  by `yo build verify` and by CI — which is what `yo verify <dir>` already
  does, minus the build-step wiring. That keeps the policy where the project's
  other policies live and needs no evaluator change.
- Leave the per-file pragma as the fine-grained control (mode per file:
  `Verify` vs `VerifyOrAssert`).

If the maintainer prefers the ATS experience for `compile` (not `check`), the
smallest change is a `--verify-imports` flag on `yo compile` that arms the
import closure of the entry file; `plans/backlog/SAFE_MODE_5B_VERIFIED_GUARD_ELISION.md`
Phase 3 ("imported verified modules") needs the same closure and should own it.
