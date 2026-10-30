# `Rc.clone` calls defeat the mutation-summary memo: `check` re-analyses whole call cycles on every query

**Severity:** S2 — after decision 17 (V2c, #1663), `yo check` of a program that calls `Rc.clone` / `Arc.clone` re-analyses the callers' mutation summaries on every query. `check src/main.yo` made 29% more allocation calls, and the evaluator work ratchet went red on develop.

**Status:** FIXED 2026-10-30 (fix/develop-v2c-alloc-regression). The evaluator work baseline still has to be raised for the residual (below).

## Symptom

develop battery 40905885640 (b8f86ebe2, #1663), job "Evaluator memory ratchet", work step:

```
check src/main.yo: 3528223482 allocation calls; baseline 2699179013, tolerance ±5%
FAIL: evaluator work regression — 3528223482 allocation calls > 2834137963 (baseline 2699179013 + 5%).
```

The parent c39c574be measured 2,741,359,376. Bytes requested went from 147 GB to 452 GB. The RSS run's wall time went from 3:35 to 14:03.

## Attribution

All measurements are local on the Linux box. The binaries are CI's own stage-2 C for both commits (the `bootstrap-stage2` artifacts), recompiled on glibc malloc as the job does. Every binary checks `src/main.yo` with `--std-path ./std`.

| compiler | tree checked | allocation calls |
|---|---|---|
| c39c574be | c39c574be | 2,744,300,771 |
| b8f86ebe2 | b8f86ebe2 | 3,531,141,633 |
| c39c574be | b8f86ebe2 | 3,523,567,672 |
| b8f86ebe2 | c39c574be | rejected with E0901, by design |

The old compiler on the new tree reproduces 99% of the growth. So the clones V2c's repair tool put into the compiler's own code cost about 0.2%. The rest is what the checker does with the new source.

A frame-pointer stack sampler (1 sample per 1009 allocation calls, on line-directive builds) puts the growth in `src/evaluator/effects/mutation_summary.yo`, +625M inclusive. A large share of that is `type_lacks_copy_for_flip`'s `type_mentions_some_type` walk, +199M, reached from the summary's `classify` through `type_contains_rc_type`.

`YO_DEBUG_BORROW_MASK=1` counts the `_MsP.analyze` runs:

| tree | analyses in `check src/main.yo` |
|---|---|
| c39c574be | 35,134 |
| b8f86ebe2 | 226,750 |
| b8f86ebe2, fixed | 35,348 |

Of the 191,616 extra analyses, about 187,000 come from one cycle in `src/pattern.yo`: `clone_patterns` (119,525 analyses, 17 before), `Box(Pattern).clone` (60,569) and `Pattern.clone` (7,574).

## Root cause

V2c spelled `Pattern.clone`'s field copies `Rc.clone(ty)`. The callee is the prelude's `impl(generic(T : Type), Rc(T), Clone(clone : ...(___dup(self))))`, specialized at `Rc(TypeValueNode)`. That specialization's body has no ExprInfo in the table `Pattern.clone` is summarized against, so `_MsP.analyze` takes its "not evaluated yet" branch. That branch returns a conservative `all` mask, is not memoized, and adds the callee to the caller's `touched` list. A caller whose filtered `touched` list is not empty is not memoized either, and neither is its caller.

So every function that calls `Rc.clone`, and every caller above it, was analysed afresh on every query. Inside a recursive cycle such as `Pattern.clone` → `clone_patterns` → `Pattern.clone`, each fresh analysis re-walks the cycle once per call site and once per fixpoint iteration. Before decision 17 the same copy was an implicit `ty`, which is no call, so nothing was poisoned.

A bisection on `check src/pattern.yo` with the c39c574be compiler confirms it. Putting back plain `ty` for the five `Rc.clone(...)` arms of `Pattern.clone` drops `clone_patterns` from 144 analyses to 16. Keeping just one of them brings back all 144.

The conservative answer was also a precision loss. Every `Rc.clone` call counted as possibly writing through every argument.

## Fix

- `src/evaluator/effects/mutation_summary.yo`: `_ms_body_dups_first_param` recognizes a body that is exactly `___dup(<first parameter>)`. That is the shape of `Rc`'s and `Arc`'s `Clone.clone`. `_MsP.analyze` answers it directly: an empty mask, and a result rooted at parameter 0, the same answer the walk gives when the body has ExprInfo (`___dup` is a pass-through head). `_MsW.summary_for` answers "mutates nothing" for it. Neither needs the body's ExprInfo, so neither poisons a caller's memo.
- `src/evaluator/trait_checking.yo`: `type_lacks_copy_for_flip` asks `!type_identity_cacheable(&ty)` instead of walking `type_mentions_some_type(&ty)` on every call. The two answers are identical, because `type_identity_cacheable` is that walk remembered per type identity and type-key epoch.

Neither change touches E0901 or any other diagnostic.

## Result

Measured locally by CI's method: the tree-built stage 1 emits the stage-2 C, which clang -O2 recompiles on glibc malloc, and `eval_work_ratchet.sh` counts it. That method reproduces CI's count within +0.1%.

| head | without the fix | with the fix |
|---|---|---|
| b8f86ebe2 (#1663) | 3,531,141,633 (CI 3,528,223,482) | — |
| 4db9a0c8a | — | 2,864,840,044 |
| 92efeee86 | 3,543,916,554 | 2,952,217,454 |
| 0ce055183 | 3,608,981,606 | 2,928,830,929 |

On 0ce055183 the fix removes 680.2M of V2c's 786.9M. The remaining +229.7M over the 2,699,179,013 baseline (+8.5%) breaks down as follows:

- about +106.6M is V2c's own cost: the checker now evaluates about 2,100 `Rc.clone(h)` calls, each a static method call on a generic type, where it used to read a bare name;
- about +77.8M comes from develop #1664–#1677, measured unfixed from b8f86ebe2 to 0ce055183; about 64M of that is #1675's allocator v2;
- the rest was already over the baseline at c39c574be (2,741,359,376 on CI, +1.6%).

`check src/main.yo` max RSS on the mimalloc stage-2 binary does not move: 1,290,692 kB without the fix and 1,290,548 kB with it on 92efeee86, and 1,283,040 kB with it on 0ce055183. Wall time on 92efeee86 drops from 8:35 to 5:19 on the shared box.

## Test

`tests/internal/mutation_summary.test.yo` analyses a `___dup(self)` body against an empty ExprInfoTable, which is the situation of a caller summarized in another module's table. Before the fix the mask is `all`; after it the mask is empty. Two more cases check that the shortcut stays exact: `___dup(<second parameter>)` and `___drop(self)` keep the conservative answer.
