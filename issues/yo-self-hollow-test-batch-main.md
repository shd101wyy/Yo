# yo-self drops the whole test-batch `main` body — "N passed" can be vacuous

**Status:** OPEN, pre-existing on HEAD (`a5457bad1`), measured 2026-07-26.
**Severity:** invalidates part of the #69 green count. 8 of the 19 gate-battery
files pass without executing a single assertion.

## Proof

Append one deliberately failing test to a copy of `tests/basic.test.yo`:

```rust
test("DELIBERATE FAILURE probe", {
  assert(false, "this assert MUST fail");
});
```

| compiler | result                     |
| -------- | -------------------------- |
| TS       | 33 passed, **1 failed** ✅ |
| yo-self  | **34 passed** ❌           |

yo-self does not run the assertion at all.

**Control — the probe is not measuring a broken harness.** The identical probe
appended to `tests/rc.test.yo`, whose batch `main` is NOT hollow, gives yo-self
**15 passed, 1 failed** — the harness detects the failure correctly there. So a
hollow `main` is exactly what separates a real pass from a vacuous one.

## Mechanism

The test harness generates one batch file per test file whose `main` is a
dispatch on `YO_TEST_INDEX`:

```rust
main :: (fn() -> unit)({
  io :: __yo_builtin_io;
  match(__yo_batch_env.env.get(`YO_TEST_INDEX`),
    .Some(__yo_test_idx) => cond(
      (__yo_test_idx == `0`) => { … test 0 … },
      …),
    .None => ());
});
```

For the affected files yo-self emits exactly this:

```c
void __yo_user_main() {
  // Failed to transpile match(((__yo_batch_env.env).get)(("YO_TEST_INDEX"…
}
```

`grep -c YO_TEST_INDEX` on the emitted batch C returns **1** — the comment. The
binary has 128 correctly-emitted functions and no caller for any of them, so
every index runs an empty `main`, exits 0, and the harness scores a pass.

The marker comes from `codegen/exprs/generation.yo:417`, the
`context.base.get_expr_info(expr)` → `.None` arm. Two things are ruled out:

- **Not a swallowed evaluator error.** An instrumented build printing `err` in
  `_evaluate_expression_wrapper`'s handler (`_expr.yo:1017`) reports ZERO
  throws for `imm_vec` once the `is_runtime_only` port is applied, and the main
  body is still hollow. (Before that port there were 5 throws — see
  `issues/yo-self-stub-inventory.md` — but removing them did not change the
  marker count.)
- **Not the expression being skipped by the wrapper.** Instrumenting the
  wrapper to fire on the exact id codegen looks up (`__DBG_NOINFO id=66070`)
  never triggers — neither as the input id nor as the result id. So the node
  codegen walks was never seen by that evaluation path at all, which points at
  an expr-id divergence: the evaluator recorded info against a different
  (cloned) AST node than the one codegen emits from.

## Scope — 19-file gate battery, HEAD binary (`/tmp/drop_s1`)

`main_hollow=1` means the `// Failed to transpile` marker appears inside
`__yo_user_main`. (Do NOT use a "lines in main" count as the signal — codegen
emits a `switch`'s closing brace unindented, so a naive brace-matched range
stops early and reports 11 lines for perfectly healthy mains.)

| file                        | reported | markers | main_hollow |
| --------------------------- | -------- | ------- | ----------- |
| `comptime`                  | 28       | 1       | **yes**     |
| `prelude`                   | 4        | 2       | **yes**     |
| `async_await`               | 116      | 1       | **yes**     |
| `basic`                     | 33       | 4       | **yes**     |
| `closure`                   | 9        | 1       | **yes**     |
| `imm_list`                  | 16       | 1       | **yes**     |
| `module_struct_unification` | 10       | 1       | **yes**     |
| `fn`                        | 24       | 1       | **yes**     |
| `arc`                       | 15       | 0       | no          |
| `sys/bufio`                 | 22       | 0       | no          |
| `fs/file`                   | 13       | 0       | no          |
| `fs/temp`                   | 7        | 0       | no          |
| `fs/walker`                 | 6        | 0       | no          |
| `sys/signal`                | 1        | 0       | no          |
| `cycle_collector`           | 16       | 0       | no          |
| `imm_string`                | 28       | 0       | no          |
| `ref_struct`                | 3        | 0       | no          |
| `iso`                       | 3        | 0       | no          |
| `rc`                        | 15       | 0       | no          |

**240 of the battery's 356 reported assertions never execute.** The other 11
files emit a real `main` that reads the index and dispatches, so this is
file-dependent, not a blanket harness failure — which is what makes it
diagnosable, and what the `rc` control above confirms.

Identical counts on three binaries — HEAD (`/tmp/drop_s1`), HEAD + the
`type_to_string` visited guard (`/tmp/tts_s1`), and HEAD + guard +
`is_runtime_only` (`/tmp/isro_s1`) — so it is pre-existing and none of today's
changes caused or fixed it.

## Why the existing gates missed it

- GATE 1 checks the battery's PASS COUNTS, and a vacuous pass counts.
- GATE 2 (corpus diff-test) compares emitted C against TS and is clean at
  PASS 140 / DIFF 0 — but its corpus is standalone `compile` inputs, never
  generated test batches, so it never exercises this path.
- The stage2/stage3 hollow-marker gate counts markers in the SELF-COMPILE, not
  in per-test batches.

**New gate needed:** count `Failed to transpile` in
`<dir>/.yo_selftest_batch_1.bin.c` (kept with `YO_KEEP_BATCH=1`) for every test
file, and treat a hollow `__yo_user_main` as a FAILURE regardless of rc.
Harness: `/tmp/hollow_sweep.sh` (this session).

## Consequence for the #69 count

The headline "165/183" counts hollow passes as green. The real number is
unknown until the same sweep is run over all 183 files; on the 19-file battery
the hollow rate is 8/19. Re-baseline before quoting progress.

## MECHANISM FOUND (2026-07-26) — full chain, with an 11-line reproducer

`issues/repros/closure-arg-abandons-enclosing-begin.yo`:

```rust
main :: (fn() -> unit)({
  xs := List(i32).new().prepend(i32(1)).prepend(i32(2));
  doubled := xs.map((x) => (x * i32(2)));      // <- emitted as a comment
  assert(doubled(usize(0)) == i32(4), "…");    // <- and so is everything after
  ()
});
```

1. `xs.map(<closure>)` is evaluated. The forall `U` of
   `map : fn(self, f : Impl(Fn(T) -> U)) -> List(U)` is never bound from the
   closure's actual return type.
2. `map`'s body is trial-evaluated at definition time. With `U` unbound,
   `List(U)` at `std/imm/list.yo:141` short-circuits through CTFE to a fresh
   named unknown, so `(result : List(U)) = List(U).new()` throws
   **`Incompatible types: Expected ctfe_result_yo_id_5179, Given unit`**.
3. That throw is swallowed by `_trial_eval_fn_body`'s `inner_exn`
   (`evaluator/calls/function_type.yo:222`). Its `unwind(())` exits the helper
   — and with it the ENCLOSING begin loop. The statement being evaluated and
   every statement after it never get an ExprInfo. (This is why the begin loop
   prints its statement id and then never prints a loop-end for it: measured.)
4. `codegen/exprs/generation.yo:417` finds no ExprInfo and emits
   `// Failed to transpile <stmt>`.

That also explains the earlier dead end: the wrapper probe never fired on the
missing ids because the node is not skipped and not re-cloned — the loop that
would have evaluated it was abandoned mid-flight.

The bisect that found it: splitting `tests/imm_list.test.yo` into single-test
files, the first one that goes hollow is test 6, `List map` — the first test
that passes a CLOSURE.

### Not the fix

Porting TS's `synthesizeTypes` on the closure return (closure-type.ts:186-196)
into `closure_type.yo` — a genuinely missing port, already flagged in the stub
inventory — was implemented and measured: **no effect on this repro**, because
instrumentation shows `try_to_implement_closure_by_fn_module_type` is never
called for a closure passed as a CALL ARGUMENT. That path is
`values/anonymous_function.yo` (the `=>` lambda path). The binding has to be
fixed there, which makes this the same root as the cluster-B `closure -> void*`
reds — and those have a history of hollow regressions, so gate any attempt on
marker counts, not test flips.

### Measured on the `=>` lambda path (2026-07-26) — two more dead ends, recorded

Instrumenting `helper.yo`'s Step-6 synthesize shows exactly what the caller
sees for `xs.map((x) => (x * i32(2)))`:

```
param=f  expected=Impl : (Fn(i32) -> U : (Send))
         given   =fn(a : i32) -> U : (Send)          <- should be -> i32
```

So the closure's OWN type keeps the expected return `U`; Step 6 then binds `U`
to itself and nothing is learned. Two fixes were implemented and measured, and
NEITHER clears the repro:

1. **Stamp the SomeType return from the body type** — the faithful port of
   TS anonymous-function.ts:963-988 (`functionType.return.type
.resolvedConcreteType = <body type>`), using yo-self's shared
   `resolved_concrete` cell plus the id-keyed registry. Instrumentation
   confirms it FIRES for our case (`ret=U : (Send) body=i32`), and the markers
   do not change — so the stamp lands on a SomeT that `map`'s body evaluation
   does not consult. Next probe: print the SomeT id at the stamp and at the
   `List(U)` CTFE short-circuit and compare; a mismatch means the resolved
   param type is a substituted COPY with a fresh id, which would make the
   id-keyed registry the wrong channel here.

2. **Stop coercing the body to the forall var** — `anonymous_function.yo:1243`
   clears `expected_type` when the return is an unresolved SomeT, but only for
   `mark_closure_for_codegen` (io.async) closures; widening that to every
   closure makes the body type concrete (`i32`) instead of `U`, which is what
   makes fix 1 fire at all. Still not sufficient on its own.

3. **Narrow the unknown-arg CTFE gate to non-type returns.** This one is a
   genuine faithfulness finding: `comptime_fn.yo:565-585` short-circuits a CTFE
   call whose arg values contain an `UnknownVal`, and **TS has no such gate at
   all** — `evaluateComptimeFunctionCall` short-circuits only for
   `isAnalyzingCtfeCapability` (comptime-fn.ts:58-70) and otherwise executes the
   body. Exempting type constructors (`is_type_hierarchy_type(return_type)`)
   makes `List(U)` fold to the real generic instantiation instead of a
   `ctfe_result_…` placeholder.

   **Repro: markers 2 → 0.** The statement is no longer dropped; the emitted C
   contains the real `map` call. But it does NOT hold up on the battery:

   | file       | HEAD         | narrowed gate                      |
   | ---------- | ------------ | ---------------------------------- |
   | `imm_list` | rc=0, hollow | **rc=139 (SIGSEGV)**, still hollow |
   | other 18   | unchanged    | unchanged (8 hollow both ways)     |

   So it converts one silent drop into a crash and clears none of the eight
   hollow batteries — the batch `main`'s hollow statement fails for a reason
   the repro does not capture. NOT landed. (It also leaves the emitted call
   mangled `yo_id_…__unknown__Type__…` and the C full of `void` fields/params,
   i.e. it lands squarely in the cluster-2 comptime-param-model territory.)

All three are kept OUT of the tree pending a fix that clears the repro AND the
battery — the area has a history of hollow regressions, so nothing lands there
on plausibility alone.

### Two independent hardening items this exposes

- `_trial_eval_fn_body` abandoning the caller's begin loop is a much bigger
  blast radius than "def-time trial eval failed". TS's def-time body eval
  (function-type.ts:499) does not take the caller's statement list with it.
- A per-test hollow gate is mandatory: see "New gate needed" above.


## RE-MEASURED 2026-07-27 (post-validation-batch, s1i + a bracketed diag)

Three probes bracketing the def-time path (`__TR P1..P5` in
`try_to_implement_function_by_function_type`) plus begin-loop enter/end
counters, on `issues/repros/closure-arg-abandons-enclosing-begin.yo`:

- The map def-time trial throws (`__DBGT Incompatible types: Expected
  ctfe_result_… Given unit`) and `_trial_eval_fn_body` CONTAINS it — the
  emitted C is correct (`if (__yo_effect_escaped) { …; __yo_effect_escaped=0;
  return; }`), and P1..P5 all print: **the def-time path completes
  normally** (flow_out empty, no re-raise).
- The abandonment happens ABOVE: after try_to_implement returns, the
  enclosing evaluation chain for `xs.map(closure)` dies silently — main's
  4-statement begin loop never re-enters (i=1 has no loop-end, i=2 never
  entered), NO error passes the statement wrapper (`__DBGW` = 0 prints for
  the whole compile), and the module driver simply moves on to the next
  module ("check: parsing ./std/prelude.yo").
- So the killer is a SILENT `__yo_effect_escaped` set (no printing handler
  is ever invoked) somewhere between try_to_implement's return and the call
  evaluation completing, cascading up every `if (__yo_effect_escaped)
  return` site until the top-level driver's local containment. This matches
  the flag-leak class already documented at `_expr.yo` ("HashMap ops
  (ExprInfo table get/set) can leak the escaped flag through GC").
- **Earlier step-3 wording is corrected**: the trial swallow's unwind does
  NOT itself abandon the caller's begin loop; the abandonment is a separate
  stale-flag cascade fired later in the same statement's evaluation.

Next probe: an lldb watchpoint on `__yo_effect_escaped` (or a temporary
`__yo_set_escaped()` wrapper function in the emitted C to get a stack) run
on the repro, filtered to hits after the last `__TR P5` — that names the
silent setter directly. The 4 dead ends above still stand.

Also note for diag builders: there is a FOURTH silent swallow the 3-site
recipe misses — `_comptime_expect_error_arg_threw`'s `local_exn`
(`evaluator/builtins/comptime_expect_error.yo`), which eats REAL errors
during a `comptime_expect_error` argument eval with no diagnostic.


### REFINED 2026-07-27 — the abandonment is NOT an escape-flag cascade either

Full-coverage C instrumentation on the diag binary (all 18 `__yo_effect_escaped
= 1;` setter sites printing `__ESC <func>`, all 16,993 of 16,996
`if (__yo_effect_escaped)` checks printing `__PROP <func>` when taken):

- The four setter handlers in play: the two diag print-handlers (`__DBGT`
  trial, `__DBGA` anon-trial), `try_match_generic_impl`'s synthesis-failure
  swallow in impl.yo (~1150 benign firings/compile), and a silent
  function.yo handler (6 firings).
- In the fatal window (main's body begin, stmt i=1 `doubled := xs.map(...)`),
  the last events are: map's def-time trial throw (contained, P1..P5
  complete), a SECOND successful def-time trial (out=1, P1..P5 complete) —
  then the log jumps STRAIGHT to the codegen phase's prelude re-parse.
  **Zero `__PROP`, zero `__ESC`, zero begin-loop end prints** between the last
  P5 and the phase change.
- `evaluate_begin_expression`'s statement loop has NO `continue`/`break`/
  direct `return(...)` that could skip the loop-end probe.

So the statement evaluation chain (map-call machinery → main's body begin
loop → main's def-time trial → module eval end) exits by some path that is
neither the escape flag nor a source-level early return. Candidate vectors to
probe next, in order:

1. Instrument `evaluate_begin_expression`'s C exits directly (every `return`
   in its compiled body) — is the loop fn even exiting, or is its FRAME
   corrupted (stack smash) so the `while` condition ends?
2. Probes are eprintln calls — verify the emitted call sites for the loop
   probes have no conditional gating (pre-clear + check pattern) that could
   suppress output under a stale flag.
3. lldb: `watchpoint set variable loop_i` equivalents / breakpoint on the
   codegen-phase entry with `bt` to see what the stack looked like when the
   check phase ended.

The 2026-07-26 step-3 attribution ("the trial swallow's unwind abandons the
begin loop") is definitively WRONG — measured twice over: the trial contains
correctly and the loop dies later, silently.


### THIRD ROUND 2026-07-27 — the begin frame never exits at all

All 185 compiled `return` statements of `evaluate_begin_expression`'s C body
were instrumented (`__BEXIT L<line>`), same emitted-C sed technique:

- The map def-time trial's TWO begins (the synthetic `wrap_body_in_begin`
  wrapper + the body's own) both exit via the SAME escape-check return
  (L186153) when the trial throw unwinds — correct containment, again.
- A later successful trial's begin exits via the normal tail (L188906).
- **Main's body begin (the one that loses statements i>=2) exits through NO
  return at all** — no `__BEXIT`, no loop-end print, no postloop print, and
  no escape-flag activity — yet the process continues into the codegen-phase
  prelude pass and completes rc=0.

A C frame that never returns while execution continues afterwards means the
frame was terminated non-locally or its loop state was corrupted. Combined
with the intermittent rc=139s in the same neighborhood, MEMORY CORRUPTION
(stack smash / UAF during the map-call chain) is now the leading hypothesis —
NOT a semantic swallow. Next recipe: run
`/tmp/diag_s1c compile issues/repros/closure-arg-abandons-enclosing-begin.yo`
under Guard Malloc (`DYLD_INSERT_LIBRARIES=/usr/lib/libgmalloc.dylib`, see
scratchpad/guardmalloc_corpus.sh and the ExprInfo-table-UAF lldb recipe in
agent memory `yo-self-macro-dispatch-corruption-fixed`), which converts the
corrupting write into a deterministic crash with a stack.

Caveat recorded: `__BEXIT` uses raw fprintf while the other probes are yo
eprintln — if eprintln buffers, CROSS-channel ordering is unreliable; only
the absence/presence of events is load-bearing in this round.

Guard Malloc over the FULL repro compile is infeasible: rc=137 (killed)
mid-way through std/string evaluation — page-per-allocation over the
evaluator's millions of allocations exhausts memory. Narrow it next time:
lldb with a hardware watchpoint on the dying begin's `loop_i`/`done` stack
slots (break on entry to `evaluate_begin_expression` when
`env->module_path` matches the repro, finish-to the fatal iteration, then
watch), or a gmalloc run that starts the protection late.
