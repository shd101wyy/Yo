# An executed CTFE clone's metadata outlived the call

**Status: FIXED 2026-09-25** (`plans/archive/BUILD_ON_8GB_MACHINES.md` Phase 2).

## Symptom

`yo compile src/main.yo` peaked at 6.70 GB footprint in its front half (check
+ C generation) against 2.4–2.8 GB for `yo check src/main.yo`. The extra
~4 GB was attributed to "C generation", but the live heap was already
5.7 GB when codegen started.

## Measurement

A local probe build recorded every `expr_info_table_get` during codegen and
the live malloc bytes (`malloc_zone_statistics`) at codegen start and end:

| Point | Table entries | Live heap |
| --- | --- | --- |
| Codegen start | 2,884,449 | 5,695 MB |
| Codegen end | 2,948,949 | 6,348 MB |
| … after dropping the 1,031,502 entries codegen never read | 1,917,447 | 4,230 MB |
| … after clearing the whole table | 0 | 2,693 MB |

A second probe tagged every id minted by `clone_expr_fresh_ids` with its call
site and dropped the unread entries site by site:

| Clone site | Read by codegen | Unread | Freed when the unread are dropped |
| --- | --- | --- | --- |
| CTFE body (`evaluate_comptime_fn_call`) | 886 | 118,918 | **1,563 MB** |
| Call-overload trial (`_trial_call_overload_candidate`) | 2,848 | 286,150 | 176 MB |
| Specialization body | 227,163 | 17,801 | 13 MB |
| everything else | — | 37,434 | 46 MB |

## Root cause

`evaluate_comptime_fn_call` executes a FRESH-ID clone of the function body
for every call that misses the CTFE memo, so the table never overwrites one
call's entries with another's. The call keeps only the resulting value (plus
the callee env and comptime ref read from the body's info). Nothing removed
the clone's entries afterwards. Each one holds the env snapshot of a
compile-time execution, about 13 KB on average.

In `check` each module has its own table, which dies with the module's walk,
so the cost was bounded by the largest module. `compile` shares ONE table
across all modules so codegen can read any function's metadata, which makes
every CTFE execution's metadata live until exit.

## Fix

`purge_executed_clone_metadata` (`src/expr_info.yo`) runs at the end of
`evaluate_comptime_fn_call`, after the value, callee env and comptime ref have
been read. It walks the executed clone and drops the ExprInfo and ExprId-keyed
side-table entries of every node whose id lies in the range the clone minted
(`next_global_expr_id` before and after the clone). A subtree whose root
evaluated to a function is kept, because a method, closure or nested function
defined in the executed body can outlive the call (an instantiated type's
`impl` methods), and codegen emits it from that definition-time metadata.

Verified on `compile src/main.yo`: 268,271 ids purged, **zero** codegen reads
of a purged id (a local detector build), and the emitted C is byte-identical
to the same binary with the purge disabled (146,591,048 bytes). Peak footprint
**6.70 → 5.07 GB**, max RSS 5.66 → 4.41 GB.

The overload-trial clones were NOT purged the same way. They can escape: a
trial that type-checks a generic callee with a cloned closure argument creates
and caches a specialization holding that clone, and codegen reads 2,848 of
those entries.

## Test

`tests/internal/module_invalidation.test.yo`, "CTFE: an executed clone's
metadata does not outlive the call": a document with 1 and with 11 distinct
CTFE calls. The open document's retained table must grow by no more than each
call's own 8 nodes per extra call.
