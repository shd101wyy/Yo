# 96-byte `ArrayList(WhereConstraintEntry)` leak in `macro_helpers` (pre-existing)

> **FIXED 2026-08-06.** See "RESOLUTION" at the end of this file. The analysis below is
> the historical record; two of its framing assumptions (that the consumption was recorded
> by the evaluator, and that `mergeAndCheckEnvs` should have rejected the program) turned
> out to be wrong — there was never a consumption for the merge to see.

> **Handing this off? Start with `plans/CI_GATING_HANDOFF.md` §2.** It has the same analysis
> condensed, plus the gates, the measured baselines, and the single question to start from.
> This file is the long-form record.

**Found 2026-08-06** by a local leak sweep of `tests/internal`, not by CI — CI's
`compiler-internal-tests` job had never got this far, because it `--bail`ed on two earlier
leaks (both since fixed).

**Pre-existing, NOT a regression.** Verified by stashing every `src/` change from this
session back to `8fb6aa0c6` and re-running: the same 96 bytes leak in the same two tests.

## Symptom

`tests/internal/macro_helpers.test.yo`, tests at `YO_TEST_INDEX` 0 and 1 (index 2
is clean): **1 leak / 96 bytes** each.

Reproduce locally on macOS — no Linux needed:

```bash
./yo-cli test ./tests/internal/macro_helpers.test.yo --parallel 1 --keep-generated-files
BIN=$(ls tests/internal/.yo_test_batch_* | grep -vE '\.(c|yo)$' | head -1)
YO_TEST_INDEX=0 MallocStackLogging=1 leaks --atExit -- "$BIN"
```

## Stack (innermost first)

```
__yo_new___yo_struct_yo51ba7706_id_2420                                   <- the 96 bytes
ArrayList(WhereConstraintEntry).new()  [fn_yo51ba7706_id_103_new_specialized_T_WhereConstraintEntry…]
get_func_where_constraints                                                 [yoae7de946]
try_to_implement_function_by_function_type                                 [yo09829747]
evaluate_function_call → _evaluate_expression → evaluate_initialization_assignment
  → _evaluate_expression → evaluate_anonymous_module_begin_exprs → __yo_user_main
```

## What is known

`yo-self/evaluator/types/function.yo:543`:

```rust
get_func_where_constraints :: (fn(func_id : String) -> ArrayList(WhereConstraintEntry))(
  match(
    g_func_where_constraints.get(func_id.clone()),
    .Some(entries) => entries,                      // the map's list
    .None => ArrayList(WhereConstraintEntry).new()  // a FRESH list  <- the leaked one
  )
);
```

The two arms differ in provenance, which is worth noting but is not by itself the bug.

Caller (`yo-self/evaluator/calls/function_type.yo:880-892`) binds the result to a local
`def_where_entries`, passes it to `_build_def_time_body_env` (`:276`, a borrowing param),
and at `:978` stores it into a struct field (`where_entries : def_where_entries`) — so
ownership is _shared_ between a local that should get a scope-end drop and a struct that
should dup.

## ROOT CAUSE — CONFIRMED from the emitted C

**A local that is later MOVED into an aggregate is excluded from the early-return drop sets
of every exit that happens BEFORE the move.** The consumption marking is path-insensitive.

In the emitted batch C (`try_to_implement_function_by_function_type`):

```c
// 272815 — the owned list, rc = 1
__yo_struct_…_2420* _temp_338096 = fn_…_get_func_where_constraints(…);
if (__yo_effect_escaped) {
  …
  // Drop consumed variables (unwind propagation)
  fn_…_2438___drop((__yo_struct_…_2420*)(_temp_338096));   // 272842 — this one IS covered
  return …;
}
_temp_338106 = _temp_338096;          // match-result temp
…
__yo_struct_…_2420* def_where_entries = _temp_338106;      // 272855 — the binding

//   …14 `if (__yo_effect_escaped) { …drops…; return; }` blocks in between,
//      NONE of which drops def_where_entries…

__yo_struct_…_9* _temp_338241 = __yo_new___yo_struct_…_9(…, def_where_entries, …);  // 273421 — MOVED, no dup
fn_…_id_27___drop((__yo_struct_…_9*)(_temp_338241));                                // 273423 — struct dropped
```

Measured in that C:

| fact                                                                             | value            |
| -------------------------------------------------------------------------------- | ---------------- |
| uses of `def_where_entries`                                                      | 4                |
| `___drop` of `def_where_entries` anywhere                                        | **0**            |
| `if (__yo_effect_escaped) { … return; }` blocks between the binding and the move | **14**           |
| the receiving struct `_temp_338241` dropped                                      | yes, at `273423` |

So the **normal** path is correctly balanced — the move transfers ownership and the struct's
drop releases the list. Every one of the 14 **early** exits leaks it, exactly 96 bytes each.
That matches the observation precisely: one leak in the two tests that take an escaping path,
zero in the third.

Note the mechanism already exists and nearly works: the first early-return block does carry a
`// Drop consumed variables (unwind propagation)` entry for the pre-move temp
`_temp_338096`. It is the _binding_ on the later exits that is missed.

`Variable.consumedAtToken` already records WHERE the consumption happens, so the drop
emitter has the data it needs to be position-aware: on an early exit, a consumed variable
whose `consumedAtToken` lies after that exit is still live and must be dropped. Emitters to
change: `generateConsumedVarDropsForEscape` / `generatePendingDeferredDrops` in
`src/codegen/exprs/return.ts` (plus the yo-self mirror `codegen/exprs/return.yo`).

**Care required:** dropping a variable that really was moved on the taken path would be a
double-free, so the position comparison must be conservative — and this is the same family as
`issues/fixed/early-return-reassigned-rc-variable-leak.md`,
`issues/fixed/early-return-missing-local-variable-drops.md` and
`issues/fixed/pending-drop-consumed-var-nested-return.md`, so their regression tests in
`tests/rc.test.yo` are the guard to run.

## MINIMAL REPRODUCER FOUND 2026-08-06 — the missing ingredient was a CONDITIONAL move

Five earlier attempts failed because every one of them moved the local
**unconditionally**. The real move at `yo-self/evaluator/calls/function_type.yo:978` is
inside `if(has_fwd_comptime_fn_cap, { … })`. Reproduces deterministically, on macOS, with
no sanitizer — gated on `rc()`:

```rust
Holder :: struct(items : ArrayList(i32));
g_seen := ArrayList(ArrayList(i32)).new();   // keeps an outside reference

make_fresh :: (fn() -> ArrayList(i32))({    // mirrors get_func_where_constraints
  l := ArrayList(i32).new();
  g_seen.push(l);
  l
});

work :: (fn(flag : bool) -> unit)({          // mirrors try_to_implement_…
  entries := make_fresh();
  if(flag, {
    h := Holder(items : entries);            // CONDITIONAL move
    println(`held ${h.items.len()}`);
  });
});
```

`work(true)` then `work(false)`, then compare refcounts of the two lists `g_seen` still
holds: **`taken_rc=2 skipped_rc=3`**. One reference is retained whenever the branch
containing the move is not taken. A parameter-based variant (`consume_maybe(flag, l)` with
`l` a parameter) does **not** reproduce — parameters are handled; the local-bound-from-a-call
case is not.

### This CORRECTS two claims made earlier in this document

1. "**the normal path is correctly balanced**" — only when the condition is TRUE. When
   `has_fwd_comptime_fn_cap` is false the move never executes and the variable still has no
   scope-end drop, so the **normal** path leaks too. The 14 early exits are not the whole
   story.
2. Consequently a purely **position-based** fix (drop on an exit whose position precedes
   `consumedAtToken`) is **NOT sufficient**: the fall-through past the `if` is positioned
   _after_ the move token, so it would still be treated as consumed.

### TWO fix locations tried and ELIMINATED by measurement (2026-08-06)

Both were built, probed, and reverted. Recorded so nobody spends the time again.

**1. Per-arm drops in the `cond` codegen — IMPOSSIBLE from there.** The idea was: at the
end of each arm, release anything a _different_ arm consumed. Built it in
`src/codegen/exprs/cond.ts` and probed the variable at that point:

```
PROBE arm=0 name=entries consumed=false init=true owning=true rc=true module=false
PROBE arm=1 name=entries consumed=false init=true owning=true rc=true module=false
```

**`consumed=false`** — the `cond` expression's own `$.env` does not record the consumption at
all, so the arm emitter cannot see which value to release. The consumption is visible only in
the arm body's env and in the ENCLOSING block's env after the merge. A codegen-side per-arm
fix is therefore a dead end.

**2. `mergeAndCheckEnvs` "case 1" — NOT the path.** A probe that threw on every
single-case consumption never fired for this shape, because **`if` is a prelude macro**
(`std/prelude.yo:7655`) that expands to

```rust
cond(unquote(condition) => unquote(then), true => unquote(else))   // else defaults to `()`
```

so there are always **two** arms, not one. Which raises the sharpest open question:

> **"case 3" (`some cases consume, some don't`, `src/expr.ts:2177`) is supposed to REJECT
> exactly this program — and it does not fire. Find out why.**

That is the next thing to investigate, because it decides the fix:

- if case 3 can be made to fire, the compiler rejects conditional moves outright (sound with
  no drop flags, and forces the `yo-self` source to clone or restructure);
- if it must keep accepting them, the move has to become a **dup** at the consumption site
  (`setExprAsNeedsToCallDup`, `src/expr.ts:2451`, already exists) so both paths are balanced
  by the ordinary scope-end drop — correct with no runtime flag, at the cost of one extra
  refcount increment on the taken path. This needs the consuming _expression_, not just
  `consumedAtToken`, so `Variable` would gain a `consumedAtExpr`.

### What the fix actually needs

Branch-aware placement, not position comparison: a variable consumed inside one branch must
be released on every path that does not take that branch. The machinery is partly present —
`src/codegen/exprs/cond.ts:259-265` already saves/sets/restores `consumedVarPendingDrops`
per branch and reads `value.$?.consumedVariableDropExpressions` — so the missing piece is
emitting the sibling/fall-through drop, not inventing a new concept. The alternative,
guaranteed-correct-under-any-control-flow option is a **drop flag** (what Rust does):

```c
bool entries_moved = false;
if (flag) { … entries_moved = true; }
if (!entries_moved) drop(entries);
```

`getVariablesNeedingDrop` (`src/env.ts:2279`) returns nothing for a consumed variable, so no
drop expression exists to filter — either approach must _create_ one.

**Care:** dropping on a path where the move DID happen is a double free, which is far worse
than an 80-byte leak on an error path. Gate on `tests/rc.test.yo` plus the real
`macro_helpers` batch (~10 min to rebuild) before believing any fix.

## Hypotheses ruled out along the way

**Ruled out:** the getter pattern alone. A minimal reproduction — a module-level
`HashMap(String, ArrayList(Entry))`, the same two-arm getter, a `.None` lookup bound to a
local — leaks **0 bytes**. So the plain "fresh list returned, bound, dropped at scope end"
path is correctly balanced.

Also ruled out: **binding from a `match` arm.** The real call site binds
`def_where_entries` from a `match` whose arms each yield a fresh RC value, and this repo has
prior art for match-arm drop bugs — but a minimal reproduction of exactly that shape
(module-level table, two-arm getter, `match` over an enum with a fresh list in each arm,
bound to a local) also leaks **0 bytes**.

Also ruled out, each measured at **0 bytes**:

- **explicit `return` before the move** — the pending-deferred-drop machinery covers it;
- **effect/unwind propagation exit before the move** (a throwing call between the binding
  and the move) on its own;
- **both of the above plus a `match`-bound local whose arms construct directly**;
- **the same with one arm's value coming from a function call.**

**NO minimal reproduction yet.** Five shapes were tried and all are correctly balanced. One
attempt did report 48 bytes, but `MallocStackLogging` showed the allocation was in
`__yo_user_main`, not in the function under test — a **different** leak (see below). Worth
recording because it nearly became a fix built on a false repro: always confirm the leaked
allocation's stack matches the bug you are chasing.

So the emitted C of the real batch remains the only evidence. That is enough to state the
mechanism with confidence, but a fix should be gated on the real batch (a ~10 minute
build) until someone finds a small reproduction — a wrong position comparison here produces
double-frees across the whole compiler, which is far worse than a 96-byte leak on an error
path.

## Separate finding: `unwind` skips the enclosing fn's scope-end drops

While attempting a reproduction: a handler whose body is `unwind(())` exits the _enclosing_
`fn` — and the locals of that enclosing fn are not dropped. In the probe, `main` held
`my_exn := Exception(throw : ((_e) -> { unwind(()); }))`, called a function that threw, and
the handler's `unwind` exited `main` leaving 48 bytes unreleased.

Whether that is a bug or intended is a design question — `unwind` deliberately discards the
continuation, and there is prior art that it also skips code following a guarded call
(`unwind` in a swallow handler skipping a restore). But if it is intended, then any program
that ends via `unwind` will report leaks under LeakSanitizer, which is worth knowing before
enabling leak gates more widely.

## CONFIRMED ON LINUX 2026-08-06 (run 31051936217)

Linux LeakSanitizer agrees with macOS `leaks` — the open question in the Impact section
below is now answered. Same allocation stack, **80 bytes** on Linux vs 96 on macOS (RC
header / allocator padding differs):

```
Direct leak of 80 byte(s) in 1 object(s) allocated from:
    #1 __yo_new___yo_struct_yo42b3a917_id_2420
    #2 fn_yo42b3a917_id_103_new_specialized_T_WhereConstraintEntry_…
    #3 fn_yo1e5a6d0e_id_146_get_func_where_constraints
    #4 fn_yo93ac5cf1_id_54_try_to_implement_function_by_function_type
    …
```

Failing tests: `Phase6f: ExprVal Atom equality via __yo_expr_eq` and
`Phase6f: gensym produces fresh atoms`.

**Why this never showed up in CI before:** the TS arm used to die of a node-heap OOM at
`quote_macro_eval` (~file 40 of 58) and never reached `macro_helpers`. Once the OOM was
fixed (one node process per file, commit `c82e4ec8e`) the job reaches every file and this
pre-existing leak surfaced. It is now **the only thing failing** that job — the two parser
SEGVs are fixed.

## Impact

`compiler-internal-tests` runs every test binary under ASan/LeakSanitizer, so if Linux
agrees with macOS here this leak fails 2 tests and keeps that job red — i.e. it blocks
removing `continue-on-error: true`. Whether Linux agrees is the first thing to check
against the next CI run, since allocator behaviour differs and a 96-byte block can be
reachable-by-accident on one platform and not the other.

The rest of the suite is clean: a local sweep of all 58 `tests/internal` files (54 in one
pass, the four heavy the four macro/reflection separately) found leaks in **this file only**. That sweep was
proven non-vacuous by temporarily reintroducing the fixed module-global collision, which it
flagged in all 18 tests of `evaluator_index` at 3 leaks / 576 bytes.

## RESOLUTION (2026-08-06)

### The answer to the sharp question

`mergeAndCheckEnvs` "case 3" does not fire because **there is no consumption at merge
time**. Probing the merge for the reproducer's `entries` showed
`consumedAtTokens=[null,null]` across both arms, and `setExprAsConsumed` never fires for
a named local passed to a struct literal. The evaluator's semantics for that shape is
**copy, not move**: `setExprAsNeedsToCallDup` (`src/expr.ts`) attaches a deferred
`___dup(entries)` to the argument, leaving the variable unconsumed and balanced by its
ordinary scope-end drop.

The "move" seen in the emitted C is manufactured LATER, by the **dup/drop pair
optimizer** (`begin.ts`, `OPTIMIZE_DUP_AND_DROP_PAIRS`): at the enclosing begin-block's
end it cancels a single runtime dup against the scope-end drop and marks the variable
consumed at the dup's use site. That cancellation is sound only if the dup executes
unconditionally.

### The actual bug

The optimizer's dup collector (`searchRecursively`, begin.ts) was branch-aware only for
literal `cond`/`match` AST heads. `if` is a prelude macro: the AST node keeps its `if`
head and the evaluated `cond` expansion is recorded in `$.macroExpansion`. The collector
recursed generically into the macro call's raw args, found the arm's dup with no branch
context, treated it as unconditional, and cancelled the pair — removing the dup AND the
scope-end drop. Every path that did not take the arm then leaked one reference (and the
14 `__yo_effect_escaped` early exits leaked it too, since a "consumed" variable gets no
drops anywhere).

### The fix

`searchRecursively` now walks `$.macroExpansion` INSTEAD of the raw macro-call args
(exactly the shape `exprTreeContainsReturn` in `src/expr-traversal.ts` already used).
The expansion's `cond` head routes arm dups through the existing branch-aware handler:

- dup in SOME fallthrough arms → `varsWithPartialBranchDups` → pair preserved (dup on
  the taken path, scope-end drop on every path — balanced);
- dup in ALL arms → collected per-arm → `runtimeDupCount > 1` → pair preserved;
- single unconditional dup → cancelled, as before.

Mirrored in `yo-self/evaluator/exprs/begin.yo`: `_search_dup_calls` follows
`macro_expansion` the same way, and `_remove_dup_calls_from_tree` also follows it —
required there because yo-self expansions are FRESH-ID clones (TS expansions share the
spliced arg nodes, so TS's raw-tree removal walk already reached them).

The stale port comment claiming "TS never looks inside $.macroExpansion" was rewritten;
the historic stage-2 breakage it warned about was a missed expansion-internal `return`,
owned and fixed by `_contains_return_for_opt`.

### Verification

- `rc()` reproducer (conditional move of a call-bound local): `taken_rc=3 skipped_rc=4`
  before → `taken_rc=3 skipped_rc=3` after.
- New regression test `tests/rc.test.yo` "Conditional move into a struct field balances
  both paths": SIGABRT before the fix, passes after (19/19 in the file).
- `tests/internal/macro_helpers.test.yo`: 3/3, and the emitted-C invariant flipped —
  `___drop` of `def_where_entries`: **0 before → 45 after**, with exactly 1 `___dup` at
  the conditional consumption site; struct's own drop releases it on the taken path.
- macOS `MallocStackLogging=1 leaks --atExit` on the batch binary: tests 0/1/2 all
  report **0 leaks** (were 96 bytes in tests 0 and 1).
- `macro_expansion.test.yo` 2/2 in 168 s / 6.03 GB peak — matches the pre-fix baseline,
  no compile-time regression.

### Follow-up bug found while validating the fix (same day): the early-return dup fast path

The corpus differential caught the first version of the fix crashing the stage-1
self-hosted binary (SIGSEGV in `emit_deferred_async_block_struct_definitions`, both
`io_async_fsm_*` corpus tests). Root cause: exposing macro-expansion arms to the branch
handler also exposed them to its `__isEarlyReturnDup` fast path, which marked return-arm
dups "independent" (not counted toward `runtimeDupCount`) and removed them on
cancellation. For `yo-self`'s `compute_overlapping_slots` — two `if`-arm
`return empty_result` sites whose dups ARE the caller's reference — that produced

```c
___drop(empty_result);      // freed…
___drop(eligible);
return empty_result;        // …then returned dangling
```

The assumption "an early-return dup has its own drop at the return point" is wrong
whenever the dup feeds the arm's RETURN VALUE. Fix: the fast path was removed in both
compilers — return-arms now join the same coverage calculus as fallthrough arms (a
branch-arm dup is exposed to the optimizer only when EVERY arm dups; otherwise the
variable is flagged partial and the pair survives). This also fixes a pre-existing leak:
a single conditional `return x` dup used to cancel against the scope-end drop, leaking
`x` on the fall-through path.

Verified: stage-1 rebuilt, both `io_async_fsm_*` tests compile and run; `tests/rc.test.yo`
20/20 (includes the three prior early-return regression tests).
