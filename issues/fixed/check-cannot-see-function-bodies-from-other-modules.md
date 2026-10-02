# `yo check` cannot see function bodies from other modules, so body-walking rules reject valid code

**Severity:** S2 — `check` rejects valid programs that `compile` accepts: a thread closure calling an imported function fails E0906, and a `pragma(Pragma.StrictBorrow)` loop calling a read-only method is rejected

**Status:** FIXED 2026-10-01 on `fix/check-foreign-bodies`: each module's bodies are summarized
while its table is alive (§ Fix below). Regression tests: the cli-cases
`check-send-closure-calls-an-imported-function` and `check-strict-borrow-loop-calls-a-read-only-method`
(both rc=0 now; red before with the develop-built compiler, rc=1), the soundness cases the fix
had to keep (§ Soundness), `tests/internal/check_watch.test.yo` "rule D1 re-judges a re-forced
body", and the B2 plateau in `tests/internal/module_invalidation.test.yo`. The five census files
below pass `check --test-bodies` and run green.
**Found:** 2026-09-29, the `yo check --test-bodies` census (`plans/TYPE_SYSTEM_SOUNDNESS_HANDOVER.md`
§3.3, site #8): `tests/thread_pool.test.yo`, `tests/sync/channel.test.yo`, `tests/sync/once.test.yo`
and `tests/imm_threading.test.yo` fail strict with E0906. The same error fires for an ordinary
function under plain `check`, so this is not specific to test bodies.

## Symptom (measured, the Phase 3 step 7 branch; develop behaves the same)

```rust
{ assert } :: import("std/assert");
{ ThreadPool, spawn } :: import("std/thread");
{ AtomicI32, MemoryOrder } :: import("std/sync/atomic");
main :: (fn() -> unit)({
  pool := ThreadPool.new(usize(2));
  value := 42;
  seen := AtomicI32(i32(0));
  spawn(pool, io => {
    assert(value == 42, "visible");
    seen.store(value, MemoryOrder.Release);
    ()
  });
  pool.join_all();
});
export(main);
```

```
$ yo check main.yo
error[E0906]: This closure runs on another thread (it is bound to a Send closure type) but calls
'assert', which has a body that was never evaluated (a forward reference?) — …
$ yo compile main.yo --optimize 2 -o a.out     # rc=0, and the program runs
```

The same closure calling `println` passes `check` (std/fmt is an audited file, so the walk trusts
it without looking at the body). Calling `assert` once before the spawn does not help.

## Second symptom: StrictBorrow (measured)

`tests/for_macro_borrow_strict.test.yo` fails strict. The same shape in an ordinary function fails
plain `check` and passes `compile`, which runs and prints `1`:

```rust
pragma(Pragma.StrictBorrow);
Bag :: ref(struct(items : ArrayList(i32)));
impl(Bag,
  iter : (fn(self : Self) -> ArrayListIterPtr(i32))(self.items.iter()),
  total : (fn(self : Self) -> i32)({ t := i32(0); for(self.items, x => { t = (t + x); }); t }));
main :: (fn() -> unit)({
  bag := Bag(items : xs);
  for(bag, inout(x) => { seen = (seen + bag.total()); });   // check: "may mutate … borrowed by this loop"
});
```

`total` is read-only, but its per-parameter mutation mask is built by walking the bodies it
calls: std's iterator methods, whose ExprInfo is in another module's table under `check`.

## Root cause

Both are walks over a callee's evaluated body. Rule D1's reach walk (`function_reaches_non_send_global`,
`src/evaluator/effects/mutation_summary.yo`) descends into each callee's body and judges it
"never evaluated" when the body has no ExprInfo in the walk's table:

```rust
if(expr_info_table_get(table, ast_expr_id(body)).is_none(), {
  return(Option(String).Some(String.from("has a body that was never evaluated …")));
});
```

The walk looks in the CALLER's table. `compile` routes every module's metadata into one shared
table (`g_shared_expr_info_table`, `src/module_manager.yo`), but `check` and `test` give each
module its own throwaway table (so a one-shot `check ./src` can release a finished module's
context). Under `check`, a callee defined in another module (here `assert`'s specialization,
evaluated in `std/assert.yo`'s table) is therefore always "never evaluated".

## Fix direction

Retaining foreign tables would give `check` compile-sized memory. Instead, compute each function's
summaries while its own module's table is alive: for D1, the non-Send globals its body reaches
directly and the callee fids it calls; for StrictBorrow, the mutation mask (`g_msp_by_fid`). The
walks then compose summaries across fids instead of re-walking a body from another module's
table. Whatever the mechanism, `check` and `compile` must give the same verdict.

## Fix

`check` keeps per-module tables. While a module's table is still alive, the loader hands
`summarize_function_bodies` (`src/evaluator/effects/mutation_summary.yo`) every function whose
body was evaluated into it, and the D1 reach verdict and the StrictBorrow mutation mask are
computed for each. Both are memoized by function id, which is all a later module's walk
consults, so the walk no longer needs the foreign table.

"Every function whose body was evaluated into it" is three lists (`_summarize_module_bodies`,
`src/module_manager.yo`):

- the module's definitions: its finished walk's `PendingDef`s (`::` functions are compile-time
  bindings, so `Variable.is_module_level` — "runtime global" — does not find them; the first WIP
  of this fix filtered on it and summarized nothing);
- the impl members it registered (`type_trait_method_values_owned_by`; owner `""` for the prelude);
- the specializations its evaluation minted (`specialization_recording_begin` / `_take`,
  `src/evaluator/calls/helper.yo`). A generic body is evaluated per specialization, in the
  table of the module whose evaluation minted it, and the specialization cache hands it to every
  later caller: `assert`'s `str` specialization is minted by whichever module asserts first.

The summary runs at the end of every demand load, of the prelude (`mm_load_prelude_file`: its
operators and loop machinery are what `bag.total()`'s `+` and `for` resolve to — summarizing only
demand-loaded modules left the StrictBorrow program rejected), and of every `check` entry (a
directory check's later files get the specializations an earlier entry minted from the cache).
A per-definition `--watch` / LSP round re-summarizes the definitions it re-forces against the
module's retained context. `compile` and `test` share one table and never summarize.

## Soundness

A summary taken at module end answers questions asked later. Three ways that could accept a
program `compile` rejects were found and closed:

1. **Call cycles.** The D1 walk answered a recursive call to an in-progress function "clean" and
   memoized the caller's verdict anyway. With `f → h → f`, summarizing `f` first memoized `h` as
   clean, and a thread closure calling `h` passed although `h` reaches `f`'s non-Send global.
   This was already reachable without the summary (a non-Send closure walked first), in `compile`
   too: `issues/fixed/d1-reach-memo-caches-a-verdict-taken-inside-a-call-cycle.md`.
2. **A write after the memo.** D1's mutable-static half (a Send global written by one thread and
   read by another) was judged when the walk ran, and the summary walks every function at its
   module's end: any write recorded after that would have met a "clean" memo. (In the
   cross-module cli-case the generic `bump`'s definition-time trial records its write before the
   summary, so that case is rejected through the walk; the order itself is measured on the
   single-module shape.) Already reachable without the summary, in `compile` too:
   `issues/fixed/d1-thread-reach-misses-a-write-recorded-after-a-memoized-walk.md`.
3. **A re-evaluated body under the same id.** Definition ids are `stable_func_id(module, row,
   column)`, so a body `--watch` / the LSP re-forces keeps its id, and every memo in
   `mutation_summary.yo` (whose comment claimed ids are unique for the life of the process)
   answered for the new body with the old body's verdict:
   `issues/fixed/mutation-summary-memos-answer-for-a-re-evaluated-body.md`.

What stays conservative, by design: a body with no ExprInfo in the summarizing table (a generic
original, a body minted under a trial whose metadata was purged) is not summarized, and a walk
that later reaches it reports it as before ("never evaluated" for D1, `all` for the mask). A
callee not yet evaluated when a body is summarized leaves the mask unmemoized and the D1 verdict a
rejection.

Probed after the fix (check and compile agree on every one; the develop-built compiler rejected
all four invalid ones only as "never evaluated" and the valid one too): a lazy `::` callee
defined after its caller in an imported module (`f → g`, `g` reads a non-Send global) is
rejected through `g`; a generic body whose specialization an imported module minted first and
the entry reuses from the specialization cache is rejected through `gen`; the same
specialization reached only through an imported non-generic wrapper is rejected through
`wrap → gen`; an imported impl member reading a non-Send global is rejected; and the Send
counterpart (a generic reading a read-only `i32` global, an impl member building a local
`ArrayList`) passes. Mutually importing modules were not probed further: a destructuring import
across an import cycle fails E0403 on both compilers (the documented in-progress-module behaviour,
`plans/reference/LAZY_TOPLEVEL_BINDINGS.md`), so no such program reaches the walk.

## Cost

`check ./src --std-path ./std`, 278/278 files, `/usr/bin/time -v` on this Linux x86_64 box
(shared with other sessions, so wall times are noisy): the compiler built from develop
`5567a7796` against this branch's build of the same base, run side by side, 12:42 / 911,164 KB
→ 13:06 / 963,736 KB peak RSS (+5.8 % RSS); run alone at different times, 8:14 / 910,508 KB →
6:52 / 964,328 KB. After rebasing onto `a424a4b4a`: 8:23 / 969,584 KB (load average ~12).
`check ./std`: 177/177, 1:07 / 292,084 KB. The memos are a few entries per function and live for
the process; the `--watch` / LSP plateau test counts them.

## Test

`tests/cli-cases`: `check-send-closure-calls-an-imported-function`,
`check-strict-borrow-loop-calls-a-read-only-method` (the two programs above, rc=0),
`check-send-closure-reaches-an-imported-global-through-a-call-cycle-rejected` and
`check-send-closure-reads-an-imported-global-written-earlier-rejected` and
`check-send-closure-reaches-an-imported-global-through-a-cached-specialization-rejected` (what the
summary must not accept; the last is the reused-specialization probe above), plus the watch test. Red before: scored against the compiler built from develop
`5567a7796`, all four GOLDEN-DIFF / NO-GOLDEN (the two valid programs rc=1 E0906 / "Strict
borrow", the two invalid ones rejected only as "never evaluated"); the cached-specialization
case, added after the rebase onto `a424a4b4a`, is NO-GOLDEN against that compiler too (rejected
only as "never evaluated").
