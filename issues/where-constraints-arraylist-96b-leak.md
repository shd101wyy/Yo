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

## Hypothesis NOT yet confirmed, and one already ruled out

**Ruled out:** the getter pattern alone. A minimal reproduction — a module-level
`HashMap(String, ArrayList(Entry))`, the same two-arm getter, a `.None` lookup bound to a
local — leaks **0 bytes**. So the plain "fresh list returned, bound, dropped at scope end"
path is correctly balanced.

**Still open:** the leak needs the surrounding evaluator context. Two candidates:

1. **An exit path that skips scope-end drops.** `try_to_implement_function_by_function_type`
   sits under heavy exception/`unwind` use. Yo's `unwind` exits the enclosing `fn`, and
   there is prior art in this repo for `unwind` skipping code that follows a guarded call
   (`unwind` in a swallow handler skipping a restore). If an `unwind` crosses the scope
   holding `def_where_entries`, its drop never runs.
2. **The struct that retains it at `:978` is itself leaked**, taking the list with it. Then
   the 96 bytes is a symptom and the real leak is the containing struct.

Distinguishing them: read the emitted batch C around the `def_where_entries` local — count
its `___drop`/`__yo_decr_rc` sites and check whether every control-flow exit has one, then
follow the struct at `:978`.

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
