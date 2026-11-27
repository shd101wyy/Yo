# A user binding named in the `__yo_` namespace hijacks a builtin or is hijacked by one

**Severity:** S2 — a safe file can define `__yo_errno :: (fn() -> i64)(i64(7))` and every call to it silently runs the compiler's `errno` read instead, with no diagnostic; the same holds for parameters and locals named like a dispatched builtin.

**Status:** fixed 2026-11-27 (VERDICTS-72 rule (b), `wip/v0281-reserved-binders`).

Found 2026-11-21 by the VERDICTS-72 probes (`p2`, `p14`, `p11`, `p9`), on the v0.2.78 seed and on develop. VERDICTS-72 rule (a) (E0407, v0.2.80) closed the FFI-member form of this
(`issues/fixed/2026-11-21-a-user-extern-member-named-like-a-compiler-builtin-is-silently-shadowed.md`);
every other binder is closed by rule (b), below.

## Reproducer

```yo
{ println } :: import("std/fmt");
__yo_errno :: (fn() -> i64)(i64(7));
main :: (fn() -> unit)({
  a := __yo_errno();
  println(&a);
});
export(main);
```

`yo check` accepts it and the program prints `0`, not `7`: codegen matches `__yo_errno` by name and emits `errno`.

| Probe | Program (no pragma) | Result |
| --- | --- | --- |
| p2 | `__yo_incr_rc :: (fn(x : i32) -> i32)(x + i32(1));` then `y := __yo_incr_rc(i32(1))` | accepted; `y` is the builtin's `unit`, prints `()` |
| p14 | `__yo_errno :: (fn() -> i64)(i64(7));` then `__yo_errno()` | accepted, prints `0` |
| p11 | a parameter `__yo_incr_rc : (fn(x : i32) -> i32)`, called | the builtin runs; E0604 on the closure |
| p9 | `__yo_incr_rc := i32(3)`, `(__yo_decr_rc : i32) = i32(4)`, a closure parameter `__yo_rc_own` | accepted |

## Root cause

The evaluator dispatches `__yo_*` builtins by the callee's spelling (`src/evaluator/exprs/dispatch.yo`) before it looks at any binding, and codegen matches others by name (`__yo_errno`), so a user binding of such a name never runs. No binder site rejects the prefix: `is_reserved_builtin_binding_name` (`src/token.yo`) lists only `__yo_cell` and `__yo_atomic_cell` of the namespace.

## Fix: VERDICTS-72 rule (b)

`reject_reserved_yo_binder` (`src/evaluator/memory-safety.yo`) raises E0407, the code rule (a) registered, for every binder a person wrote whose name starts with `__yo_`, outside the std tree (`may_bind_yo_namespace_name`). It runs at the binder sites: the `::`/`:=`/typed-binding paths (`binding.yo`, `initialization-assignment.yo`), the destructuring and import-rename choke point (`_reject_shadowing`), the parameter parser (`evaluate_function_parameter`, which closure parameters and fn-trait parameters go through) and the four pattern-binding sites of `compile_pattern`. Uses stay legal.

The written-versus-minted fact is `TokenData.written`: the lexer sets it on the identifiers it makes from source text, and every token the parser or evaluator mints (`__yo_tpl_N`, `__yo_self`, `__yo_pat_s`, `__yo_contract_result`) leaves it false, so no list of names is involved. The field is declared right after `kind`, where it fills the padding after the 4-byte enum, so `TokenData` stays the size it was.

The sweep that landed with it: the destructuring imports of `__yo_*` names from `std/sys/externs` and `std/sys/future` outside std (`tests/async/sm-ownership.test.yo`, `tests/async/sm-protocol.test.yo`, `tests/cli-cases/raw-extern-future-sync-await-releases`, `scripts/bench/io-bench.yo`, `scripts/bench/io-budget.yo`) switch to a module value (`externs.__yo_async_send_start(…)` is a use, not a binding); `tests/parallelism-soundness.test.yo` drops a redundant import; and the test runner's batch program (`src/main.yo`) and `tests/codegen-bootstrap/iter-structs-identical-layout.yo` name their binders `_yo_batch_env` and `_yo_test_idx`. The batch is the one place the written-versus-minted fact would be lost: `yo test` prints each test's AST back to text, which the batch's lexer reads as written, `__yo_tpl_N` included, so the runner collects the `__yo_` names of unwritten atoms in the printed ASTs (`collect_minted_yo_names`) and ends the batch with `// yo-batch-minted: a b c `, which `reject_reserved_yo_binder` consults for a batch file.

## Test

`tests/reserved-yo-namespace.test.yo` (p2, p14, p11, a closure parameter, a local `:=`, a typed binding, a pattern binding, an `(x := p)` name, an import rename and a destructuring binder rejected with E0407; the canaries a template string, a `self` method, an `ensures` contract and a struct-pattern `match` accepted), and the cli-case `check-reserved-yo-namespace-binder`.
