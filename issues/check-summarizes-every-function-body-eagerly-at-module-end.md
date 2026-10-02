# `check` summarizes every function body eagerly at module end (#1113, `check` +3.6%)

**Severity:** S3. A performance regression: `yo check src/main.yo` got 3.6%
slower (about 4.3 s) when #1113 made `check` summarize each module's function
bodies before the module's ExprInfo table is dropped.

**Found:** 2026-10-02, bisecting why `check src/main.yo` takes ~135 s on
develop when #951 measured 102.8 s. The larger step in that history is
`issues/fixed/substitute-walks-a-shared-type-as-a-tree.md`
(#975, +16%).

#1113 is a correctness fix: without the summaries, Rule D1's reach walk and
StrictBorrow's mutation masks saw other modules' bodies as "never evaluated"
and rejected valid code. The cost is not a bug in the result, only the price
of computing every summary up front.

## Measured

Mac mini (Apple M4), `yo check src/main.yo --std-path ./std`, wall time.
Compilers were built locally with the v0.2.48 seed (the window's
`SEED_VERSION`), each timed on its own tree, two runs each:

| commit | run 1 | run 2 |
| --- | --- | --- |
| `f7a99be43` v0.2.48 | 122.43 s | 120.72 s |
| `6b71f4f0f` #5 (#1094) | 123.42 s | 121.38 s |
| `2d9437775` #10 (#1109) | 123.00 s | 122.04 s |
| `fe7d41dbc` #13 (#1110) | 124.11 s | 122.24 s |
| `cd6ec6f25` #16 (#1093) | 122.32 s | 121.35 s |
| `7d04eb24d` #19 (#1034) | 124.39 s | 123.78 s |
| **`3e4d3d0bb` #20 (#1113)** | **129.44 s** | **127.69 s** |

**The cost is in the compiler, not in the tree #1113 changed.** Both
binaries were timed on both trees:

| | tree `7d04eb24d` | tree `3e4d3d0bb` |
| --- | --- | --- |
| binary `7d04eb24d` | 124.40 / 123.81 s | 124.35 / 123.90 s |
| binary `3e4d3d0bb` | 128.41 / 128.13 s | 128.87 / 128.41 s |

`sample <pid> 115 1` on both binaries checking tree `7d04eb24d`, with
inclusive per-function sample counts. The C symbols are mangled ids; I mapped
them to Yo functions through their prototypes in the build's `yo.c`. All of
the new samples sit in one chain that did not exist before:

| function | samples |
| --- | --- |
| `_summarize_module_bodies` (`src/module_manager.yo`) | 2,881 |
| ↳ `summarize_function_bodies` | 2,823 |
| ↳ the per-body analysis (`src/evaluator/effects/mutation_summary.yo`, `fn(fid, body, table, touched) -> _MspAnalysis`) | 2,633 |
| ↳ its expression walker, `fn(e, ctx) -> unit` | 2,075 |

That is about 2.9 s of the 4.3 s. The rest is spread thin. The biggest pieces
are String-keyed hashing (three `HashMap` hash functions add 478, 420 and 377
samples), which fits the new per-function D1 and mutation-mask memos. That
attribution is reasoned, not measured.

The dispose-thunk rows that differ between the two profiles are an
artifact: thunk ordinals renumber between builds, and their callers are the
ambient substitute and intern paths.

## How to fix

The summaries are computed for every function body of every module. They
are read only by Rule D1's reach walk (thread closures) and by StrictBorrow's
mutation masks.
1. First, measure how many summaries are ever read: count summaries written
   against memo hits and misses in a `check src/main.yo`.
2. If most are never read, summarize only bodies a consumer can reach. That
   means functions a thread closure can call, and methods called inside a
   StrictBorrow loop. Or record just enough per body (the call targets and
   write sites) for the walk to run lazily after the table is gone.
3. Otherwise make the walker cheaper. It walks each body again although the
   evaluator has just walked it; the summary could be accumulated during
   evaluation instead.
4. Gate the fix on #1113's own cli-cases and `tests/internal/check_watch.test.yo`
   staying green, and on timing parity with `7d04eb24d`.
