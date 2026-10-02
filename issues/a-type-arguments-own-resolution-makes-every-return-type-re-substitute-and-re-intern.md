# A type argument's own resolution makes every return type re-substitute and re-intern (#975, `check` +16%)

**Severity:** S3. A performance regression: `yo check src/main.yo` got 16%
slower in one commit, and every `check` and `compile` of generic code pays
it. On develop the same path is about 18 s of a 135 s check.

**Found:** 2026-10-02, bisecting why `check src/main.yo` takes ~135 s on
develop when #951 measured 102.8 s on the same Mac mini.

## Measured: the bisect

Mac mini (Apple M4). Each row is `yo check src/main.yo --std-path ./std` run
inside that commit's own tree, wall time, two runs each.

Release binaries (`yo version install`), each on its own tag:

| release | run 1 | run 2 |
| --- | --- | --- |
| v0.2.45 | 96.58 s | 96.12 s |
| v0.2.46 | 96.66 s | 96.63 s |
| v0.2.47 | 118.75 s | 118.11 s |
| v0.2.48 | 119.39 s | 119.21 s |

So the v0.2.46 → v0.2.47 window holds the jump. A compiler built locally from
each commit (`~/.cache/yo/versions/0.2.46/bin/yo build`, the window's
`SEED_VERSION`) reads ~3% slower than the published binary at both ends
(v0.2.46: 100.8 / 99.5 s; v0.2.47: 123.1 / 121.5 s). The offset is the same at
both ends, so local builds compare with each other. Bisecting the window's
37 `src/`/`std/` commits:

| commit | run 1 | run 2 |
| --- | --- | --- |
| `61eecc494` v0.2.46 | 100.81 s | 99.49 s |
| `98d5e0115` #1 safe mode 5b P1 | 98.95 s | 97.95 s |
| `4bd505d76` #2 macOS async (#988) | 99.58 s | 97.91 s |
| **`f5cb7a766` #3 (#975)** | **115.59 s** | **114.20 s** |
| `46f1855b0` #4 (#1022) | 115.06 s | 114.24 s |
| `690b97599` #5 (#997) | 117.61 s | 115.64 s |
| `26e49ee1f` #10 | 116.25 s | 114.99 s |
| `55c79c51e` #14 | 118.55 s | 117.05 s |
| `60647abf6` #19 | 120.39 s | 118.68 s |
| `ac41de657` v0.2.47 | 123.12 s | 121.46 s |

#975 ("Type-system soundness Phase 3 step 7 part 2: retire the id-keyed SomeT
registry") is the only step above noise. The rest of the window drifts by
about +6% over 33 commits, which no single commit owns.

**The cost is in the compiler, not in #975's own source changes.** Both
binaries were timed on both trees:

| | tree `4bd505d76` | tree `f5cb7a766` |
| --- | --- | --- |
| binary `4bd505d76` | 98.54 / 98.16 s | 97.94 / 97.69 s |
| binary `f5cb7a766` | 114.26 / 114.26 s | 114.35 / 114.03 s |

## Measured: where the time goes

`sample <pid> 85 1` on both binaries checking tree `4bd505d76`. I computed
inclusive per-function sample counts from the call tree (each stack is counted
once per function). The C symbols are mangled ids; I mapped them to Yo
functions through their prototypes in the build's emitted `yo.c`.

| function | before | after | delta |
| --- | --- | --- | --- |
| `evaluate_function_return_type_again` | 475 | 14,098 | +13,623 |
| `_substitute_at` (calls beneath the above) | 0 | 13,741 | |
| `intern_type` (beneath the above) | | 12,639 | |
| `_intern_key_into` + its wrapper (beneath the above) | | 9,565 | |

So the time is not spent substituting. Every substituted result goes through
`intern_type`, and `intern_type` renders a full structural string key for it
(`src/types/intern.yo`, `_intern_key_into`). Those keys go into String-keyed
`HashMap`s, and both hashing and formatting costs rise:
- the two hash functions each about double (1,145 → 2,400 and 1,070 → 2,333
  self samples);
- `__vfprintf`, which wasn't in the old profile's top 30, has 758 self
  samples in the new one.

On develop (`235cf09ac`, `sample` for 120 s of a 135 s check), the same function
is 18,290 inclusive samples, with `substitute` 17,808 of them and interning
about 16,561. That is roughly 13% of the whole check.

## The mechanism (code read; the profile above locates it)

`evaluate_function_return_type_again` ends in `_resolve_type_arg_somes(rr_out,
callee_env)` (`src/evaluator/types/function.yo`). That function collects the
SomeTs among the return type's type arguments. It then binds each one either:
- by name (`subst_add`), when the env answered with a concrete type; or
- by identity (`subst_adopt_own_resolution`), when the answer is the SomeT's
  own `resolution`.

It calls `substitute(tas_s, ty)` when anything was bound.

Before #975 the second channel was the id-keyed registry
`lookup_some_resolved_concrete`, and a SomeT reached it only when the
registry had an entry. #975 moved every registry writer onto the value
(`SomeT.resolution`), so most type-argument SomeTs now carry one. As a result:
- `tas_bound_any` is true on most calls;
- every generic call's return type is substituted;
- the result is interned, and `_intern_key_into` renders each SomeT's
  `resolution` too (the `smrcp` arm), so the keys are longer than before.

## How to fix

1. An adopted own resolution depends only on the SomeT, not on `callee_env`.
   When every binding in a call is an own-resolution adoption, the result is a
   function of `ty` alone and can be memoized per interned `ty`. Measure first
   how many `_resolve_type_arg_somes` calls bind only own resolutions, and how
   many of their `substitute` results are the input unchanged.
2. Separately, skip `intern_type` when `substitute` rebuilt nothing (the
   result is the input value).
3. Gate on byte identity of develop's own `src/main.yo` emit (same
   `--std-path` for both binaries; type keys embed the std path), then on
   timing: `check src/main.yo` before and after, interleaved.

Related: `issues/enum-type-arguments-made-check-about-4-percent-slower.md`
(#1112, the same check on develop, +4.4%; that doc lands with #1121).
