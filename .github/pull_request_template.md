## Summary

<!-- What changes and why. Link the issues/, plans/ or PR it follows up on. -->

## Verification

<!-- What you actually ran, including anything that failed or was skipped —
     see "LLM and AI-agent contributions" in CONTRIBUTING.md. -->

- [ ] `yo check ./src --std-path ./std`
- [ ] `yo check ./std --std-path ./std`
- [ ] Tests covering the change (`yo test <file> --parallel 1`; `tests/internal` one file per invocation)
- [ ] `yo fmt` on every modified `.yo` file
- [ ] New/changed behavior has a test that failed before and passes after; bugs carry an `issues/` entry with a `**Severity:**` verdict
- [ ] Docs updated in both `docs/en-US/` and `docs/zh-CN/`
- [ ] If this PR lands a plan phase, it updates that plan's status/Progress header (`plans/VALUES_BY_DEFAULT.md`'s "Landed" / "In progress" lines) in the same PR

## LLM attribution

<!-- If an LLM helped produce this change, please name it. -->

- Model:
- Agent harness (optional):

## Deferred

<!-- Anything intentionally NOT done in this PR, and why (e.g. parked until a
     seed release carries a feature). -->
