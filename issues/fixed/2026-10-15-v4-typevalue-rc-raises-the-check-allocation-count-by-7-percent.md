# V4's TypeValue as an Rc node raises `check src/main.yo`'s allocation count by 7%

**Severity:** S3. This is a performance regression: the evaluator work ratchet (`scripts/bootstrap/eval_work_ratchet.sh`) failed at +8.0% over its baseline, and the "Evaluator memory ratchet" job stayed red after the RSS leak was fixed.

**Status:** RESOLVED 2026-10-15 by re-baselining `check_src_main_alloc_calls`, because the cost is V4's own (#1369, the maintainer-approved `TypeValue :: Rc(TypeValueNode)` handle). It is not a defect in the evaluator: the evaluator does the same work. What grew is the program that `check src/main.yo` checks, which is the compiler, whose `TypeValue` type got bigger. The attribution follows.

Found 2026-10-15 while fixing `issues/fixed/2026-10-15-an-assignments-old-value-save-by-bytes-is-never-released.md` (#1381). The RSS failure had hidden it: `memory_ratchet.sh` fails first, so no develop battery between 960a3904c and fa8f23fad reached the allocation count.

## Symptom

CI, `check src/main.yo` allocation calls (malloc+calloc+realloc+aligned):

| run | head | allocation calls |
|---|---|---|
| 38559516989 | 57e5c98c3 | 2,781,829,606 (baseline 2,769,331,795) |
| 38642676667 (#1381) | fa8f23fad + the leak fix | 2,991,282,591, FAIL at +8.0% |

## Attribution

All measurements are local, on macOS M4. Every count is exact and repeated runs agree to the call.

### 1. Which commit

A `DYLD_INSERT_LIBRARIES` counter interposes malloc/calloc/realloc/posix_memalign/aligned_alloc. Each compiler checks `src/main.yo` of its own tree; stage 1 is seed-built.

| compiler | malloc + realloc | vs 57e5c98c3 |
|---|---|---|
| stage 1 and stage 2 @ 57e5c98c3 | 2,784,639,943 | — |
| stage 1 @ 23787451b (#1365, #1366, #1367) | 2,788,697,235 | +0.15% |
| stage 1 @ fceb684a1 (#1373, #1339, #1377, #1376; the parent of V4) | 2,799,317,658 | +0.5% |
| stage 1 @ fa8f23fad + #1381 | 2,994,086,443 | +7.5% |
| stage 2 @ fa8f23fad (no leak fix) | 2,993,673,883 | +7.5% |

The step is #1369: +194.8M allocations, +7.0%. The leak fix moves the count by +0.01%.

### 2. Where (call-site census, fceb684a1 vs fa8f23fad)

The interposer walks the frame-pointer chain on every allocation. It skips frames in `src/types/type_key.yo`, `src/types/string.yo`, std and the runtime, and records the first frame outside them as the consumer. Frames are named from seed emissions with `YO_DEBUG_FN_ORIGIN=1` via `scripts/bootstrap/fid_name_map.py`.

| | fceb684a1 | fa8f23fad | delta |
|---|---|---|---|
| all allocations | 2,799,317,821 | 2,994,086,606 | +194,768,785 |
| allocations under `type_key.yo` / `types/string.yo` | 1,116,791,524 | 1,454,024,176 | +337,232,652 |
| …consumer `nominal_declares_move_only` (impl.yo) | 421,432,391 | 575,516,738 | +154,084,347 |
| …consumer `type_lacks_copy_for_flip` (trait_checking.yo) | 320,285,253 | 440,644,884 | +120,359,631 |
| …consumer `value_to_signature_string` (helper.yo) | 220,026,360 | 250,398,510 | +30,372,150 |
| `src/types/hierarchy.yo` + `src/types/intern.yo` (V4's identity memos replaced `type_memo_key`) | 185,771,752 | 70,025,529 | −115,746,223 |

Type-node constructors (`types/creators.yo`, substitution) barely move. The growth is not in node boxes; it is in building type keys. `nominal_declares_move_only` and `type_lacks_copy_for_flip` memoize their answers by `type_key(ty)`, and they compute that key on every call.

### 3. Why the keys cost more: the checked program's TypeValue got bigger

Stage 1 of both trees was built with a throwaway patch that prints every `type_key` result. Totals for one `check src/main.yo`:

| | fceb684a1 | fa8f23fad |
|---|---|---|
| `type_key` calls | 13,079,241 | 13,084,874 |
| distinct keys | 3,490 | 3,467 |
| key bytes built | 2,813,619,761 | 3,269,406,919 (+16%) |
| keys that do not mention the compiler's `TypeValue`: calls / bytes | 12,703,805 / 1,064,561,943 | 12,694,857 / 1,064,755,326 |
| keys that mention it: calls / bytes / average length | 375,436 / 1,749,057,818 / 4,659 | 390,017 / 2,204,651,593 / 5,653 |

- The evaluator makes the same calls and builds byte-identical keys for every type that does not contain the compiler's `TypeValue`.
- The whole +456M key bytes are keys of compiler types that embed `TypeValue` (`ExprInfo`, `Environment`, `Variable`, `ExprInfoTable`, …). V4 turned `TypeValue` from a ref enum into `Rc(TypeValueNode)`, so every occurrence in those keys carries an extra `Rc` layer around the node enum: +21% per key.
- There is no new call path, no memo miss and no clone. This is the direct cost of the V4 handle on the one input this ratchet measures, the compiler's own source.

## Resolution

`check_src_main_alloc_calls` goes from 2,769,331,795 to 2,996,136,722 (+8.2%). That is the count of the develop battery at fc37c4e54 (run 38678330962, both counted runs agreeing to the call). The develop commits after V4 add +0.16% on top of #1381's 2,991,282,591. The value and the reason are recorded in `scripts/bootstrap/memory-ratchet.tsv` and in the `memory-ratchet` job comment of `.github/workflows/test.yml`.

The optimization opportunity stays open; it is not a regression. About 1.0 billion of the ~3.0 billion allocations are key strings built only to look up `g_move_only_memo` and `g_lacks_copy_memo`. Keying those two memos without building a ~5 KB string per call (an identity front cache that is sound for types without unresolved type variables, or a hashed key) would cut the count well below the pre-V4 level. That is a design change for the evaluator-performance plan (`plans/VALUES_BY_DEFAULT.md` §6), not part of this fix.
