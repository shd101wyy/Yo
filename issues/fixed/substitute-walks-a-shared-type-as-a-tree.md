# `substitute` walks a shared type as a tree (#975 made it reachable, `check` +16%)

**Severity:** S3. A performance regression: `yo check src/main.yo` got 16%
slower in one commit (#975), and the walk behind it cost every `check` and
`compile`. Fixed: `check src/main.yo` 135.3 → 99.2 s, the `src/main.yo` C emit
220.3 → 183.9 s, peak RSS unchanged, emitted C byte-identical.

**Found:** 2026-10-02, bisecting why `check src/main.yo` takes ~135 s on
develop when #951 measured 102.8 s on the same Mac mini.

**Correction (2026-10-03).** The first version of this doc, filed as
`a-type-arguments-own-resolution-makes-every-return-type-re-substitute-and-re-intern.md`,
blamed "most generic return types" being substituted in
`_resolve_type_arg_somes`. That was a code read, and it was wrong. Counters
show the function substitutes 4 times in a whole `check src/main.yo` (below).
Its profile table had a second error: it compared one mangled id across two
builds, and ids are position-derived, so #975's edit to `function.yo` renamed
the function. Its "475 samples before" belonged to another function. The bisect
and the matrix stand; the mechanism below was measured.

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

Profiles: `sample <pid> 100 1` of compilers built from `4bd505d76` and `f5cb7a766`,
both checking tree `4bd505d76`. Inclusive per-function samples, with each
function matched across the two builds by its prototype, type ids blanked
(the mangled ids differ between builds):

| function | before #975 | with #975 |
| --- | --- | --- |
| `evaluate_function_return_type_again` | 592 | 13,206 |
| `_substitute_at` (whole run) | 10,738 | 23,255 |
| `_intern_key_into`'s wrapper (whole run) | 7,725 | 16,420 |

Counters in a develop build (`check src/main.yo` on develop's tree), with
`intern_type` charging each call and its key bytes to the active call site:

| site | `intern_type` calls | key bytes |
| --- | --- | --- |
| `_resolve_type_arg_somes` | 17,084,324 | 3.02 GB |
| `_resolve_some_types_deep` (both substitute sites) | 18,735 | 19 MB |
| everything else in the run | 12,896,941 | 2.60 GB |

`_resolve_type_arg_somes` was called 460,000 times. 99.6% found no
type-argument SomeT, and 4 ended in `substitute`, all on the own-resolution
path #975 added (`subst_adopt_own_resolution`). Two of those four did all the
work: each substituted one type, with an intern key of ~36 KB, through
**4,457,362** `intern_type` calls.

## Cause

A TypeValue is a shared DAG. A struct's field types are references, and two
fields, or two levels, routinely hold the same node. `_substitute_at` walked
it as a tree: every path to a shared node re-substituted it and re-interned
the result. The intern key renders each named type once per key, so a key
stays small (36 KB here) while the walk is exponential in the sharing depth.

Before #975 nothing substituted these types. #975 moved SomeT resolutions
onto the value and made `_resolve_type_arg_somes` adopt a type argument's own
resolution, which reached two closure types in `src/evaluator/async/await_analysis.yo`
and `src/evaluator/values/anonymous_function.yo` whose capture structs share
their field types deeply.

## Fix

`_substitute_at` memoizes struct and enum nodes per walk, by identity: a
sorted array of the visited nodes' addresses (`__yo_ptr_lt` binary search,
`__yo_ptr_eq` hit test), with their results alongside, on the `Substitution`
object. A masked or length-stripped copy of the substitution (`_mask_func_own_binders`,
`_without_len_vars`) starts its own memo, since it can answer differently.
`_without_len_vars` already returns the same object when there is nothing to
drop, so the memo is shared down the nominal spine.

Measured on the two calls: 4,457,362 → 448 `intern_type` calls each.

| | before | after |
| --- | --- | --- |
| `check src/main.yo` | 135.59 / 135.07 s | 99.72 / 98.69 s |
| `compile src/main.yo --emit-c --skip-c-compiler` | 220.27 s | 183.88 s |
| peak RSS (`check`) | 1,078 MB | 1,077–1,084 MB |
| emitted C for `src/main.yo` | | byte-identical (`cmp`) |

A trait's recursion guard (`visited_trait_ids`) is path-dependent: a second
visit returns the TraitT unchanged. A memo hit replays the first visit's
result, so the memo could in principle change an output. The byte-identical
self-emit says it does not change any type the compiler's own source reaches.

Regression test: `tests/internal/types_compound.test.yo` "substitute: a
shared struct DAG is substituted once per node" (40 levels, each holding the
level below in two fields). Without the fix it was still running at the 180 s
limit; with it, the test passes in 12 s, nearly all of it compiling.
