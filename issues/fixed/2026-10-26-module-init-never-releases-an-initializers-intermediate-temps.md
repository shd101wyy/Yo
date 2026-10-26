# A module-level initializer's intermediate temps are never released — every compiled program that materializes one leaks for its lifetime

**Severity:** S2 — the develop battery's `Formal verification (pinned Z3)` job is red on two
consecutive tips (40261184520 on af67fdf59, 40281614774 on 33d2c48bf, both in the FV job's
"Verifier unit tests (real solver)" step) because `tests/internal/verifier.test.yo`'s batch
binary leaks 18 Strings under LeakSanitizer; the same gap leaks in every program whose
module-level initializers materialize call-argument temps.

## Symptom

```
✗ encode_sort: bool and bitvector spellings
  Memory leak detected:
  ==3264==ERROR: LeakSanitizer: detected memory leaks
  Direct leak of 40 byte(s) in 1 object(s) allocated from:
      #3 __yo_new___yo_t_<String header>
      #4 <ArrayList(u8).with_capacity generic>
      #5 <String from-slice>  ← #6 <String.from>  ← #7 __yo_main_module_init
SUMMARY: AddressSanitizer: 907 byte(s) leaked in 36 allocation(s).  (local run)
```

The test named is whichever test the batch attributes the exit-time report to (the first,
under `--bail`); the leak is in the batch's MODULE INIT, not in any test body. FV was green on
a27cd5f01 (run 40247079350) and red from af67fdf59 on: the b4-1a/#1617-era src changes put
18 runtime String temps into the compiler closure's module-level initializers (debug-knob
names lent to `debug_knob(...)`, interned token texts), and the module-init emitter — a gap
that predates them, see "Age" below — leaked every one.

Minimal reproducer (`tmp/fixme.yo`, tree binary, `--sanitize address --allocator system`):

```yo
{ String } :: import("std/string");
_len_of :: (fn(s : &String) -> usize)(s.len());
(g_check : usize) = _len_of(`hello world`);   // the lent literal is the leak
(g_text : String) = String.from("stored");    // the moved result is NOT a leak
```

ASan at exit: `Direct leak of 32 byte(s) … hello world` + its 11-byte buffer
(43 bytes in 2 allocations), and the emitted `__yo_main_module_init` has no decr:

```c
static void __yo_main_module_init(void) {
  __yo_t_...String _t1 = String.from_str("hello world");
  __yo_effect_escaped = 0;
  size_t _t2 = _len_of(_t1);
  if (__yo_effect_escaped) { return; }
  __yo_v_g_check_... = _t2;
  // missing: if (_t1 != NULL) { __yo_decr_rc(_t1); }
```

The same statement inside `main` emits the decr: the begin-block epilogue (a function body's
scope-end flush) releases it there.

## Root cause

Two halves.

**Evaluation side.** A function body's temps are released by the begin epilogue:
`_schedule_scope_end_drops` (evaluator/exprs/begin.yo) walks the body's frame and the
evaluator attaches the drops to the begin node. The module walk
(`_evaluate_anonymous_module_begin_exprs_inner`) pushes ONE frame for the whole module and
pops it without ever running that scheduler — module-level statement temps get no drops
anywhere. The temps are not even IN the live module frame by the time a statement is recorded:
each statement's RHS evaluation mints them in a nested frame that is popped when it returns;
only the RHS node's ExprInfo env SNAPSHOT still contains them (that is how codegen resolves
their C names).

**Codegen side.** `generate_main_wrapper` (`src/codegen/functions/generation.yo`) re-emits
each recorded initializer as `global = rhs;` inside `__yo_main_module_init` (and the
per-variable `__tl_init_fn` helpers for thread-locals), resets
`pending_deferred_drops` / `consumed_var_pending_drops` to fresh lists, and after the loop
restores the saved lists — no scope-end flush. A call emitter flushes its own argument temps
only on its may-unwind arms (the FV batch's `g_scope_mode_wanted` decrs its `YO_SCOPE_RELEASE`
literal correctly that way); everything else — `token_intern.get_or_insert(String.from(""), .None)`
shapes — waited for a begin epilogue that never comes. Every such temp's RC is held by a C
local that dies at the end of `__yo_main_module_init` without a decrement.

### Age

The gap is older than the red batteries: compiling the failing batch with the v0.2.70 SEED
emits the same 105-call/1-decr `__yo_main_module_init` — the seed leaks the same temps for
this src tree. What turned it red was the src side of #1616/#1617: the compiler's own closure
gained runtime module-level String temps (b4-1a's `debug_knob` cache rework in
`src/utils.yo`, interned token texts) that ride the missing flush.

## Fix

Evaluator (`src/evaluator/values/anonymous_module.yo`,
`_attach_module_init_temp_drops`, called at each of the three module-init record sites):
after a statement is recorded, scan the RHS node's ExprInfo env snapshot for the temps THIS
statement minted (`initialized_at_token` at-or-after the statement's own token — an earlier
statement's temps sit before it, so each temp rides exactly one init expr), apply
`_schedule_scope_end_drops`' eligibility gates verbatim (owning, RC-bearing, not
`is_module_level` — the global moves into the C static and is never dropped — not a borrow,
not consumed — the initializer's moved-out result — not an undroppable SomeT), build the
`___drop(name)` expressions and attach them to the INIT node's `deferred_drop_expressions`.
The gates are inlined, not imported, because begin.yo → context.yo → anonymous_module.yo is a
cycle (the same reason begin.yo keeps a second inline copy for its params pass). For the
collection side, `_schedule_scope_end_drops`' gate chain is factored into
`_scope_end_drop_eligible` (begin.yo) so the two copies state their shared authority.

Codegen (`src/codegen/functions/generation.yo`): `ModuleLevelVarEntry` now carries the full
init statement, and both init emitters (`__yo_main_module_init` and the thread-local
`__tl_init_fn` helper) flush the init node's drops right after the assignment —
`generate_deferred_drop_expressions`, the ordinary gated flush (emitted-once,
undeclared-temp, closure-capture guards) used by `generate_match_expression` and async
fusion "as after the call". A compile-time-only temp that never gains a C declaration is
skipped by the undeclared-temp gate.

## Verification

- `tmp/fixme.yo` under ASan (`--sanitize address --allocator system`): 43 bytes / 2
  allocations before → 0 leaked, rc 0, and `main` still reads both globals (`17 stored`
  printed — no over-release of the value that moved into the C static). The emitted
  `__yo_main_module_init` gains exactly `if (_t1 != NULL) { __yo_decr_rc(_t1); }` after the
  `g_check` assignment and nothing after `g_text`'s.
- `yo test ./tests/internal/verifier.test.yo --bail -v` (tree binary, leak verdicts ARMED,
  the FV job's exact step minus `YO_TEST_Z3`): `1 failed` (the leak, both runs) before,
  all green after.
- `check ./src`, `check ./std`, `tests/internal/compile.test.yo`, `fetch`, `context_index`,
  `cache`, `context` internal tests and the full cli-diff battery pass with the fixed tree
  binary.
- The FV job's batch IS the regression test (it compiles the compiler closure, whose 18
  leaking initializers are exactly this shape); the repro above documents the minimal form.
