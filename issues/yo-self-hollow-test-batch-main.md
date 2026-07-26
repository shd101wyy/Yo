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

## Next step

Find where the evaluator's recorded expr id diverges from the node
`generate_function_body` walks for `main` — instrument the body-evaluation
entry and the codegen body walk to print the root/statement ids for `main` and
compare. The 11 clean files give a working control to diff against.
