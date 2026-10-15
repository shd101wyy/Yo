# V4's TypeValue as an Rc node raises `check src/main.yo`'s allocation count by 7%

**Severity:** S3. This is a performance regression: the evaluator work ratchet (`scripts/bootstrap/eval_work_ratchet.sh`) fails at +8.0% over its baseline, and the "Evaluator memory ratchet" job stays red even with the RSS leak fixed.

Found 2026-10-15 while fixing `issues/fixed/2026-10-15-an-assignments-old-value-save-by-bytes-is-never-released.md` (#1381). The RSS failure had hidden it: `memory_ratchet.sh` fails first, so no develop battery between 960a3904c and fa8f23fad reached the allocation count.

## Symptom

CI, `check src/main.yo` allocation calls (malloc+calloc+realloc+aligned):

| run | head | allocation calls |
|---|---|---|
| 38559516989 | 57e5c98c3 | 2,781,829,606 (baseline 2,769,331,795) |
| 38642676667 (#1381) | fa8f23fad + the leak fix | 2,991,282,591, FAIL at +8.0% |

## Attribution

Local measurement on macOS M4. A `DYLD_INSERT_LIBRARIES` counter interposes malloc/calloc/realloc/posix_memalign/aligned_alloc; the count is exact across repeated runs. Each binary checks `src/main.yo` of its own tree. Stage 1 is seed-built, so these points reflect evaluator logic; stage 2 adds the tree's own codegen.

| compiler | malloc + realloc | vs 57e5c98c3 |
|---|---|---|
| stage 1 and stage 2 @ 57e5c98c3 | 2,784,639,943 | — |
| stage 1 @ 23787451b (#1365, #1366, #1367) | 2,788,697,235 | +0.15% |
| stage 1 @ fceb684a1 (#1373, #1339, #1377, #1376; the parent of V4) | 2,799,317,658 | +0.5% |
| stage 1 @ fa8f23fad + #1381 | 2,994,086,443 | +7.5% |
| stage 2 @ fa8f23fad (no leak fix) | 2,993,673,883 | +7.5% |
| stage 2 @ fa8f23fad + #1381 | 2,994,086,443 | +7.5% |

The step is fa8f23fad, #1369 (VBD V4: `TypeValue :: Rc(TypeValueNode)`, identity memos, enum-finals map, hashed long names): +195M allocations, +7.0%. The leak fix changes the allocation count by +0.01% (it restores ~13.6M frees).

## Open question

Is this V4's deliberate cost? Every `TypeValue` construction now allocates its node. V4's battery could not answer, because its RSS gate was already red from the leak.

## Recommendation

Do not raise `check_src_main_alloc_calls` without that answer. The V4 owner should attribute the 195M extra allocations with `alloc_site_census_t.py` (label `TypeValue`, or the node type) and the `--rc-events` tooling. The question is how many come from node construction on paths that previously built a `TypeValue` by value without allocating, such as temporary types in compatibility checks and resolved-type copies. If those can be avoided, by interning or by reusing a shared node for leaf types, fix that. Otherwise record the new baseline in a PR that states the cost and the reason, as `memory-ratchet.tsv` requires.
