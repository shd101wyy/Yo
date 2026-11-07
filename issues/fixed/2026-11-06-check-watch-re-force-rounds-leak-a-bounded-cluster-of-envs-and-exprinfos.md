# A short-circuit move in `require_capture_borrow_exclusivity` leaked an `ExprInfo` per call argument (V5 part B)

**Severity:** S1. Re-triaged 2026-11-07 from S2. This was an unbounded leak in
the compiler's own generated code. Once the compilation had met a capture
borrow, every call argument bound to a non-owning parameter leaked one
`ExprInfo` and the environment snapshot it holds. On `check src/main.yo` that
came to about 857 MB more live memory at exit than develop before V5 part B.
It turned three develop battery jobs red: `check_watch`, the Evaluator
memory ratchet (check RSS +55%) and Compiler build inside 8 GB (peak
+10.96%).

The file name keeps the framing the doc was filed under, so existing
references still resolve. That framing was wrong: the leak was not in
`check --watch` re-force rounds, not in the `ModuleWalk` field cluster and not
in the dup/drop pair optimizer. "How it was found" below shows how each was
ruled out.

## Symptom

The V5 part B gate round found it on 2026-11-06. Two tests in
`tests/internal/check_watch.test.yo` failed the test runner's leak verdict on
the part B stage 1 and passed on develop:

- "Phase 3b: rule D1 re-judges a re-forced body — the reach memo answers only
  for the body it walked" (44,318 B / 677 allocations),
- "Phase 3b: an edit re-judges the edited definition's same-module callers,
  transitively" (43,662 B / 671 allocations).

After part B merged (#1813), develop's battery showed the same leak at full
scale. An A/B on that battery's own binaries (glibc live-at-exit histograms of
`check src/main.yo`) measured 2,451,136,264 B in use at exit against
1,551,037,472 B for the pre-part-B stage 2 on the same tree (RSS 2,663 MB
against 1,734 MB). That is about 15 M more live objects, while allocation
counts grew only about 1.2%: the program kept objects alive that it no longer
used.

## Root cause

`require_capture_borrow_exclusivity` (`src/evaluator/utils.yo`) reads each
argument's `ExprInfo` from the table to decide whether the argument is copied:

```yo ignore
a_info := expr_info_table_get(&ctx.expr_info_table, ast_expr_id(&a));
carries_mut := match(&a_info, .Some(inf) => type_first_mut_borrow(&inf.ty()).is_some(), .None => false);
by_value := match(param_is_owning.get(ai), .Some(o) => o, .None => false);
copied := (by_value && match(a_info, .Some(inf) => …, .None => false));
```

`a_info` is a second handle to the table's `ExprInfo`, which part B made an
`Rc(RefCell(ExprInfoData))`. The second `match` takes it by value, inside the
right operand of `&&`. The compiler treated that move as unconditional: the
emitted C dropped `a_info` only inside the guarded right operand. When
`by_value` was false, the operand was skipped and nothing released the
handle. That compiler bug was already filed for the verifier's instance:
`issues/fixed/2026-11-04-a-move-in-the-right-operand-of-a-short-circuit-operator-leaks-when-the-operand-is-skipped.md`.

Before part B, `ExprInfo` was a `ref` type, so both by-value reads shared the
handle and released it at scope end. The part B migration made it a counted
`Rc` handle. The rc-clone migration then turned the first read into a borrow
(`match(&a_info, …)`) and left the second one as a move inside
`by_value && …`.

The function returns at once unless `capture_borrows_exist()`. That flag is
set the first time the compilation meets a capture-list borrow entry or an
`io.async` future type that carries an origin. Loading `std/thread` sets it;
the `std/sync` modules imported on their own do not. From then on, every call
argument bound to a non-owning parameter leaked its `ExprInfo`, with the
environment snapshot and type tree it holds. Both check_watch witnesses import
`std/thread` in their fixtures, which is why only they failed. The compiler
imports it too, which accounts for the 857 MB.

## How it was found

- **Not watch rounds.** A plain load of `{ Thread } :: import("std/thread")`
  with a trivial `main` (no watch round, no edit) leaked 29,498 B in 461
  allocations. All 55 direct leaks were `ExprInfo` cells; the rest were
  indirect (their snapshots and trees). `std/sync/{mutex,atomic,channel,waitgroup}`,
  imported one at a time, were clean.
- **Not part B's codegen.** develop's pre-part-B compiler building the part B
  source of the same probe leaked identically. The same compiler building
  develop's source was clean. So a source shape that part B introduced was the
  trigger.
- **The exact site.** The probe's emitted C was patched so that each
  `ExprInfo` cell (one RC type id) carried a trailer pointing at its own event
  log: its construction and every `__yo_incr_rc` / `__yo_decr_rc`, each with a
  14-frame frame-pointer backtrace. The logs were allocated under
  `__lsan_disable()`, so they rooted nothing and masked no leak. An `atexit`
  hook ran LeakSanitizer's recoverable check with `report_objects=1` and dumped
  the logs of exactly the leaked cells. All 55 had one unmatched `+1`, and it
  was the same one: `expr_info_table_get` called from
  `require_capture_borrow_exclusivity`. The emitted drop for that handle sat
  inside the `if (by_value)` block of the short circuit.

The census tooling in `scripts/bootstrap/` (`holder_census_t.py`,
`alloc_site_census_t.py --rc-events`) hides a leak of this kind. Its census
table roots every tracked object, so LeakSanitizer reports them all as
reachable. A per-object log that roots nothing is the instrument for an
unmatched increment.

## Fix

Both halves landed in one PR:

1. **The compiler bug.** A move inside an operand that a short circuit can
   skip is now a conditional move: the path that skips the operand drops the
   value (`drop_moves_of_skippable_operand` in the evaluator,
   `_close_short_circuit_if` in `src/codegen/exprs/and_or.yo`; the other doc's
   Fix section has the details). The `Option` local test in
   `tests/short_circuit_drops.test.yo` is this site's shape: it disposes 66
   of 99 values before the fix and all 99 after.
2. **The site.** `require_capture_borrow_exclusivity` reads `a_info` by borrow
   (`match(&a_info, …)`). It only reads the value, and with the borrow a
   compiler built by a seed without (1) does not leak here either. The
   fixpoint's stage 1 is built by exactly such a seed.

## Test

The compiler-level regression tests are the eight moved-operand tests in
`tests/short_circuit_drops.test.yo`. They fail before the fix with exactly the
skip-path shortfall and pass after it.

At compiler scale, a stage 1 built by the seed from this tree (so with the
site fix and without the compiler fix) peaks at 1,895,620 kB on
`check src/main.yo`, against 2,762,104 kB for develop's stage 1 on the same
tree (two runs each, within 0.02%). That is the 866 MB this leak retained.

The two check_watch tests named above are the witnesses. They could not be
rerun with the fix yet: on develop `f89a24b0d` a compiler built from the
tree miscompiles compiler code: every check_watch test dies with the same
heap-use-after-free with or without this change (a #1814 regression, fixed
separately). They and the CI-form memory ratchets are rerun once that fix
lands.
