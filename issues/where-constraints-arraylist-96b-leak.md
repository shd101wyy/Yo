# 96-byte `ArrayList(WhereConstraintEntry)` leak in `phase6f_macro_helpers` (pre-existing)

**Found 2026-08-06** by a local leak sweep of `tests/internal`, not by CI — CI's
`compiler-internal-tests` job had never got this far, because it `--bail`ed on two earlier
leaks (both since fixed).

**Pre-existing, NOT a regression.** Verified by stashing every `src/` change from this
session back to `8fb6aa0c6` and re-running: the same 96 bytes leak in the same two tests.

## Symptom

`tests/internal/phase6f_macro_helpers.test.yo`, tests at `YO_TEST_INDEX` 0 and 1 (index 2
is clean): **1 leak / 96 bytes** each.

Reproduce locally on macOS — no Linux needed:

```bash
./yo-cli test ./tests/internal/phase6f_macro_helpers.test.yo --parallel 1 --keep-generated-files
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

## Impact

`compiler-internal-tests` runs every test binary under ASan/LeakSanitizer, so if Linux
agrees with macOS here this leak fails 2 tests and keeps that job red — i.e. it blocks
removing `continue-on-error: true`. Whether Linux agrees is the first thing to check
against the next CI run, since allocator behaviour differs and a 96-byte block can be
reachable-by-accident on one platform and not the other.

The rest of the suite is clean: a local sweep of all 58 `tests/internal` files (54 in one
pass, the four heavy `phase6*` separately) found leaks in **this file only**. That sweep was
proven non-vacuous by temporarily reintroducing the fixed module-global collision, which it
flagged in all 18 tests of `evaluator_index` at 3 leaks / 576 bytes.
