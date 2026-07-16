# yo-self `test` command: 3 remaining bugs after the runner port (tasks #69/#70)

Status: runner LANDED and working (see commit); these three block full-suite parity.
Date: 2026-07-16 late

## UPDATE (2026-07-16 night): Bugs 1 and 2 FIXED; new frontier found

**Bug 1 FIXED** — two halves, both faithful ports of TS's single-path
default handling (checkIfFunctionParameterMatchesArgument runs for omitted
defaults too; helper.ts:323-344 merges into the shared post-processing):

1. `helper.yo` `try_to_call_function_with_arguments` Step 7: the omitted
   branch now routes the cloned default expr through
   `check_if_function_parameter_matches_argument` (evaluated in the CALLEE
   env, caller env not written back, move-ownership off) instead of a
   hand-rolled bind that skipped forall synthesis.
2. `function.yo` FuncVal arm (the second call path): omitted-default SPLICE —
   after the supplied-arg loop, clone + evaluate each omitted trailing
   param's default expr (same expected-type policy as supplied args), splice
   the results into `evaled_arg_infos`/`runtime_arg_exprs` at the
   regular/evidence boundary, bump `n_supplied_reg`. Defaults now flow into
   forall inference, param binding, the emitted C args, and specialization.

Regression test: `tests/codegen-bootstrap/default_arg_generic_specialization.yo`
(pre-fix s1 rc=134 with 6 undeclared-fn errors; TS + fixed s1 run identically).
`s1 test tests/short_circuit_str_literal_arg.test.yo` → 1/1 passed.

**Bug 2 root-caused & FIXED** — not a malformed switch: the batch's
non-test line `comptime_expect_error((escaped_handler : ctl(msg:String)…) =
(msg -> …unwind…))` evaluates its arg under propagate mode; the EXPECTED
error unwinds out of `evaluate_anonymous_function_implementation` PAST the
param-frame restore, leaving the handler's `msg` frame PUSHED on the module
env. Every later `->` handler in the file then resolved its own params into
the stale frame → "cannot capture outer runtime variables: msg" → whole-body
FTT → clang "expected expression". (TS is immune: persistent envs +
spread-copied contexts — a throw can't strand state.) Fix:
`comptime_expect_error.yo` snapshots/restores env frame depth + all EvalContext
mode fields around the arg eval. Diagnosed with the [TTERR] swallow
instrumentation (function_type.yo:218 + anonymous_function.yo:282 + std/fmt
imports; REVERTED after use).

Regression test: `tests/codegen-bootstrap/comptime_expect_error_env_restore.yo`
(pre-fix s1 rc=134 "expected expression"; TS + fixed s1 run identically).

Gates after both fixes: corpus PASS 129 / DIFF 2 (both pre-existing:
constructor_result_drop flaky-139, ptr_deref_copy_rc_struct print diff),
`check ./std` 153/153, fixpoint re-verify (in progress at write time).

**NEW frontier (same file): effect-polymorphism forall inference.** With
bugs 1+2 fixed, `s1 test tests/algebraic_effects.test.yo` still fails: batch
cond-arms 19/20 ("Test effect polymorphism with using spread(/and unwind)").
`run :: fn(forall(T : Type, E : Type.Struct), f : (fn(e : E) -> T), e : E) -> T`
called as `run(might_fail, raise)` fails to infer T/E from the FUNCTION-typed
arg: arm 19 → `result := run(...)` types UNIT → `assert(result == i32(42), …)`
specializes with `void flag` + `if ()` (clang error); arm 20 → `run`'s
specialization keyed on unresolved return SomeT (`…_ret_1972`) is called but
never emitted (undeclared function). Pre-fix these arms were SILENTLY FTT'd
wholesale (rc=0 no-op binary), so this is exposed, not regressed. Bisection
method: `scratchpad/make_subset.py` extracts cond-arm subsets from the saved
batch (`batch_ae_full.yo`); probe = `grep -c 'void flag'` on the emitted C.

**Bug 3 (exit-after-spawn cleanup abort) — unchanged, still open.**

## UPDATE 2 (2026-07-16 late night): effect-polymorphism frontier FIXED too

`_funcval_bind_foralls` (function.yo) gained a STRUCTURAL fallback (commit
702de11c9): after the name-match misses, synthesize every declared param type
against its arg type into a lazily-built scratch env (best-effort, mismatches
swallowed) and bind composite-embedded foralls (`f : (fn(e : E) -> T)`) from
it when concrete. Order: name-match → structural → receiver-type-args →
captures. Mirrors TS synthesizeTypes running per-param in
checkIfFunctionParameterMatchesArgument (helper.ts:623-637).

**Result: `s1 test tests/algebraic_effects.test.yo` → 72/72 PASSED.**
Regression: tests/codegen-bootstrap/effect_polymorphism_forall_infer.yo
(pre-fix rc=134). Gates: corpus 130/2-known, std 153/153, fixpoint
byte-identical.

Remaining for #69/#70: the full `test ./tests` sweep scoping + Bug 3.

The `test` command is now implemented in yo-self (main.yo run_test — port of
src/test-runner.ts's BATCHED strategy: parse + split test()/non-test content,
synthesize one program whose main dispatches on YO_TEST_INDEX over inlined
bodies, compile once via run_compile, spawn per test with parent setenv —
the spawn runtime passes environ through when envp is NULL). Verified: a
3-test mini file reports `✓ ✓ ✗`, correct Test Summary, pass-only run exits 0.

## Bug 1 — std/assert one-arg failure path: unemitted generic specialization

`assert(flag)` (single-arg) compiles to
`yo_id_5002_unit_rtparam0_bool_ret_unit` whose else-branch calls
`yo_id_5001_T____ToString__rtparam0_1920_ret_unit((void*)("Assertion failed."))`
— a specialization of the generic `println(forall(T <: ToString), v)` keyed by
a BARE unresolved SomeT id (`rtparam0_1920`) that is never
instantiated/emitted → clang "call to undeclared function". Hit by ANY test
file using bare `assert(x)` → blocks most of tests/ and yo-self/tests/.
Repro: `s1 test tests/short_circuit_str_literal_arg.test.yo` (1 clang error).
Class: specialization-at-unresolved-SomeT (the def-time str-literal arg does
not bind T) — cf. memory yo-self-specialization-sig-typeargs.

## Bug 2 — malformed switch emission in the algebraic_effects batch

`s1 test tests/algebraic_effects.test.yo` → additional clang error:
`/tmp/.yo_selftest_batch_1.bin.c:2397: expected expression` — a
`switch ((*(slot)).tag) {` region emitted with a syntax hole (effects/unwind
constructs inlined into the batched main's cond arms). Needs the emitted-C
inspection of that region.

## Bug 3 — exit()-after-spawn aborts in cleanup (fail-case rc=134, want 1)

After the runner has spawned/awaited child processes, `exit(1)` (even from
the top-level throw handler, whose exit works pre-spawn — the old stub exited
rc=1 cleanly) aborts: atexit `__yo_process_cleanup` → `__yo_cleanup_thread_gc`
→ malloc "POINTER BEING FREED WAS NOT ALLOCATED". A tracked-object-list
corruption exposed at teardown, present in the TS-COMPILED binary too (s1) —
i.e. an RC imbalance in yo-self/std source on the spawn/await path, only
surfacing at cleanup. Effect: failing suites exit 134 instead of 1 (still
nonzero); passing suites exit 0 correctly. ALSO NOTE: `run_check`'s failure
exit appears broken separately (bad file → rc=0 — the throw/exit path is
never reached; unrelated pre-existing issue worth checking).

## Next steps

1. Bug 1 first (unblocks most files): find why the `assert` default-message
   println specialization keys on the unresolved SomeT; likely fix at
   specialization-signature/type-binding time (helper.yo) or emit the
   fallback instantiation. Differential: TS compiles the same synthesized
   batch fine.
2. Then bug 2 (algebraic effects batch), then bug 3 (cleanup corruption —
   use the RC-quarantine/patch_rcsite tooling from the leak hunts).
3. Full #69/#70 sweeps after: `s2 test ./tests --parallel 8` vs TS, then
   `s2 test ./yo-self/tests` (eval trio known-heavy).
