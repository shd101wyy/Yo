# A fused await reads the caller's match binding of the wrapper's name

**Severity:** S1: a miscompile. Inside a `match` arm, an awaited `io.async` wrapper reads the caller's arm binding wherever it names a parameter or local of the same name, so it computes with the wrong value without a diagnostic. When the wrapper's parameter is by value, the binding is freed twice and the argument leaks. In the compiler itself this made every `yo build test` hang at exit.

Found 2026-11-07 on develop's battery after #1813 (run 42275347135).

## Symptom

`Self-hosted test subcommand (yo-self tier-1 gates)`, GATE 7:

```text
PASS 450  GOLDEN-DIFF 3  NO-GOLDEN 0  FRAMING 0  SKIP 1  (total 454)
GOLDEN-DIFF build-test-exclude  (rc=124; rc(golden=0,run=124))
GOLDEN-DIFF build-test-suite-flags  (rc=124; rc(golden=1,run=124))
GOLDEN-DIFF init-build-test  (rc=124; rc(golden=0,run=124) stdout)
```

These look like per-case timeouts, but no case was slow. Each one's kept stdout matches its golden up to the summary (`init-build-test` only lacks the later `$ yo fmt --check` line), so the test run finished and the process never exited. A local run of the `build-test-exclude` fixture with the job's own `yo-stage1` printed `1 total`, then held one core until `timeout` killed it. `yo test tests/ok.test.yo` (18 s) and `yo build` (5 s) on the same fixture exit cleanly.

`perf record -e cpu-clock -t <tid>` on the hung process put 99% of the samples in three instructions at `mi_theap_collect_ex+0x1b0`, mimalloc's unbounded walk to the tail of a page's `local_free` list when a thread's heap is collected at exit. The list had a cycle, which is what a double free leaves. The same C rebuilt on glibc malloc (`-I scripts/bootstrap/libc_mimalloc`) and run under `gdb` died at once, right after the summary:

```text
Thread 2 "yo-stage2-libc" received signal SIGSEGV, Segmentation fault.
#0  free ()
#1  yo_id_4683339436075136311001184 ()              (drop of ArrayList(String))
#2  _file____home_temp_50763160691959179771_resume  (execute_node's state machine)
```

## Reproducer

`tests/async/fusion.test.yo`, the five `arm binding` tests. The smallest:

```yo
_leaf :: (fn(n : i32, io : Io) -> Impl(Future(i32)))(io.async((e : Io) => n));
_checked :: (fn(n : i32, io : Io) -> Impl(Future(i32, IoExn)))({
  k := (n + i32(1));
  io.async(e => {
    r := e.io.await(_leaf(k, e.io), e.io);
    r
  })
});
_caller :: (fn(io : Io) -> Impl(Future(i32, IoExn)))(
  io.async(
    e => match(
      Option(i32).Some(i32(50)),
      .Some(n) => {
        v := e.io.await(_checked(i32(4), e.io), e);
        v + n
      },
      .None => i32(0)
    )
  )
);
```

The caller's value is 55. The fused prologue read the arm's `n`, 50, and the result was 101. With `YO_ASYNC_FUSION=0` it is 55.

## Root cause

A fused await (`emit_fused_await`, `plans/reference/ASYNC_AWAIT_SITE_FUSION.md`) emits the wrapper's parameters, prologue, capture construction and block into the caller's resume function, in the middle of whatever the caller is emitting. For the wrapper's names it swaps `state_machine_variables`, `state_machine_field_aliases` and `variable_id_remapping`. It did not swap the state of the caller's match arms: `local_shadowed_variables`, `shadow_bindings`, `shadow_slots` and `place_bindings`.

That state is keyed by name, and it is deliberately consulted first: a shadowed name renders as the binding whichever variable the atom names (`_generate_sm_atom`, `_shadowed_name_code`), because a single-expression arm body records an env without the arm's frame. So inside an open arm, every atom of the wrapper spelled like an arm binding rendered as that binding, including the implicit capture in the wrapper's capture literal.

`execute_node` reached it in the `.Test` arm:

```yo ignore
.Some(suite) => {
  result := e.io.await(run_test_suite(suite.clone(), ctx, e.io, e.exn), e);
```

The emitted C (run 42275347135's `yo-stage2.c`) binds the clone to the wrapper's parameter, then ignores it:

```c
__yo_t_6913304902869015243 __yo_v_suite = _file____home_temp_139421108347298087080;  // suite.clone()
__yo_t_16832148677914526400 __yo_cap_run_test_suite_r8c4_n1 =
  (__yo_t_16832148677914526400){.__yo_v_suite = sm->var_suite_15222856383561155679 /*yo_mv:m200*/, .__yo_v_ctx = __yo_v_ctx};
```

The clone leaks. The capture holds a bitwise copy of the arm's binding, the site's end drops the capture, and the arm's scope-end drop releases the same `name`, `root`, `target` and `exclude` again.

#1813 exposed it by making `run_test_suite` take `sink(suite)`. Before that the parameter was `suite : &BuildTestSuite`, the argument was `&suite`, and the misread binding was the very value the argument pointed at, so nothing observed it. The other sink wrappers of `execute_node` are clear of it: `run_verify_step`'s parameter is `cfg` and the arm binds `vcfg`, and `compile_artifact` and `run_executable` are not fused. Language tests, the corpus and the fixpoint never reach `run_test_suite`'s await, which is why every local and pre-merge gate stayed green. Only the three CLI cases that run a test suite through `yo build` do.

The bug is in the seed too (v0.2.75 emitted the same C for stage 1), so a codegen fix alone does not reach CI's stage 1. A stage 1's code is what the seed emits.

## Fix

`emit_fused_await` leaves the caller's arms around both parts it emits in the wrapper's scope (`_leave_caller_arms`, `_reenter_caller_arms`, `src/codegen/exprs/async.yo`). The arguments and the await's effect bundle are the caller's, so they stay inside the arms.

The caller's two escape-drop lists (`pending_deferred_drops`, `consumed_var_pending_drops`) are the one thing in that scope that does name the caller's bindings: an escape path inside the site emits them. With the arms set aside, a binding's drop would render as the wrapper's same-named C local, or as a stack slot that did not survive the suspension. `_drops_outside_arms` removes those drops for the site. The binding lives in a slot across the await, and the state machine's dispose (or `_locals`, for a caught unwind) releases it, as it does for the caller's other locals.

`src/build_runner.yo` also renames the arm's binding to `test_suite`. That is the seed's half, parked in `plans/backlog/SEED_VERSION_AUTOMATION.md`.

## Verification

- `tests/async/fusion.test.yo`: the five new tests fail with the pre-fix stage 1 (four wrong values or wrong thrown messages, one ASan `attempting double-free`) and pass after it. The twelve existing tests pass on both, and the file is 16/16 under the fixed stage 1.
- Language tests (fixed stage 1): `async_await` 293, `async/sm_ownership` 54, `algebraic_effects` 83, `match_nested` 29, `move_only` 94, `borrowed_match_binding_place` 12 — all rc 0.
- `tests/internal/build_runner.test.yo`: 18/18 rc 0 (fixed stage 1, `--compile-timeout-ms 1800000`).
- The three red CLI cases pass under the fixed stage 1 through `scripts/cli-diff-test.sh` (with the three fusion CLI goldens: 6/6, 113 s) — the hang is gone. The seed still fails the five new tests, which is by construction: every CI step that runs this file runs a tree-built compiler.
- `yo check ./src` and `yo check ./std` (seed, `--std-path ./std`): rc 0. `yo fmt --check` (fixed stage 1) and `scripts/check-issue-refs.sh`: pass.
- Emit-diff of the compiler's own C (the develop tip's `src/main.yo`, emitted by a develop-tip stage 1 and by this fix's stage 1): only the `run_test_suite` site, one other arm-enclosed fused site (whose escape-path drop of its arm binding is now left to the dispose, which releases it under its move flag), and `/*yo_mv:*/` marker renumbering.
- A sixth test written with the fix (a fused block that THROWS with the caller's arm binding live) still double-frees the wrapper's by-value argument on the unwind. That is a distinct escape-path defect, filed open as `issues/2026-11-07-a-fused-block-that-throws-drops-its-by-value-capture-twice.md`; its reproducer is out of the suite until that fix lands.
